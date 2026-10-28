import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CS_DAILY_REQUESTS,
  CS_SCOPES,
  CS_REQUEST_TTL_DAYS,
  type CsBookingRequestByNames,
  type CsBookingRequestCreate,
  type CsBookingRequestCreated,
  type CsBookingRequestDto,
  type CsBookingRequestState,
  type CsSenderChannel,
} from '@nolon/shared';
import { todayIn, toDbDate } from '../common/dates.js';
import { dec } from '../common/money.js';
import { nextSequenceValue } from '../common/numbering.js';
import { type CsBookingRequest, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ApiClientAuth } from './api-client.guard.js';
import type { BookingRequestCaller } from './booking-request.guard.js';
import { keyScopes } from './api-scopes.js';
import { matchCategory, matchPlace } from './bot-names.js';
import { grantHoldsInTx } from './customer-token.guard.js';
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

/** SHA-256 of a request by names, as contentHash: without its key, the quantity as a number. */
export function namesHash(input: CsBookingRequestByNames): string {
  const normal = {
    ...input,
    idempotencyKey: undefined,
    quantity: dec(String(input.quantity)).toFixed(),
    quotedPrice: input.quotedPrice ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical({ form: 'names', ...normal })))
    .digest('hex');
}

/**
 * What the owner sees of a request's state: one undecided past its time is expired. A request by
 * names reads pending while it awaits routing (its bot knows pending, approved and rejected).
 */
