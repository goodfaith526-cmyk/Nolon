import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  CS_DAILY_REQUESTS,
  CS_REQUEST_TTL_DAYS,
  type CsBookingRequestCreate,
  type CsBookingRequestCreated,
  type CsBookingRequestDto,
  type CsBookingRequestState,
  type CsSenderChannel,
} from '@nolon/shared';
import { todayIn, toDbDate } from '../common/dates.js';
import { dec } from '../common/money.js';
import { nextSequenceValue } from '../common/numbering.js';
import type { CsBookingRequest } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BookingRequestCaller } from './booking-request.guard.js';
import { CustomerTokensService } from './customer-tokens.service.js';

const DAY_MS = 86_400_000;

/** BR-000001: the request's number for staff and the customer. */
export function requestReference(value: bigint): string {
  return `BR-${value.toString().padStart(6, '0')}`;
}

/** The owner of a request: the customer and the reason of its match, or a channel identity. */
export function ownerRef(caller: BookingRequestCaller, sender?: CsBookingRequestCreate['sender']) {
  return caller.kind === 'customer'
    ? `c:${caller.token.customerId}:${caller.token.grantId}`
    : `s:${sender?.channel ?? ''}:${sender?.id ?? ''}`;
}

/** A value with its object keys sorted, so equal content always serializes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * SHA-256 of a request's content: the body without its idempotency key, keys sorted, services
 * sorted, the quantity as a number (2 and 2.0 are the same request).
 */
export function contentHash(input: CsBookingRequestCreate): string {
  const normal: Partial<CsBookingRequestCreate> = {
    ...input,
    idempotencyKey: undefined,
    quantity: dec(input.quantity).toFixed(),
    services: [...input.services].sort(),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(normal)))
    .digest('hex');
}

/** What the owner sees of a request's state: one undecided past its time is expired. */
export function stateOf(r: Pick<CsBookingRequest, 'status' | 'expiresAt'>, now = new Date()) {
  const undecided = r.status === 'PENDING' || r.status === 'AWAITING_ROUTING';
  if (undecided && r.expiresAt.getTime() <= now.getTime()) return 'expired';
  return r.status.toLowerCase() as CsBookingRequestState;
}

function coded(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ message, code, statusCode: status }, status);
}

/**
 * Booking requests from customer-service clients (R3, docs/plans/04 sections 6 and 7.1-7.2): a
 * draft for staff, never a booking. The branch comes from the routing rules of the origin only,
 * capped by the key's branches; a request is made once per idempotency key, and an owner makes at
 * most CS_DAILY_REQUESTS new ones a day. Only its owner, through the same key, reads it back.
 */
