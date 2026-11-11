import { randomInt, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PartnerChatLinkDto } from '@nolon/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { canAccessBranch } from '../auth/branch-scope.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sha256 } from '../customer-service/customer-identity-auth.js';

type Tx = Prisma.TransactionClient;

/** Plan 18, 5: a private link lives 7 days. */
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const REFERRER_LINK_TOKEN = /^ag_[A-Za-z0-9]{32}$/;
export const REFERRER_FIRST_SHIPMENT_PAID = 'REFERRER_FIRST_SHIPMENT_PAID';

/** `ag_` + 32 random letters or digits (plan 18, 5). */
export function randomLinkToken(): string {
  let token = 'ag_';
  for (let i = 0; i < 32; i++) token += TOKEN_LETTERS[randomInt(TOKEN_LETTERS.length)];
  return token;
}

/** Why a link failed, as the bot is told (plan 18, 7). */
export type LinkRefusal = 'REFERRER_LINK_UNKNOWN' | 'REFERRER_LINK_USED' | 'REFERRER_LINK_EXPIRED';

/**
 * Plan 18, 5 and 6: a referral broker's chat account. Staff issue his private link (shown once,
 * only its hash kept); the bot binds the account that opens it; staff can revoke the binding. When
 * his customer's first shipment accrues his commission, one notice is queued for that account.
 */