export function stateOf(
  r: Pick<CsBookingRequest, 'status' | 'expiresAt'> & { botNames?: unknown },
  now = new Date(),
): CsBookingRequestState {
  const undecided = r.status === 'PENDING' || r.status === 'AWAITING_ROUTING';
  if (undecided && r.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (r.status === 'AWAITING_ROUTING' && r.botNames !== null && r.botNames !== undefined)
    return 'pending';
  return r.status.toLowerCase() as CsBookingRequestState;
}

/** The sender of a request by names: WhatsApp's verified number, or a number typed on Telegram. */
export function namesSender(channel: CsBookingRequestByNames['channel'], phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return channel === 'whatsapp' ? `+${digits}` : `tel:${digits}`;
}

/** Whether a key with these branches serves a request: its branch, or one it may be routed to. */
export function servedBy(
  r: Pick<CsBookingRequest, 'branchId' | 'allowedBranchIds'>,
  branchIds: readonly string[],
): boolean {
  return r.branchId === null
    ? r.allowedBranchIds.some((b) => branchIds.includes(b))
    : branchIds.includes(r.branchId);
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
    const replay = await this.replay(client, owner, input.idempotencyKey, hash);
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
      throw notServed();
    }
    const branchId = candidates.length === 1 ? (allowed[0] ?? null) : null;

    const result = await this.save(caller, owner, input.idempotencyKey, allowed, {
      ...(caller.kind === 'customer'
        ? { customerId: caller.token.customerId, grantId: caller.token.grantId }
        : { senderChannel: input.sender?.channel, senderId: input.sender?.id }),
      contactPhone: input.contactPhone ?? null,
      contentHash: hash,
      status: branchId === null ? 'AWAITING_ROUTING' : 'PENDING',
      branchId,
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
   * A request in the bot's own words (CsBookingRequestByNames), with the key only. Places and type
   * are matched to NOLON's by name; whatever does not match is kept as written, and the request
   * awaits staff. The branch still comes from the matched origin's routing rules only: an origin
   * without rules, or without a match, may go to any branch of the key, and staff route it.
   */
  async createByNames(
    caller: BookingRequestCaller,
    input: CsBookingRequestByNames,
  ): Promise<{ created: boolean; body: CsBookingRequestCreated }> {
    if (caller.kind === 'customer') {
      throw coded(HttpStatus.BAD_REQUEST, 'SENDER_WITH_TOKEN', 'A customer token names the owner');
    }
    const client = caller.client;
    const senderId = namesSender(input.channel, input.senderPhone);
    const owner = `s:${input.channel}:${senderId}`;
    const hash = namesHash(input);
    const replay = await this.replay(client, owner, input.idempotencyKey, hash);
    if (replay) return { created: false, body: replay };

    const [all, aliases] = await Promise.all([
      this.masterData.all(),
      this.masterData.locationAliases(),
    ]);
    const places = all.locations
      .filter((l) => l.isActive && l.kind !== 'COUNTRY')
      .map((l) => ({ ...l, aliases: aliases[l.id] ?? [] }));
    const originId = matchPlace(input.origin, places);
    const matchedTo = matchPlace(input.destination, places);
    const destinationId = matchedTo === originId ? null : matchedTo;
    const categoryCode = matchCategory(
      input.kind,
      all.priceCategories.filter((c) => c.isActive),
    );

    const { allowed, branchId } = await this.namesRouting(client, originId);
    const quoted = input.quotedPrice ?? null;
    const result = await this.save(caller, owner, input.idempotencyKey, allowed, {
      senderChannel: input.channel,
      senderId,
      contactPhone: input.senderPhone,
      contentHash: hash,
      status: branchId === null ? 'AWAITING_ROUTING' : 'PENDING',
      branchId,
      originLocationId: originId,
      destinationLocationId: destinationId,
      priceCategoryCode: categoryCode,
      botNames: {
        origin: { ...input.origin },
        destination: { ...input.destination },
        kind: { ...input.kind },
      },
      quantity: dec(String(input.quantity)),
      services: [],
      senderName: input.senderName,
      consigneeName: input.receiverName,
      consigneePhone: input.receiverPhone,
      handover: input.handover === 'pickup' ? 'PICKUP' : 'BRANCH_DROP',
      botQuotedAmount: quoted ? dec(quoted.amount) : null,
      botQuotedCurrency: quoted?.currency ?? null,
      language: null,
    });
    if (!result.created && result.row.contentHash !== hash) throw conflict();
    return { created: result.created, body: createdBody(result.row) };
  }

  /**
   * The branches of a request by names. A matched origin with routing rules: its candidates the
   * key serves (none = 422, another branch serves it), and the branch when there is one. No match,
   * or no rule: every branch of the key, for staff to route.
   */
  private async namesRouting(
    client: ApiClientAuth,
    originId: string | null,
  ): Promise<{ allowed: string[]; branchId: string | null }> {
    const candidates = originId === null ? [] : await this.masterData.routingCandidates(originId);
    const allowed =
      candidates.length === 0
        ? [...client.allowedBranchIds].sort()
        : candidates.filter((id) => client.allowedBranchIds.includes(id));
    if (allowed.length === 0) {
      throw notServed();
    }
    return { allowed, branchId: candidates.length === 1 ? (allowed[0] ?? null) : null };
  }

  /**
   * Saves a new request once: one owner's requests one at a time, so the retry check and the daily
   * count see every row. The key (and a customer token's grant) is checked again inside the
   * transaction, share-locked against its revocation or change, and its current branches cap the
   * request: a key revoked or changed before the insert leaves no request (F126-1). Returns the row
   * already saved under the idempotency key when there is one and the key still serves it.
   */
  private async save(
    caller: BookingRequestCaller,
    owner: string,
    idempotencyKey: string,
    allowed: readonly string[],
    data: Omit<
      Prisma.CsBookingRequestUncheckedCreateInput,
      'reference' | 'apiClientId' | 'ownerRef' | 'idempotencyKey' | 'expiresAt' | 'allowedBranchIds'
    >,
  ): Promise<{ created: boolean; row: CsBookingRequest }> {
    const now = new Date();
    const apiClientId = caller.client.id;
    return this.prisma.$transaction(async (tx) => {
      const branchIds = await currentBranches(tx, caller);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 0))`;
      const again = await tx.csBookingRequest.findUnique({
        where: {
          apiClientId_ownerRef_idempotencyKey: { apiClientId, ownerRef: owner, idempotencyKey },
        },
      });
      if (again) {
        if (!servedBy(again, branchIds)) throw new NotFoundException('Booking request not found');
        return { created: false, row: again };
      }
      const still = allowed.filter((b) => branchIds.includes(b));
      if (
        still.length === 0 ||
        (typeof data.branchId === 'string' && !branchIds.includes(data.branchId))
      ) {
        throw notServed();
      }
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
          ...data,
          allowedBranchIds: still,
          reference: requestReference(number),
          apiClientId,
          ownerRef: owner,
          idempotencyKey,
          expiresAt: new Date(now.getTime() + CS_REQUEST_TTL_DAYS * DAY_MS),
        },
      });
      return { created: true, row };
    });
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
    // A request by names belongs to the key that made it (its bot names no sender id to read by).
    const byKey = { id, apiClientId: caller.client.id, botNames: { not: Prisma.AnyNull } };
    const row =
      owner === null
        ? caller.kind === 'key'
          ? await this.prisma.csBookingRequest.findFirst({ where: byKey })
          : null
        : await this.prisma.csBookingRequest.findFirst({
            where: { OR: [{ id, apiClientId: caller.client.id, ownerRef: owner }, byKey] },
          });
    const served = row !== null && servedBy(row, caller.client.allowedBranchIds);
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

  /**
   * The request this key and owner already made with this idempotency key, when there is one. A
   * retry reads the saved request, so it is 404 like a read once the key no longer serves it
   * (F126-2).
   */
  private async replay(
    client: ApiClientAuth,
    owner: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<CsBookingRequestCreated | null> {
    const row = await this.prisma.csBookingRequest.findUnique({
      where: {
        apiClientId_ownerRef_idempotencyKey: {
          apiClientId: client.id,
          ownerRef: owner,
          idempotencyKey,
        },
      },
    });
    if (!row) return null;
    if (!servedBy(row, client.allowedBranchIds)) {
      throw new NotFoundException('Booking request not found');
    }
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

function notServed(): HttpException {
  return coded(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'ORIGIN_NOT_SERVED',
    'No branch of this key serves the origin: hand over to staff',
  );
}

/**
 * The caller's key read again inside a write's transaction and share-locked, so a revocation or a
 * scope change commits before it (and is seen) or waits for the write: still active, still holding
 * cs:booking_requests:create, and, for a customer token, a grant that still holds. Its branches.
 */
async function currentBranches(
  tx: Prisma.TransactionClient,
  caller: BookingRequestCaller,
): Promise<string[]> {
  const id = caller.client.id;
  await tx.$queryRaw`SELECT 1 FROM "api_clients" WHERE "id" = ${id}::uuid FOR SHARE`;
  const key = await tx.apiClient.findUnique({
    where: { id },
    include: { branches: { select: { branchId: true } }, scopes: { select: { scope: true } } },
  });
  if (!key?.isActive) {
    throw new UnauthorizedException('A valid Customer Service API key is required');
  }
  if (!keyScopes(key.customersRead, key.scopes, CS_SCOPES).includes('cs:booking_requests:create')) {
    throw new ForbiddenException({
      message: 'This API key does not hold the scope cs:booking_requests:create',
      code: 'SCOPE_REQUIRED',
      error: 'Forbidden',
      statusCode: 403,
    });
  }
  if (caller.kind === 'customer' && !(await grantHoldsInTx(tx, caller.token.tokenId))) {
    throw new UnauthorizedException({
      message: 'The token is no longer valid',
      code: 'GRANT_REVOKED',
      error: 'Unauthorized',
      statusCode: 401,
    });
  }
  return key.branches.map((b) => b.branchId);
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