@Injectable()
export class BookingRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataService,
    private readonly tokens: CustomerTokensService,
  ) {}

  async create(
    caller: BookingRequestCaller,
    input: CsBookingRequestCreate,
  ): Promise<{ created: boolean; body: CsBookingRequestCreated }> {
    if (caller.kind === 'customer' && input.sender) {
      throw coded(HttpStatus.BAD_REQUEST, 'SENDER_WITH_TOKEN', 'A customer token names the owner');
    }
    if (caller.kind === 'key' && !input.sender) {
      throw coded(
        HttpStatus.BAD_REQUEST,
        'SENDER_REQUIRED',
        'Without a customer token, name the sender',
      );
    }
    const client = caller.client;
    const owner = ownerRef(caller, input.sender);
    const hash = contentHash(input);
    const replay = await this.replay(client.id, owner, input.idempotencyKey, hash);
    if (replay) return { created: false, body: replay };

    await this.masterData.requireRoute(input.originId, input.destinationId);
    const category = await this.masterData.requirePriceCategory(input.category, null);
    if (input.requestedDate !== undefined && input.requestedDate < todayIn('UTC')) {
      throw coded(HttpStatus.BAD_REQUEST, 'BAD_DATE', 'requestedDate must be today (UTC) or later');
    }
    if (input.quoteRef !== undefined) await this.checkQuote(client.id, input);

    // Section 6: the branch from the origin's rules only, never from the customer's words. The key's
    // branches are the ceiling: one branch outside them, or no candidate inside them, is refused.
    const candidates = await this.masterData.routingCandidates(input.originId);
    const allowed = candidates.filter((id) => client.allowedBranchIds.includes(id));
    if (allowed.length === 0) {
      throw coded(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'ORIGIN_NOT_SERVED',
        'No branch of this key serves the origin: hand over to staff',
      );
    }
    const branchId = candidates.length === 1 ? (allowed[0] ?? null) : null;

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // One owner's requests one at a time: the retry check and the daily count see every row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 0))`;
      const again = await tx.csBookingRequest.findUnique({
        where: {
          apiClientId_ownerRef_idempotencyKey: {
            apiClientId: client.id,
            ownerRef: owner,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (again) return { created: false, row: again };
      const dayStart = toDbDate(todayIn('UTC', now));
      const today = await tx.csBookingRequest.count({
        where: { ownerRef: owner, createdAt: { gte: dayStart } },
      });
      if (today >= CS_DAILY_REQUESTS) {
        throw coded(
          HttpStatus.TOO_MANY_REQUESTS,
          'DAILY_LIMIT',
          `At most ${CS_DAILY_REQUESTS} new requests a day`,
        );
      }
      const number = await nextSequenceValue(tx, 'CS_BOOKING_REQUEST');
      const row = await tx.csBookingRequest.create({
        data: {
          reference: requestReference(number),
          apiClientId: client.id,
          ownerRef: owner,
          ...(caller.kind === 'customer'
            ? { customerId: caller.token.customerId, grantId: caller.token.grantId }
            : { senderChannel: input.sender?.channel, senderId: input.sender?.id }),
          contactPhone: input.contactPhone ?? null,
          idempotencyKey: input.idempotencyKey,
          contentHash: hash,
          status: branchId === null ? 'AWAITING_ROUTING' : 'PENDING',
          branchId,
          allowedBranchIds: allowed,
          originLocationId: input.originId,
          destinationLocationId: input.destinationId,
          priceCategoryCode: category.code,
          quantity: dec(input.quantity),
          services: input.services,
          senderName: input.senderName,
          consigneeName: input.consigneeName,
          consigneePhone: input.consigneePhone,
          handover: input.handover,
          requestedDate: input.requestedDate ? toDbDate(input.requestedDate) : null,
          quoteRef: input.quoteRef ?? null,
          language: input.language,
          expiresAt: new Date(now.getTime() + CS_REQUEST_TTL_DAYS * DAY_MS),
        },
      });
      return { created: true, row };
    });
    if (!result.created && result.row.contentHash !== hash) throw conflict();
    if (caller.kind === 'customer') {
      await this.tokens.record(
        client.id,
        caller.token.tokenId,
        caller.token.customerId,
        result.created ? 'CREATED' : 'REPLAYED',
        'POST /cs/booking-requests',
      );
    }
    return { created: result.created, body: createdBody(result.row) };
  }

  /**
   * A request read by its owner through the key that made it (section 7.2): another key, another
   * owner, or a request whose branches the key no longer serves is 404, as one that does not exist.
   */
  async read(
    caller: BookingRequestCaller,
    id: string,
    sender: { channel: CsSenderChannel; id: string } | null,
  ): Promise<CsBookingRequestDto> {
    const owner =
      caller.kind === 'customer' ? ownerRef(caller) : sender && ownerRef(caller, sender);
    const row =
      owner === null
        ? null
        : await this.prisma.csBookingRequest.findFirst({
            where: { id, apiClientId: caller.client.id, ownerRef: owner },
          });
    const served =
      row !== null &&
      (row.branchId === null
        ? row.allowedBranchIds.some((b) => caller.client.allowedBranchIds.includes(b))
        : caller.client.allowedBranchIds.includes(row.branchId));
    if (caller.kind === 'customer') {
      await this.tokens.record(
        caller.client.id,
        caller.token.tokenId,
        caller.token.customerId,
        served ? 'OK' : 'NOT_FOUND',
        'GET /cs/booking-requests/:id',
      );
    }
    if (!row || !served) throw new NotFoundException('Booking request not found');
    return {
      requestId: row.id,
      reference: row.reference,
      status: stateOf(row),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      bookingNumber: null,
      customerReason: null,
      paymentInstructions: null,
    };
  }

  /** The request this key and owner already made with this idempotency key, when there is one. */
  private async replay(
    apiClientId: string,
    owner: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<CsBookingRequestCreated | null> {
    const row = await this.prisma.csBookingRequest.findUnique({
      where: {
        apiClientId_ownerRef_idempotencyKey: { apiClientId, ownerRef: owner, idempotencyKey },
      },
    });
    if (!row) return null;
    if (row.contentHash !== hash) throw conflict();
    return createdBody(row);
  }

  /**
   * Section 7.1 (F119-2): a quote of this key, not expired, whose inputs are the request's: route,
   * category and quantity. The services it priced (MAIN_FREIGHT) are always in a request; the
   * others are staff's to price, so they never make a mismatch.
   */
  private async checkQuote(apiClientId: string, input: CsBookingRequestCreate): Promise<void> {
    const quote = await this.prisma.csQuote.findFirst({
      where: { ref: input.quoteRef, apiClientId },
    });
    const same =
      quote !== null &&
      quote.originLocationId === input.originId &&
      quote.destinationLocationId === input.destinationId &&
      quote.priceCategoryCode === input.category &&
      quote.quantity !== null &&
      quote.quantity.eq(dec(input.quantity));
    if (!same) {
      throw coded(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'QUOTE_MISMATCH',
        'The quote is not for this request: ask for a new one',
      );
    }
    if (quote.expiresAt.getTime() <= Date.now()) {
      throw coded(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'QUOTE_EXPIRED',
        'The quote expired: ask for a new one',
      );
    }
  }
}

function conflict(): HttpException {
  return coded(
    HttpStatus.CONFLICT,
    'IDEMPOTENCY_CONFLICT',
    'This idempotency key was used for another request',
  );
}

function createdBody(row: CsBookingRequest): CsBookingRequestCreated {
  return { requestId: row.id, status: stateOf(row), reference: row.reference };
}