@Injectable()
export class ReferrerChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * A new private link for an active referrer of the user's branches (404 otherwise); the open ones
   * are revoked. The token is returned once, never stored.
   */
  async issueLink(user: AuthUser, partnerId: string): Promise<PartnerChatLinkDto> {
    const token = randomLinkToken();
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      const partner = await this.lockReferrer(tx, user, partnerId);
      const now = new Date();
      await tx.referrerLinkToken.updateMany({
        where: { partnerId, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.referrerLinkToken.create({
        data: { partnerId, tokenHash: sha256(token), expiresAt, createdById: user.id },
      });
      await this.audit.record(tx, user, {
        branchId: partner.branchId,
        entity: 'PARTNER',
        entityId: partnerId,
        reference: `${partner.number} ${partner.name}`,
        action: 'UPDATED',
        changes: [
          { field: 'chatLink', before: null, after: `issued, expires ${expiresAt.toISOString()}` },
        ],
      });
    });
    const base = this.env.CS_REFERRER_BOT_URL;
    return {
      token,
      url: base ? `${base}${base.includes('?') ? '&' : '?'}start=${token}` : null,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Staff end the broker's live chat binding (no notice reaches it after). */
  async revokeBinding(user: AuthUser, partnerId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const partner = await this.lockReferrer(tx, user, partnerId, { inactiveToo: true });
      const live = await tx.partnerChannelBinding.findMany({
        where: { partnerId, revokedAt: null },
        select: { id: true, channel: true },
      });
      if (live.length === 0) throw new ConflictException('The broker has no linked chat');
      await tx.partnerChannelBinding.updateMany({
        where: { id: { in: live.map((b) => b.id) } },
        data: {
          revokedAt: new Date(),
          revokedById: user.id,
          livePartnerChannel: null,
          liveSubject: null,
        },
      });
      await this.audit.record(tx, user, {
        branchId: partner.branchId,
        entity: 'PARTNER',
        entityId: partnerId,
        reference: `${partner.number} ${partner.name}`,
        action: 'UPDATED',
        changes: live.map((b) => ({ field: 'chatBinding', before: b.channel, after: null })),
      });
    });
  }

  /** Whether the partner has a live chat binding, for its page. */
  async linkedAt(partnerId: string): Promise<string | null> {
    const live = await this.prisma.partnerChannelBinding.findFirst({
      where: { partnerId, revokedAt: null },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return live?.createdAt.toISOString() ?? null;
  }

  /**
   * POST /cs/referrers/link (plan 18, 5): the chat account that opened the private link becomes the
   * broker's. The same account opening its own used link again: LINKED. A link unknown or revoked,
   * or for a broker no longer active: UNKNOWN; used by another account, or the account already a
   * different broker's: USED; past its 7 days: EXPIRED. A broker's other account on the channel is
   * replaced. Audited as the key.
   */
  async link(
    apiClientId: string,
    token: string,
    subject: { channel: string; subjectId: string },
  ): Promise<{ firstName: string } | { refusal: LinkRefusal }> {
    if (!REFERRER_LINK_TOKEN.test(token)) return { refusal: 'REFERRER_LINK_UNKNOWN' };
    return this.prisma.$transaction(async (tx) => {
      // One chat account binds once at a time, whatever the token.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-chat:${subject.channel}:${subject.subjectId}`}, 0))`;
      const rows = await tx.$queryRaw<
        {
          id: string;
          partner_id: string;
          expires_at: Date;
          used_at: Date | null;
          used_by_binding_id: string | null;
          revoked_at: Date | null;
        }[]
      >`SELECT "id"::text AS "id", "partner_id"::text AS "partner_id", "expires_at", "used_at",
          "used_by_binding_id"::text AS "used_by_binding_id", "revoked_at"
        FROM "referrer_link_tokens" WHERE "token_hash" = ${sha256(token)} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.revoked_at) return { refusal: 'REFERRER_LINK_UNKNOWN' as const };
      const partners = await tx.$queryRaw<
        { name: string; number: string; branch_id: string }[]
      >`SELECT "name", "number", "branch_id"::text AS "branch_id" FROM "partners"
        WHERE "id" = ${row.partner_id}::uuid AND "kind" = 'REFERRER' AND "is_active" FOR SHARE`;
      const partner = partners[0];
      if (!partner) return { refusal: 'REFERRER_LINK_UNKNOWN' as const };
      const firstName = partner.name.trim().split(/\s+/)[0] ?? partner.name;
      const bound = await tx.partnerChannelBinding.findUnique({
        where: { liveSubject: `${subject.channel}:${subject.subjectId}` },
        select: { id: true, partnerId: true },
      });
      if (row.used_at) {
        return bound && bound.id === row.used_by_binding_id
          ? { firstName }
          : { refusal: 'REFERRER_LINK_USED' as const };
      }
      if (row.expires_at.getTime() < Date.now())
        return { refusal: 'REFERRER_LINK_EXPIRED' as const };
      if (bound && bound.partnerId !== row.partner_id) {
        return { refusal: 'REFERRER_LINK_USED' as const };
      }
      let bindingId = bound?.id ?? null;
      const changes: { field: string; before: string | null; after: string | null }[] = [];
      if (!bindingId) {
        // The broker's other account on this channel, if any, is replaced.
        const replaced = await tx.partnerChannelBinding.updateMany({
          where: { partnerId: row.partner_id, channel: subject.channel, revokedAt: null },
          data: { revokedAt: new Date(), livePartnerChannel: null, liveSubject: null },
        });
        bindingId = (
          await tx.partnerChannelBinding.create({
            data: {
              partnerId: row.partner_id,
              apiClientId,
              channel: subject.channel,
              subjectId: subject.subjectId,
              livePartnerChannel: `${row.partner_id}:${subject.channel}`,
              liveSubject: `${subject.channel}:${subject.subjectId}`,
            },
            select: { id: true },
          })
        ).id;
        changes.push({
          field: 'chatBinding',
          before: replaced.count > 0 ? subject.channel : null,
          after: subject.channel,
        });
      }
      await tx.referrerLinkToken.update({
        where: { id: row.id },
        data: { usedAt: new Date(), usedByBindingId: bindingId },
      });
      changes.push({ field: 'chatLink', before: 'issued', after: 'used' });
      await this.audit.recordApi(tx, {
        branchId: partner.branch_id,
        entity: 'PARTNER',
        entityId: row.partner_id,
        reference: `${partner.number} ${partner.name}`,
        action: 'UPDATED',
        changes: [...changes, { field: 'apiClient', before: null, after: apiClientId }],
      });
      return { firstName };
    });
  }

  /**
   * Plan 18, 6: called by the commission sync for each new positive REFERRER accrual. On the
   * shipment that holds its customer's first, for the broker of that first, with a live chat
   * binding and the switch on: one notice, at most once per (shipment, broker) (ON CONFLICT DO
   * NOTHING, so a later re-accrual sends nothing).
   */
  async accruedInTx(
    tx: Tx,
    input: { shipmentId: string; partnerId: string; currency: string; amount: Prisma.Decimal },
  ): Promise<void> {
    if (!this.env.CS_REFERRER_NOTICES_ENABLED || !input.amount.gt(0)) return;
    const referral = await tx.shipmentReferral.findUnique({
      where: { shipmentId: input.shipmentId },
      select: {
        referrerId: true,
        referrerReason: true,
        firstForCustomer: { select: { name: true } },
        shipment: { select: { number: true } },
      },
    });
    if (
      !referral?.firstForCustomer ||
      referral.referrerReason !== 'FIRST_SHIPMENT' ||
      referral.referrerId !== input.partnerId
    )
      return;
    const binding = await tx.partnerChannelBinding.findFirst({
      where: { partnerId: input.partnerId, revokedAt: null, channel: 'TELEGRAM' },
      select: { apiClientId: true, channel: true, subjectId: true },
    });
    if (!binding) return;
    const currency = await tx.currency.findUniqueOrThrow({
      where: { code: input.currency },
      select: { nameAr: true, decimalPlaces: true },
    });
    const id = randomUUID();
    const now = new Date();
    const payload = {
      eventId: id,
      type: REFERRER_FIRST_SHIPMENT_PAID,
      occurredAt: now.toISOString(),
      referrer: { channel: binding.channel.toLowerCase(), externalId: binding.subjectId },
      customerFirstName: referral.firstForCustomer.name.trim().split(/\s+/)[0] ?? '',
      commission: {
        amount: input.amount.toFixed(currency.decimalPlaces),
        currency: input.currency,
        currencyNameAr: currency.nameAr,
        decimalPlaces: currency.decimalPlaces,
      },
      shipmentRef: referral.shipment.number,
    };
    await tx.$executeRaw`
      INSERT INTO "cs_partner_notices" ("id", "api_client_id", "partner_id", "shipment_id", "type",
        "payload", "occurred_at", "next_attempt_at")
      VALUES (${id}::uuid, ${binding.apiClientId}::uuid, ${input.partnerId}::uuid,
        ${input.shipmentId}::uuid, ${REFERRER_FIRST_SHIPMENT_PAID}, ${JSON.stringify(payload)}::jsonb,
        ${now}, ${now})
      ON CONFLICT ("type", "shipment_id", "partner_id") DO NOTHING`;
  }

  /** The referrer locked for a staff write: of the user's branches (404), active unless asked. */
  private async lockReferrer(
    tx: Tx,
    user: AuthUser,
    partnerId: string,
    options: { inactiveToo?: boolean } = {},
  ) {
    const rows = await tx.$queryRaw<
      { kind: string; branch_id: string; is_active: boolean; number: string; name: string }[]
    >`SELECT "kind"::text AS "kind", "branch_id"::text AS "branch_id", "is_active", "number", "name"
      FROM "partners" WHERE "id" = ${partnerId}::uuid FOR UPDATE`;
    const p = rows[0];
    if (!p || !canAccessBranch(user, p.branch_id)) throw new NotFoundException('Partner not found');
    if (!user.access.has('partners:update', p.branch_id))
      throw new NotFoundException('Partner not found');
    if (p.kind !== 'REFERRER') {
      throw new BadRequestException({
        code: 'NOT_A_REFERRER',
        message: 'Only a referrer links a chat account',
        fields: ['kind'],
      });
    }
    if (!p.is_active && !options.inactiveToo) {
      throw new ConflictException('An inactive broker gets no new link');
    }
    return { branchId: p.branch_id, number: p.number, name: p.name };
  }
}
