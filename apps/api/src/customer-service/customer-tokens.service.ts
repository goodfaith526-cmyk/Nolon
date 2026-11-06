import { createHash, randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  CS_TOKEN_PREFIX,
  CS_TOKEN_TTL_MS,
  type CsAccessLevel,
  type CsCustomerChoiceDto,
  type CsCustomerTokenAnswer,
  type CsCustomerTokenRequest,
} from '@nolon/shared';
import { FailureLimiter, type LimitRule } from '../common/failure-limiter.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { CsGrantKind } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ApiClientAuth } from './api-client.guard.js';
import { hashApiKey } from './api-key.js';
import { identityError } from './customer-identity-auth.js';
import type { IdentityContext } from './customer-identity.contract.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Per key and phone: 10 numbers that match nothing in 15 minutes. */
export const TOKEN_PHONE_RULE: LimitRule = {
  maxFailures: 10,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

/** Per key: 100 numbers that match nothing in 15 minutes (a key trying many numbers). */
export const TOKEN_KEY_RULE: LimitRule = {
  maxFailures: 100,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

/** How many accounts a `choose` answer lists, at most. */
const CHOICES = 5;

/** Tokens come only from numbers a channel verified: WhatsApp's sender, or (plan 14-1) a Telegram own contact. */
export const TOKEN_CHANNEL = 'whatsapp';
export type TokenChannel = 'whatsapp' | 'telegram';

/** A phone in one form, +<digits> (plan 14 F206-5): `249…` and `+249…` are the same number. */
export function canonPhone(raw: string): string {
  return `+${raw.replace(/\D/g, '')}`;
}

/** Plan 14-1: what a WhatsApp token remembers of its sender, to find the requests it made. */
export function whatsappSenderHash(phone: string): string {
  return sha256(`whatsapp:${canonPhone(phone)}`);
}

const TOKEN_PATTERN = new RegExp(`^${CS_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The token in an `Authorization: Bearer nolct_...` header, or null. */
export function readCustomerToken(header: string | undefined): string | null {
  const match = header ? /^Bearer (\S+)$/.exec(header.trim()) : null;
  const token = match?.[1];
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

export interface Grant {
  kind: CsGrantKind;
  contactId: string | null;
}

interface MatchedCustomer {
  id: string;
  number: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  /** Plan 09e (F191-1): a phone someone else typed grants nothing until staff confirm it. */
  phoneUnverified: boolean;
  whatsapp: string | null;
  updatedAt: Date;
  contacts: { id: string; phone: string; updatedAt: Date }[];
}

/**
 * The reason a phone matches a customer, most direct first: the customer's own phone, then its
 * WhatsApp, then the first authorized person (may inquire) with that phone.
 */
export function bestGrant(c: MatchedCustomer, phone: string): Grant | null {
  if (c.phone === phone && !c.phoneUnverified) return { kind: 'CUSTOMER_PHONE', contactId: null };
  if (c.whatsapp === phone) return { kind: 'CUSTOMER_WHATSAPP', contactId: null };
  const contact = c.contacts.find((k) => k.phone === phone);
  return contact ? { kind: 'CONTACT_PHONE', contactId: contact.id } : null;
}

/**
 * The grant's version: the latest change of the records the match rests on (the customer, and
 * the contact for a contact's phone). Any change to them (number, WhatsApp, may-inquire, active,
 * email...) moves it, so a token or a reply built on an older version is refused.
 */
export function grantVersion(customerUpdatedAt: Date, contactUpdatedAt: Date | null): number {
  return Math.max(customerUpdatedAt.getTime(), contactUpdatedAt?.getTime() ?? 0);
}

/** A stable, opaque id for the reason of a match. */
export function grantId(customerId: string, grant: Grant): string {
  return `g${sha256(`${customerId}|${grant.kind}|${grant.contactId ?? ''}`).slice(0, 40)}`;
}

function label(c: { name: string; companyName: string | null }): string {
  return (c.companyName ?? c.name).slice(0, 200);
}

/**
 * Customer tokens (N1): the bot's key, which never reads customers itself, asks for a token for
 * the one customer a verified phone matches in the key's branches. The token is the only way to
 * that customer's data (N2). Every request is in cs_access_events (N4).
 */
@Injectable()
export class CustomerTokensService {
  private readonly phoneLimiter = new FailureLimiter(TOKEN_PHONE_RULE);
  private readonly keyLimiter = new FailureLimiter(TOKEN_KEY_RULE);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** Plan 14-1: Telegram tokens are off until the switch is on (503, nothing issued). */
  requireTelegram(): void {
    if (!this.env.CS_TELEGRAM_TOKENS_ENABLED) identityError(503, 'TELEGRAM_TOKENS_UNAVAILABLE');
  }

  /**
   * Plan 14-1: a token from a Telegram sender's own shared contact. The assertion (already
   * verified) must be Telegram's, and the evidence the sender's own contact with this phone;
   * anything else is 401 INVALID_CHANNEL_ASSERTION. From there it is WhatsApp's match.
   */
  async issueTelegram(
    client: ApiClientAuth,
    input: CsCustomerTokenRequest,
    context: IdentityContext,
  ): Promise<CsCustomerTokenAnswer> {
    this.requireTelegram();
    const evidence = input.phoneEvidence;
    if (
      context.channel !== 'TELEGRAM' ||
      !evidence ||
      evidence.kind !== 'TELEGRAM_OWN_CONTACT' ||
      evidence.contactUserId !== context.subjectId ||
      canonPhone(evidence.value) !== canonPhone(input.phone)
    ) {
      identityError(401, 'INVALID_CHANNEL_ASSERTION');
    }
    return this.issue(
      client,
      {
        phone: canonPhone(input.phone),
        ...(input.customerNumber ? { customerNumber: input.customerNumber } : {}),
      },
      'telegram',
    );
  }

  async issue(
    client: ApiClientAuth,
    input: CsCustomerTokenRequest,
    channel: TokenChannel = TOKEN_CHANNEL,
  ): Promise<CsCustomerTokenAnswer> {
    const log = (tokenId: string | null, customerId: string | null, outcome: string) =>
      this.record(client.id, tokenId, customerId, outcome, undefined, channel);
    const phoneKey = `${client.id}:${sha256(input.phone)}`;
    if (this.phoneLimiter.isBlocked(phoneKey) || this.keyLimiter.isBlocked(client.id)) {
      await log(null, null, 'LIMITED');
      throw new HttpException(
        { message: 'Too many attempts, try again later', code: 'TOO_MANY', statusCode: 429 },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const found = await this.matching(client, input.phone);
    const matches = input.customerNumber
      ? found.filter((c) => c.number === input.customerNumber)
      : found;
    const [only, ...others] = matches;
    if (!only) {
      this.phoneLimiter.recordFailure(phoneKey);
      this.keyLimiter.recordFailure(client.id);
      await log(null, null, 'NONE');
      return { kind: 'none' };
    }
    if (others.length > 0) {
      await log(null, null, 'CHOOSE');
      return { kind: 'choose', customers: matches.slice(0, CHOICES).map(choice) };
    }
    const grant = bestGrant(only, input.phone);
    if (!grant) throw new Error('A matched customer has no grant');
    const contact = only.contacts.find((k) => k.id === grant.contactId) ?? null;
    const version = grantVersion(only.updatedAt, contact?.updatedAt ?? null);
    // No proof of an email code exists yet (N3): every token is L1.
    const level: CsAccessLevel = 'L1';
    const token = `${CS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + CS_TOKEN_TTL_MS);
    const row = await this.prisma.csCustomerToken.create({
      data: {
        tokenHash: hashApiKey(token),
        apiClientId: client.id,
        customerId: only.id,
        grantKind: grant.kind,
        contactId: grant.contactId,
        phoneHash: sha256(input.phone),
        grantVersion: BigInt(version),
        level,
        expiresAt,
        channel,
        senderHash: channel === 'whatsapp' ? whatsappSenderHash(input.phone) : null,
      },
    });
    this.phoneLimiter.reset(phoneKey);
    await log(row.id, only.id, 'TOKEN');
    return {
      kind: 'token',
      token,
      expiresAt: expiresAt.toISOString(),
      customer: choice(only),
      grantId: grantId(only.id, grant),
      grantVersion: version,
      level,
    };
  }

  /**
   * One row of the access log (N4). The channel is the token's (plan 14-1) when a token is named,
   * else the one given (the channel a token request came from), else WhatsApp.
   */
  async record(
    apiClientId: string,
    tokenId: string | null,
    customerId: string | null,
    outcome: string,
    route = 'POST /cs/customer-tokens',
    channel?: TokenChannel,
  ): Promise<void> {
    const tokenChannel =
      channel ??
      (tokenId
        ? (
            await this.prisma.csCustomerToken.findUnique({
              where: { id: tokenId },
              select: { channel: true },
            })
          )?.channel
        : undefined);
    await this.prisma.csAccessEvent.create({
      data: {
        apiClientId,
        tokenId,
        customerId,
        channel: tokenChannel ?? TOKEN_CHANNEL,
        route,
        outcome,
      },
    });
  }

  /**
   * Active customers whose phone or WhatsApp is `phone`, or with an active authorized person (may
   * inquire) with that phone. Customers are central (plan 09f): any branch of the key finds them. Read from the tables: nothing of them is
   * returned but the number and the label.
   */
  private async matching(client: ApiClientAuth, phone: string): Promise<MatchedCustomer[]> {
    if (client.allowedBranchIds.length === 0) return [];
    const contactMatch = { phone, canInquire: true, isActive: true };
    return this.prisma.customer.findMany({
      where: {
        isActive: true,
        // Plan 09e (F191-1): a phone someone else typed (phoneUnverified) grants nothing until
        // staff confirm it; the WhatsApp number and authorized persons are staff-entered.
        OR: [
          { phone, phoneUnverified: false },
          { whatsapp: phone },
          { contacts: { some: contactMatch } },
        ],
      },
      select: {
        id: true,
        number: true,
        name: true,
        companyName: true,
        phone: true,
        phoneUnverified: true,
        whatsapp: true,
        updatedAt: true,
        contacts: {
          where: contactMatch,
          select: { id: true, phone: true, updatedAt: true },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { number: 'asc' },
      take: 50,
    });
  }
}

function choice(c: {
  number: string;
  name: string;
  companyName: string | null;
}): CsCustomerChoiceDto {
  return { number: c.number, label: label(c) };
}
