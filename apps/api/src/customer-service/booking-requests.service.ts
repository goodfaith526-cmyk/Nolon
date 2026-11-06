import { dropOffDto, dropOffSelect } from './drop-off.js';
import { senderChannelOf, senderIdOf } from './customer-identity.contract.js';
import { estimateOf, imageTypeOf, storedTerms } from './estimates.js';
import {
  CustomerIdentityService,
  type ProfileBookingBinding,
} from './customer-identity.service.js';
import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CS_DAILY_REQUESTS,
  CS_OTHER_KIND,
  CS_SCOPES,
  CS_REQUEST_TTL_DAYS,
  type BookingService,
  type CsBookingRequestByNames,
  type CsBotEstimateDto,
  type CsBookingRequestCancelled,
  type CsCancelRequestDto,
  type CsBookingRequestCreate,
  type CsBookingRequestCreated,
  type CsBookingRequestDto,
  type CsOwnBookingRequestDto,
  type CsBookingRequestState,
  CS_REQUEST_PHOTOS_MAX,
  CS_REQUEST_PHOTO_MAX_BYTES,
  type CsEstimateAccepted,
  type CsPhotoUploaded,
  type CsRequestPhotoType,
  type CsItemMeasures,
  type CsNamesItemInput,
  type CsOtherSender,
  type CsRequestInvoiceDto,
  type CsRequestInvoiceState,
  type CsRequestItemInput,
  type CsRequestPaymentDto,
  type CsRequestService,
  type CsSenderChannel,
} from '@nolon/shared';
import { fromDbDate, todayIn, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import { formatShortNumber, nextSequenceValue } from '../common/numbering.js';
import { internationalPhone, samePhone } from '../common/phones.js';
import { type CsBookingRequest, Prisma } from '../generated/prisma/client.js';
import { CustomersService } from '../customers/customers.service.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { trackOf } from './customer-stages.js';
import { CsEventsService } from './cs-events.service.js';
import { CustomerStagesService } from './customer-stages.service.js';
import type { ApiClientAuth } from './api-client.guard.js';
import type { BookingRequestCaller } from './booking-request.guard.js';
import { keyScopes, keyServices } from './api-scopes.js';
import { matchCategory, matchPlace } from './bot-names.js';
import { grantHoldsInTx } from './customer-token.guard.js';
import { CustomerTokensService } from './customer-tokens.service.js';
import { PaymentInstructionsService } from './payment-instructions.service.js';

const DAY_MS = 86_400_000;

/** A place's names and its city's, for the customer's stage city (plan 09 section 3). */
export const placeSelect = {
  kind: true,
  nameAr: true,
  nameEn: true,
  city: { select: { nameAr: true, nameEn: true } },
} as const;

/** A request's route as the bot named it (bot_names), each end null when not stored as names. */
export function storedBotNames(value: unknown): {
  origin: { ar: string; en: string } | null;
  destination: { ar: string; en: string } | null;
} {
  const nameAt = (key: string) => {
    const v =
      value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : null;
    if (v === null || typeof v !== 'object') return null;
    const { ar, en } = v as Record<string, unknown>;
    return typeof ar === 'string' && typeof en === 'string' ? { ar, en } : null;
  };
  return { origin: nameAt('origin'), destination: nameAt('destination') };
}

/** The booking and shipment columns a request's customer stage is read from (plan 09 section 3). */
const trackedBookingSelect = {
  number: true,
  status: true,
  shipment: {
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      trackingToken: true,
      destination: { select: placeSelect },
      currentLocation: { select: placeSelect },
      events: {
        select: { occurredAt: true },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      },
    },
  },
} as const satisfies Prisma.BookingSelect;

type TrackedBooking = Prisma.BookingGetPayload<{ select: typeof trackedBookingSelect }>;

/** An approved invoice's state for the customer (trial 2026-11-06: credited is not "paid"). */
export function invoiceStateOf(
  paid: Prisma.Decimal,
  credited: Prisma.Decimal,
  balance: Prisma.Decimal,
): CsRequestInvoiceState {
  if (balance.gt(0)) return paid.gt(0) ? 'partly_paid' : 'open';
  return paid.isZero() && credited.gt(0) ? 'credited' : 'paid';
}

/** A request's customer stage, from its state and its booking's shipment. */
function rowTrack(
  row: CsBookingRequest & { booking: TrackedBooking | null },
  stages: Parameters<typeof trackOf>[1],
  mapping: Parameters<typeof trackOf>[2],
): ReturnType<typeof trackOf> {
  const shipment = row.booking?.shipment ?? null;
  return trackOf(
    {
      state: stateOf(row),
      booking: row.booking && {
        status: row.booking.status,
        shipment: shipment && {
          number: shipment.number,
          status: shipment.status,
          destination: shipment.destination,
          currentLocation: shipment.currentLocation,
          updatedAt: shipment.events[0]?.occurredAt ?? shipment.createdAt,
        },
      },
    },
    stages,
    mapping,
  );
}

/**
 * A request's number as its booking keeps it. Since 2026-11-04 a request takes the next BK number
 * when it arrives (owner: one number from request to shipment); an older request's BR-000001 is
 * not a booking number, so its booking takes a new BK number.
 */
export function reservedBookingNumber(reference: string): string | undefined {
  return /^BK\d{5,}$/.test(reference) ? reference : undefined;
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

/** A dimension as a number (120 and 120.00 are the same measurement); left out stays left out. */
function measurement(value: string | undefined): string | undefined {
  return value === undefined ? undefined : dec(value).toFixed();
}

/** An item as hashed: its numbers as numbers, so 2 and 2.0 are the same item (plan 09 section 4). */
function normalItem(item: CsRequestItemInput | CsNamesItemInput): Record<string, unknown> {
  const measures: CsItemMeasures = item;
  return {
    ...item,
    ...('quantity' in item ? { quantity: dec(String(item.quantity)).toFixed() } : {}),
    lengthCm: measurement(measures.lengthCm),
    widthCm: measurement(measures.widthCm),
    heightCm: measurement(measures.heightCm),
    weightKg: measurement(measures.weightKg),
  };
}

/** One request item as stored (plan 09 section 4), without its request. */
type ItemRow = Omit<
  Prisma.CsBookingRequestItemUncheckedCreateInput,
  'id' | 'requestId' | 'quantity'
> & { quantity?: Prisma.Decimal | null };

/** The measurements of an item, as stored. */
function measuresOf(item: CsItemMeasures) {
  return {
    pieces: item.pieces ?? null,
    lengthCm: item.lengthCm === undefined ? null : dec(item.lengthCm),
    widthCm: item.widthCm === undefined ? null : dec(item.widthCm),
    heightCm: item.heightCm === undefined ? null : dec(item.heightCm),
    weightKg: item.weightKg === undefined ? null : dec(item.weightKg),
  };
}

/** An OTHER item (plan 09 section 12): the customer's description, never a category or price. */
function otherRow(lineNo: number, item: CsItemMeasures & { description: string }): ItemRow {
  return { lineNo, isOther: true, description: item.description, ...measuresOf(item) };
}

/**
 * The request columns its items fill (plan 09 section 4): the first standard item's category and
 * quantity, so reads that predate items still describe the request; an OTHER-only request has no
 * category and its first item's pieces (or 1) as quantity.
 */
function rootOf(rows: readonly ItemRow[]): { category: string | null; quantity: Prisma.Decimal } {
  const first = rows.find((r) => !r.isOther);
  if (first?.quantity !== undefined && first.quantity !== null)
    return { category: first.priceCategoryCode ?? null, quantity: first.quantity };
  return {
    category: first?.priceCategoryCode ?? null,
    quantity: dec(String(rows[0]?.pieces ?? 1)),
  };
}

/**
 * SHA-256 of a request's content: the body without its idempotency key, keys sorted, services
 * sorted, the quantity and the dimensions as numbers (2 and 2.0 are the same request).
 */
export function contentHash(input: CsBookingRequestCreate): string {
  const normal: Record<string, unknown> = {
    ...input,
    idempotencyKey: undefined,
    quantity: input.quantity === undefined ? undefined : dec(input.quantity).toFixed(),
    items: input.items?.map(normalItem),
    lengthCm: measurement(input.lengthCm),
    widthCm: measurement(input.widthCm),
    heightCm: measurement(input.heightCm),
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
    quantity: input.quantity === undefined ? undefined : dec(String(input.quantity)).toFixed(),
    items: input.items?.map(normalItem),
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
  // An estimated request expires with its estimate (plan 09 section 12: expires_at = validUntil).
  const undecided =
    r.status === 'PENDING' || r.status === 'AWAITING_ROUTING' || r.status === 'ESTIMATED';
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
    private readonly payments: PaymentInstructionsService,
    private readonly identities: CustomerIdentityService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly stages: CustomerStagesService,
    private readonly customers: CustomersService,
    private readonly events: CsEventsService,
  ) {}

  /** The public tracking page of a shipment, as its QR code opens it; null when not configured. */
  private trackingUrl(token: string): string | null {
    const base = this.env.PUBLIC_WEB_URL ?? this.env.CORS_ORIGINS[0];
    return base ? `${base.replace(/\/+$/, '')}/track/${token}` : null;
  }

  async create(
    caller: BookingRequestCaller,
    input: CsBookingRequestCreate,
    binding?: ProfileBookingBinding,
  ): Promise<{ created: boolean; body: CsBookingRequestCreated }> {
    if (caller.kind === 'customer' && (input.sender || input.otherSender)) {
      throw coded(HttpStatus.BAD_REQUEST, 'SENDER_WITH_TOKEN', 'A customer token names the owner');
    }
    if (binding && !input.sender)
      input = {
        ...input,
        sender: {
          channel: senderChannelOf(binding.context.channel),
          id: senderIdOf(binding.context),
        },
      };
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
    if (input.requestedDate !== undefined && input.requestedDate < todayIn('UTC')) {
      throw coded(HttpStatus.BAD_REQUEST, 'BAD_DATE', 'requestedDate must be today (UTC) or later');
    }
    // Plan 09 section 4: items, or the original one-item shape (the controller allows one only).
    const items = input.items ? await this.itemsById(client.id, input, input.items) : [];
    let root: { category: string | null; quantity: Prisma.Decimal };
    if (input.items) {
      root = rootOf(items);
    } else {
      const category = await this.masterData.requirePriceCategory(input.category!, null);
      if (input.quoteRef !== undefined)
        await this.checkQuote(client.id, {
          ...input,
          category: category.code,
          quantity: input.quantity!,
        });
      root = { category: category.code, quantity: dec(input.quantity!) };
    }

    // Section 6: the branch from the origin's rules only, never from the customer's words. The key's
    // branches are the ceiling: one branch outside them, or no candidate inside them, is refused.
    const candidates = await this.masterData.routingCandidates(input.originId);
    const allowed = candidates.filter((id) => client.allowedBranchIds.includes(id));
    if (allowed.length === 0) {
      throw notServed();
    }
    const branchId = candidates.length === 1 ? (allowed[0] ?? null) : null;

    const result = await this.save(
      caller,
      owner,
      input.idempotencyKey,
      allowed,
      {
        ...(caller.kind === 'customer'
          ? { customerId: caller.token.customerId, grantId: caller.token.grantId }
          : { senderChannel: input.sender?.channel, senderId: input.sender?.id }),
        contactPhone: input.contactPhone ?? null,
        contentHash: hash,
        status: branchId === null ? 'AWAITING_ROUTING' : 'PENDING',
        branchId,
        originLocationId: input.originId,
        destinationLocationId: input.destinationId,
        priceCategoryCode: root.category,
        quantity: root.quantity,
        ...(items.length > 0 ? { items: { create: items } } : {}),
        // A volume category's pieces and dimensions, as the customer gave them, for staff.
        pieces: input.pieces ?? null,
        lengthCm: input.lengthCm === undefined ? null : dec(input.lengthCm),
        widthCm: input.widthCm === undefined ? null : dec(input.widthCm),
        heightCm: input.heightCm === undefined ? null : dec(input.heightCm),
        services: input.services,
        ...otherSenderData(input.otherSender),
        senderName: input.senderName,
        consigneeName: input.consigneeName,
        consigneePhone: input.consigneePhone,
        handover: input.handover,
        requestedDate: input.requestedDate ? toDbDate(input.requestedDate) : null,
        quoteRef: input.quoteRef ?? null,
        language: input.language,
      },
      binding,
    );
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
    binding?: ProfileBookingBinding,
  ): Promise<{ created: boolean; body: CsBookingRequestCreated }> {
    if (caller.kind === 'customer') {
      throw coded(HttpStatus.BAD_REQUEST, 'SENDER_WITH_TOKEN', 'A customer token names the owner');
    }
    const client = caller.client;
    if (!input.senderPhone && !binding)
      throw coded(
        HttpStatus.BAD_REQUEST,
        'SENDER_REQUIRED',
        'A contact phone or signed profile binding is required',
      );
    const senderId = binding?.context.subjectId ?? namesSender(input.channel, input.senderPhone!);
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
    const active = all.priceCategories.filter((c) => c.isActive);
    // Plan 09 section 4: each item's kind matched as the one-item shape's is; OTHER is described.
    const items: ItemRow[] = (input.items ?? []).map((item, index) =>
      item.kind === CS_OTHER_KIND
        ? otherRow(index + 1, item)
        : {
            lineNo: index + 1,
            priceCategoryCode: matchCategory(item.kind, active),
            botKind: { ...item.kind },
            quantity: dec(String(item.quantity)),
            ...measuresOf(item),
          },
    );
    const firstKind = input.items?.[0];
    const kind =
      input.kind ??
      (firstKind === undefined || firstKind.kind === CS_OTHER_KIND
        ? {
            ar: firstKind?.description.slice(0, 200) ?? '',
            en: firstKind?.description.slice(0, 200) ?? '',
          }
        : firstKind.kind);
    const root = input.items
      ? rootOf(items)
      : { category: matchCategory(input.kind!, active), quantity: dec(String(input.quantity)) };
    const categoryCode = root.category;

    const { allowed, branchId } = await this.namesRouting(client, originId);
    const quoted = input.quotedPrice ?? null;
    const result = await this.save(
      caller,
      owner,
      input.idempotencyKey,
      allowed,
      {
        senderChannel: input.channel,
        senderId,
        contactPhone: input.senderPhone ?? null,
        contentHash: hash,
        status: branchId === null ? 'AWAITING_ROUTING' : 'PENDING',
        branchId,
        originLocationId: originId,
        destinationLocationId: destinationId,
        priceCategoryCode: categoryCode,
        botNames: {
          origin: { ...input.origin },
          destination: { ...input.destination },
          kind: { ...kind },
        },
        quantity: root.quantity,
        ...(items.length > 0 ? { items: { create: items } } : {}),
        services: [],
        ...otherSenderData(input.otherSender),
        senderName: input.senderName,
        consigneeName: input.receiverName,
        consigneePhone: input.receiverPhone,
        handover: input.handover === 'pickup' ? 'PICKUP' : 'BRANCH_DROP',
        botQuotedAmount: quoted ? dec(quoted.amount) : null,
        botQuotedCurrency: quoted?.currency ?? null,
        language: null,
      },
      binding,
    );
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
    binding?: ProfileBookingBinding,
  ): Promise<{ created: boolean; row: CsBookingRequest }> {
    const now = new Date();
    const apiClientId = caller.client.id;
    return this.prisma.$transaction(async (tx) => {
      const { branchIds, services } = await currentKey(tx, caller);
      const profile = binding
        ? await this.identities.requireBookingBindingInTx(tx, apiClientId, binding)
        : null;
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
      // Only what the key's bot offers now, read under the key's lock (a service turned off after
      // the guard read the key still refuses): no pickup, as a service or as the handover.
      const asked = [
        ...(Array.isArray(data.services) ? data.services : []),
        ...(data.handover === 'PICKUP' ? ['PICKUP' as const] : []),
      ];
      const refused = asked.find((s) => !(services as readonly string[]).includes(s));
      if (refused) {
        throw coded(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'SERVICE_NOT_OFFERED',
          `This key does not offer ${refused}: see the catalog's services`,
        );
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
      // Plan 09e: the other sender's customer found (row-locked) before any customer-key lock;
      // one to make is made last, after the owner's instant account (Codex F191-3).
      const other = await this.otherSenderInTx(tx, data, profile?.phone ?? null);
      // Owner, 2026-11-04: a request with no profile (the website chat) registers its sender too.
      const sender =
        caller.kind === 'key' && !profile && this.env.CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED
          ? await this.requestSenderInTx(tx, apiClientId, owner, data)
          : null;
      // The owner's instant account (2026-11-03): a signed request for a known branch makes or
      // reuses the profile's branch account in this transaction, or says why staff will.
      const account =
        this.env.CS_INSTANT_CUSTOMER_ENABLED &&
        profile &&
        data.status === 'PENDING' &&
        typeof data.branchId === 'string'
          ? await this.customers.botAccountInTx(tx, {
              profile,
              expectedVersion: binding?.profileVersion,
              apiClientId,
            })
          : null;
      const senderCustomerId = sender?.create
        ? await this.customers.phoneCustomerCreateInTx(tx, {
            name: sender.name,
            phone: sender.phone,
            apiClientId,
          })
        : (sender?.customerId ?? null);
      const otherCustomerId = other?.create
        ? await this.customers.phoneCustomerCreateInTx(tx, {
            name: other.name,
            phone: other.phone,
            apiClientId,
          })
        : (other?.customerId ?? null);
      // Owner, 2026-11-04: the request's number is its booking's (BK), from the start. A request
      // that is rejected or expires leaves its number unused. Taken after every customer-key lock
      // above, the order staff booking for a new customer takes them in (Codex F195-1).
      const number = formatShortNumber('BK', await nextSequenceValue(tx, 'BOOKING'));
      const row = await tx.csBookingRequest.create({
        data: {
          ...data,
          otherSenderName: other?.name ?? null,
          otherSenderPhone: other?.phone ?? null,
          otherSenderCustomerId: otherCustomerId,
          ...(binding
            ? { profileId: binding.profileId, conversationId: binding.conversationId }
            : {}),
          ...(account
            ? { instantAccount: account.outcome, instantCustomerId: account.customerId }
            : {}),
          ...(sender
            ? { instantAccount: sender.outcome, instantCustomerId: senderCustomerId }
            : {}),
          allowedBranchIds: still,
          reference: number,
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
   * Owner, 2026-11-04: the sender of a request with no profile (the website chat) is registered
   * when it arrives, not only on approval. The same sender of the same key is the customer their
   * earlier request made; else the one customer holding their international phone (linked
   * unchanged, row-locked here; several link none, PHONE_IN_USE); else a new individual (made
   * last, under the customer-key lock), its phone marked unverified, or with no phone when the one
   * given is local. An inactive customer is ACCOUNT_INACTIVE and links none: staff decide.
   */
  private async requestSenderInTx(
    tx: Prisma.TransactionClient,
    apiClientId: string,
    owner: string,
    data: {
      senderName?: string | null;
      contactPhone?: string | null;
      senderChannel?: string | null;
      senderId?: string | null;
    },
  ): Promise<{
    outcome: 'CREATED' | 'REUSED' | 'PHONE_IN_USE' | 'ACCOUNT_INACTIVE' | 'NAME_MISSING';
    customerId: string | null;
    create: boolean;
    name: string;
    phone: string | null;
  }> {
    const name = data.senderName?.trim() ?? '';
    // Codex F191-4: a WhatsApp number is international by the channel's contract, also written
    // as digits (249…, as namesSender reads it); a local Telegram or web number stays unresolved.
    const whatsapp =
      data.senderChannel === 'whatsapp'
        ? internationalPhone(namesSender('whatsapp', data.contactPhone ?? data.senderId ?? ''))
        : null;
    const phone = internationalPhone(data.contactPhone) ?? whatsapp;
    const linked = (customerId: string, isActive: boolean) => ({
      outcome: isActive ? ('REUSED' as const) : ('ACCOUNT_INACTIVE' as const),
      customerId: isActive ? customerId : null,
      create: false,
      name,
      phone,
    });
    const earlier = await tx.csBookingRequest.findFirst({
      where: { apiClientId, ownerRef: owner, profileId: null, instantCustomerId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { instantCustomerId: true },
    });
    if (earlier?.instantCustomerId) {
      // Owner, 2026-11-05: new information is added to the file: a phone this request brings
      // fills the sender's customer that has none yet.
      if (phone !== null)
        await this.customers.addMissingPhoneInTx(tx, earlier.instantCustomerId, phone);
      const [row] = await tx.$queryRaw<{ isActive: boolean }[]>`
        SELECT "is_active" AS "isActive" FROM "customers"
        WHERE "id" = ${earlier.instantCustomerId}::uuid FOR SHARE`;
      return linked(earlier.instantCustomerId, row?.isActive ?? false);
    }
    if (phone !== null) {
      const match = await this.customers.phoneMatchInTx(tx, phone);
      if (match.kind === 'ONE') return linked(match.customerId, match.isActive);
      if (match.kind === 'AMBIGUOUS')
        return { outcome: 'PHONE_IN_USE', customerId: null, create: false, name, phone };
    }
    if (!name) return { outcome: 'NAME_MISSING', customerId: null, create: false, name, phone };
    return { outcome: 'CREATED', customerId: null, create: true, name, phone };
  }

  /**
   * Plan 09e section 2: an explicit other sender. One whose phone is the chat owner's (the shared
   * contact phone or the profile's) is the owner: null, nothing is kept. Else, with the identity
   * switch on, the one customer with that phone is linked unchanged (row-locked here); several
   * link none (Codex F191-2, approval refuses); none is to be made (`create`). Off, approval does
   * the same. The chat owner's own customer is never touched.
   */
  private async otherSenderInTx(
    tx: Prisma.TransactionClient,
    data: {
      otherSenderName?: string | null;
      otherSenderPhone?: string | null;
      contactPhone?: string | null;
    },
    profilePhone: string | null,
  ): Promise<{ name: string; phone: string; customerId: string | null; create: boolean } | null> {
    const name = data.otherSenderName ?? null;
    const phone = data.otherSenderPhone ?? null;
    if (name === null || phone === null) return null;
    if (samePhone(phone, data.contactPhone ?? null) || samePhone(phone, profilePhone)) return null;
    if (!this.env.CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED)
      return { name, phone, customerId: null, create: false };
    const match = await this.customers.phoneMatchInTx(tx, phone);
    return {
      name,
      phone,
      customerId: match.kind === 'ONE' ? match.customerId : null,
      create: match.kind === 'NONE',
    };
  }

  /**
   * The proven owner's requests, newest first, at most `limit` (owner 2026-11-05: the bot answers
   * "my bookings" from NOLON, never from its memory). The owner as for cancelling: a customer
   * token's own requests, or a signed channel identity's (plan 08); the key alone, or X-Cs-Sender,
   * is no proof: 403 OWNER_PROOF_REQUIRED. Requests of branches the key no longer serves are left
   * out, as a read 404s them.
   */
  async list(
    caller: BookingRequestCaller,
    proof: { channel: CsSenderChannel; subjectId: string } | null,
    limit: number,
  ): Promise<CsOwnBookingRequestDto[]> {
    const owner = provenOwnerOf(caller, proof, 'Listing requests');
    const branchIds = [...caller.client.allowedBranchIds];
    const rows = await this.prisma.csBookingRequest.findMany({
      where: {
        AND: [
          owner,
          {
            OR: [
              { branchId: { in: branchIds } },
              { branchId: null, allowedBranchIds: { hasSome: branchIds } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        origin: { select: { nameAr: true, nameEn: true } },
        destination: { select: { nameAr: true, nameEn: true } },
        booking: { select: trackedBookingSelect },
      },
    });
    if (caller.kind === 'customer') {
      await this.tokens.record(
        caller.client.id,
        caller.token.tokenId,
        caller.token.customerId,
        'OK',
        'GET /cs/booking-requests',
      );
    }
    const { stages, mapping } = await this.stages.maps();
    return rows
      .filter((row) => servedBy(row, caller.client.allowedBranchIds))
      .map((row) => {
        const names = storedBotNames(row.botNames);
        const track = rowTrack(row, stages, mapping);
        return {
          requestId: row.id,
          reference: row.reference,
          status: stateOf(row),
          createdAt: row.createdAt.toISOString(),
          bookingNumber: row.status === 'APPROVED' ? (row.booking?.number ?? null) : null,
          origin: row.origin ? { ar: row.origin.nameAr, en: row.origin.nameEn } : names.origin,
          destination: row.destination
            ? { ar: row.destination.nameAr, en: row.destination.nameEn }
            : names.destination,
          stage: track.stage,
          attention: track.attention,
          shipment:
            track.shipment && row.booking?.shipment
              ? {
                  ...track.shipment,
                  trackingUrl: this.trackingUrl(row.booking.shipment.trackingToken),
                }
              : null,
        };
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
    const row = await this.prisma.csBookingRequest.findFirst({
      where: ownedWhere(caller, id, sender),
      include: {
        rejectReason: true,
        dropOff: { select: dropOffSelect },
        _count: { select: { photos: true } },
        booking: { select: trackedBookingSelect },
      },
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
    const { stages, mapping } = await this.stages.maps();
    const shipment = row.booking?.shipment ?? null;
    const track = rowTrack(row, stages, mapping);
    return {
      requestId: row.id,
      reference: row.reference,
      status: stateOf(row),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      // The booking's number as it is now (an edit may renumber a draft).
      bookingNumber: row.status === 'APPROVED' ? (row.booking?.number ?? null) : null,
      // Plan 04a section 5: the approved reason only, never the internal note.
      customerReason:
        row.status === 'REJECTED' && row.rejectReason
          ? { ar: row.rejectReason.textAr, en: row.rejectReason.textEn }
          : null,
      // Plan 04 section 4.1: exactly the request's branch and payment currency, or none.
      paymentInstructions:
        row.status === 'APPROVED' && row.branchId !== null && row.paymentCurrency !== null
          ? await this.payments.approvedFor(row.branchId, row.paymentCurrency)
          : null,
      cancelRequest: cancelRequestOf(row),
      // Plan 09 amendment 4: the price staff approved (the engine's, in the pricing currency),
      // once approved; null when approved with no engine price.
      approvedPrice:
        row.status === 'APPROVED' && row.approvedTotal !== null && row.approvedCurrency !== null
          ? { amount: toDecimalString(row.approvedTotal), currency: row.approvedCurrency }
          : null,
      dropOff: row.status === 'APPROVED' ? dropOffDto(row.dropOff) : null,
      // Plan 09 section 12: the estimate awaiting the customer only (an expired one is not shown).
      estimate: stateOf(row) === 'estimated' ? await this.botEstimateOf(row) : null,
      photoCount: row._count.photos,
      ...track,
      // Plan 09 amendment 4: the public tracking link the shipment's QR opens, once it exists.
      shipment:
        track.shipment && shipment
          ? { ...track.shipment, trackingUrl: this.trackingUrl(shipment.trackingToken) }
          : null,
      payment:
        row.status === 'APPROVED' && shipment
          ? await this.paymentOf(caller.client, shipment.id)
          : null,
    };
  }

  /**
   * Trial 2026-11-06: the shipment's invoices as the customer's bot may tell them: approved ones
   * with their amounts, drafts as a count only. Invoices of branches the key does not serve are
   * left out (rule 2).
   */
  private async paymentOf(client: ApiClientAuth, shipmentId: string): Promise<CsRequestPaymentDto> {
    const rows = await this.prisma.customerInvoice.findMany({
      where: {
        shipmentId,
        branchId: { in: [...client.allowedBranchIds] },
        status: { in: ['APPROVED', 'DRAFT'] },
      },
      orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        number: true,
        kind: true,
        status: true,
        invoiceDate: true,
        dueDate: true,
        currency: true,
        total: true,
        paidAmount: true,
        creditedAmount: true,
      },
    });
    const invoices: CsRequestInvoiceDto[] = [];
    let draftInvoices = 0;
    for (const r of rows) {
      if (r.status !== 'APPROVED' || r.number === null) {
        draftInvoices += 1;
        continue;
      }
      const balance = r.total.minus(r.paidAmount).minus(r.creditedAmount);
      invoices.push({
        number: r.number,
        kind: r.kind,
        invoiceDate: fromDbDate(r.invoiceDate),
        dueDate: fromDbDate(r.dueDate),
        currency: r.currency,
        total: toDecimalString(r.total),
        paid: toDecimalString(r.paidAmount),
        credited: toDecimalString(r.creditedAmount),
        balance: toDecimalString(balance),
        state: invoiceStateOf(r.paidAmount, r.creditedAmount, balance),
      });
    }
    return { invoices, draftInvoices };
  }

  /**
   * Codex F171-2: the estimate with the terms it prices, for the customer to see before accepting
   * it: the route by its names, as the locations are now (a name is shown, never decided on).
   */
  private async botEstimateOf(row: CsBookingRequest): Promise<CsBotEstimateDto | null> {
    const estimate = estimateOf(row);
    if (!estimate) return null;
    const terms = storedTerms(row.estimateTerms);
    if (!terms) return { ...estimate, terms: null };
    const places = await this.prisma.location.findMany({
      where: { id: { in: [terms.originId, terms.destinationId] } },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
    const place = (id: string) => {
      const l = places.find((p) => p.id === id);
      return l ? { code: l.code, ar: l.nameAr, en: l.nameEn } : null;
    };
    const origin = place(terms.originId);
    const destination = place(terms.destinationId);
    return {
      ...estimate,
      terms:
        origin && destination
          ? {
              origin,
              destination,
              mode: terms.mode,
              loadType: terms.loadType,
              services: terms.services as BookingService[],
            }
          : null,
    };
  }

  /**
   * Plan 09 section 2: the owner cancels a request. The owner is proven, never asserted: a customer
   * token's own request, or a signed channel identity (plan 08) whose subject is the request's
   * sender. The key alone, or X-Cs-Sender, is no proof (F161-1): 403 OWNER_PROOF_REQUIRED, and the
   * bot hands over to staff. An undecided request not expired becomes CANCELLED; one already
   * cancelled answers the same. An approved one is not cancelled: 409 ALREADY_DECIDED, and the ask
   * is kept once for staff (the booking is theirs to cancel). Rejected or expired: 409
   * ALREADY_DECIDED. All under the row's lock, with the key read again (revoked or no longer
   * serving = 404, as a read).
   */
  async cancel(
    caller: BookingRequestCaller,
    id: string,
    proof: { channel: CsSenderChannel; subjectId: string } | null,
    reason: string | undefined,
  ): Promise<CsBookingRequestCancelled> {
    if (!this.env.CS_BOOKING_CANCEL_ENABLED) {
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        'CANCEL_UNAVAILABLE',
        'Cancelling a booking request is not available yet: hand over to staff',
      );
    }
    const where = provenOwner(caller, id, proof, 'Cancelling');
    const found = await this.prisma.csBookingRequest.findFirst({ where, select: { id: true } });
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (!found) return null;
      const { branchIds } = await currentKey(tx, caller);
      await tx.$queryRaw`SELECT 1 FROM "cs_booking_requests" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
      const row = await tx.csBookingRequest.findUnique({ where: { id: found.id } });
      if (!row || !servedBy(row, branchIds)) return null;
      const now = new Date();
      const audit = (action: 'CANCELLED' | 'UPDATED', field: string) =>
        this.audit.recordApi(tx, {
          branchId: row.branchId,
          entity: 'CS_BOOKING_REQUEST',
          entityId: row.id,
          reference: row.reference,
          action,
          changes: [
            { field, before: null, after: reason ?? '' },
            { field: 'apiClient', before: null, after: caller.client.id },
            { field: 'owner', before: null, after: row.ownerRef },
          ],
        });
      if (row.status === 'CANCELLED') return { kind: 'cancelled' as const, row };
      // Plan 09 section 12: declining an estimate is cancelling the request.
      if (['pending', 'awaiting_routing', 'estimated'].includes(stateOf(row, now))) {
        const cancelled = await tx.csBookingRequest.update({
          where: { id: row.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancelReason: reason ?? null,
            version: { increment: 1 },
          },
        });
        await audit('CANCELLED', 'cancelReason');
        await this.events.emitInTx(tx, cancelled, ['request.cancelled'], now);
        return { kind: 'cancelled' as const, row: cancelled };
      }
      if (row.status === 'APPROVED') {
        if (row.cancelRequestedAt !== null) return { kind: 'asked' as const, row };
        const asked = await tx.csBookingRequest.update({
          where: { id: row.id },
          data: {
            cancelRequestedAt: now,
            cancelRequestReason: reason ?? null,
            version: { increment: 1 },
          },
        });
        await audit('UPDATED', 'cancelRequestReason');
        await this.events.emitInTx(tx, asked, ['request.cancel_requested'], now);
        return { kind: 'asked' as const, row: asked };
      }
      return { kind: 'decided' as const, row };
    });
    if (caller.kind === 'customer') {
      await this.tokens.record(
        caller.client.id,
        caller.token.tokenId,
        caller.token.customerId,
        outcome ? 'OK' : 'NOT_FOUND',
        'POST /cs/booking-requests/:id/cancel',
      );
    }
    if (!outcome) throw new NotFoundException('Booking request not found');
    const { kind, row } = outcome;
    if (kind === 'cancelled') {
      return {
        requestId: row.id,
        reference: row.reference,
        status: 'cancelled',
        cancelledAt: (row.cancelledAt ?? row.updatedAt).toISOString(),
      };
    }
    throw new HttpException(
      {
        message:
          kind === 'asked'
            ? 'The request is approved: staff will contact the customer about cancelling'
            : 'The request is already decided',
        code: 'ALREADY_DECIDED',
        statusCode: HttpStatus.CONFLICT,
        status: stateOf(row),
        cancelRequest: cancelRequestOf(row),
      },
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Plan 09 section 12: the owner adds a photo for staff (an item outside the standard categories),
   * one image per call, while the request is undecided (pending, awaiting routing or estimated).
   * The owner is proven as for cancelling. The type comes from the bytes (415 UNSUPPORTED_IMAGE
   * otherwise), at most CS_REQUEST_PHOTOS_MAX per request, counted under the row's lock (409
   * PHOTO_LIMIT). The same key with the same bytes answers the same; with other bytes, 409.
   */
  async addPhoto(
    caller: BookingRequestCaller,
    id: string,
    proof: { channel: CsSenderChannel; subjectId: string } | null,
    idempotencyKey: string,
    bytes: Buffer,
  ): Promise<{ created: boolean; body: CsPhotoUploaded }> {
    const where = provenOwner(caller, id, proof, 'Sending a photo');
    const contentType = imageTypeOf(bytes);
    if (contentType === null || bytes.length > CS_REQUEST_PHOTO_MAX_BYTES)
      throw coded(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'UNSUPPORTED_IMAGE',
        'Send one JPEG, PNG or WebP image of at most 10 MB',
      );
    const digest = createHash('sha256').update(bytes).digest('hex');
    const found = await this.prisma.csBookingRequest.findFirst({ where, select: { id: true } });
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (!found) return null;
      const { branchIds } = await currentKey(tx, caller);
      await tx.$queryRaw`SELECT 1 FROM "cs_booking_requests" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
      const row = await tx.csBookingRequest.findUnique({ where: { id: found.id } });
      if (!row || !servedBy(row, branchIds)) return null;
      const same = await tx.csBookingRequestPhoto.findUnique({
        where: { requestId_idempotencyKey: { requestId: row.id, idempotencyKey } },
        select: { id: true, contentType: true, sizeBytes: true, sha256: true },
      });
      const count = await tx.csBookingRequestPhoto.count({ where: { requestId: row.id } });
      if (same) {
        if (same.sha256 !== digest)
          throw coded(
            HttpStatus.CONFLICT,
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key was used for another photo',
          );
        return { created: false, photo: same, count };
      }
      if (!['pending', 'awaiting_routing', 'estimated'].includes(stateOf(row)))
        throw coded(
          HttpStatus.CONFLICT,
          'ALREADY_DECIDED',
          'Photos are taken only while staff have not decided the request',
        );
      if (count >= CS_REQUEST_PHOTOS_MAX)
        throw coded(
          HttpStatus.CONFLICT,
          'PHOTO_LIMIT',
          `A request takes at most ${CS_REQUEST_PHOTOS_MAX} photos`,
        );
      const photo = await tx.csBookingRequestPhoto.create({
        data: {
          requestId: row.id,
          idempotencyKey,
          contentType,
          sizeBytes: bytes.length,
          sha256: digest,
          content: new Uint8Array(bytes),
        },
        select: { id: true, contentType: true, sizeBytes: true, sha256: true },
      });
      await this.audit.recordApi(tx, {
        branchId: row.branchId,
        entity: 'CS_BOOKING_REQUEST',
        entityId: row.id,
        reference: row.reference,
        action: 'UPDATED',
        changes: [
          { field: 'photos', before: String(count), after: String(count + 1) },
          { field: 'apiClient', before: null, after: caller.client.id },
        ],
      });
      return { created: true, photo, count: count + 1 };
    });
    if (caller.kind === 'customer') {
      await this.tokens.record(
        caller.client.id,
        caller.token.tokenId,
        caller.token.customerId,
        outcome ? 'OK' : 'NOT_FOUND',
        'POST /cs/booking-requests/:id/photos',
      );
    }
    if (!outcome) throw new NotFoundException('Booking request not found');
    return {
      created: outcome.created,
      body: {
        photoId: outcome.photo.id,
        contentType: outcome.photo.contentType as CsRequestPhotoType,
        sizeBytes: outcome.photo.sizeBytes,
        photoCount: outcome.count,
      },
    };
  }

  /**
   * Plan 09 section 12: the owner accepts the estimate it was shown, proven as for cancelling,
   * under the row's lock: before validUntil (409 ESTIMATE_EXPIRED) and for the current version
   * (409 ESTIMATE_CHANGED). The request is pending again with the accepted version, which approval
   * requires. Accepting the same version again answers the same.
   */
  async acceptEstimate(
    caller: BookingRequestCaller,
    id: string,
    proof: { channel: CsSenderChannel; subjectId: string } | null,
    estimateVersion: number,
  ): Promise<CsEstimateAccepted> {
    if (!this.env.CS_ESTIMATES_ENABLED)
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ESTIMATES_UNAVAILABLE',
        'Estimates are not available yet: hand over to staff',
      );
    const where = provenOwner(caller, id, proof, 'Accepting an estimate');
    const found = await this.prisma.csBookingRequest.findFirst({ where, select: { id: true } });
    const row = await this.prisma.$transaction(async (tx) => {
      if (!found) return null;
      const { branchIds } = await currentKey(tx, caller);
      await tx.$queryRaw`SELECT 1 FROM "cs_booking_requests" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
      const current = await tx.csBookingRequest.findUnique({ where: { id: found.id } });
      if (!current || !servedBy(current, branchIds)) return null;
      const now = new Date();
      const state = stateOf(current, now);
      // Accepted already (the same version, still pending): the same answer.
      if (
        state === 'pending' &&
        current.estimateAcceptedVersion === estimateVersion &&
        current.estimateVersion === estimateVersion
      )
        return current;
      if (current.estimateVersion > 0 && current.estimateVersion !== estimateVersion)
        throw coded(
          HttpStatus.CONFLICT,
          'ESTIMATE_CHANGED',
          'Staff changed the estimate: read the request again',
        );
      if (
        current.status === 'ESTIMATED' &&
        (state === 'expired' ||
          current.estimateValidUntil === null ||
          current.estimateValidUntil.getTime() <= now.getTime())
      )
        throw coded(HttpStatus.CONFLICT, 'ESTIMATE_EXPIRED', 'The estimate is no longer valid');
      if (state !== 'estimated')
        throw coded(HttpStatus.CONFLICT, 'ALREADY_DECIDED', 'No estimate awaits the customer');
      const accepted = await tx.csBookingRequest.update({
        where: { id: current.id },
        data: {
          status: 'PENDING',
          estimateAcceptedAt: now,
          estimateAcceptedVersion: estimateVersion,
          version: { increment: 1 },
        },
      });
      await this.audit.recordApi(tx, {
        branchId: current.branchId,
        entity: 'CS_BOOKING_REQUEST',
        entityId: current.id,
        reference: current.reference,
        action: 'UPDATED',
        changes: [
          { field: 'estimateAcceptedVersion', before: null, after: String(estimateVersion) },
          { field: 'apiClient', before: null, after: caller.client.id },
          { field: 'owner', before: null, after: current.ownerRef },
        ],
      });
      return accepted;
    });
    if (caller.kind === 'customer') {
      await this.tokens.record(
        caller.client.id,
        caller.token.tokenId,
        caller.token.customerId,
        row ? 'OK' : 'NOT_FOUND',
        'POST /cs/booking-requests/:id/accept-estimate',
      );
    }
    if (!row) throw new NotFoundException('Booking request not found');
    return { requestId: row.id, status: stateOf(row), acceptedVersion: estimateVersion };
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
   * category and the billable quantity (the CBM, for a volume category), and the pieces and
   * dimensions when the request names them and the quote measured them. The services it priced
   * (MAIN_FREIGHT) are always in a request; the others are staff's to price, so they never make a
   * mismatch.
   */
  /**
   * A request's items by ids (plan 09 section 4): each category active, each quote the key's and
   * for that item; an OTHER item is kept as described. Read before the save, as the one-item shape.
   */
  private async itemsById(
    apiClientId: string,
    input: Pick<CsBookingRequestCreate, 'originId' | 'destinationId'>,
    items: readonly CsRequestItemInput[],
  ): Promise<ItemRow[]> {
    const rows: ItemRow[] = [];
    for (const [index, item] of items.entries()) {
      const lineNo = index + 1;
      if ('kind' in item) {
        rows.push(otherRow(lineNo, item));
        continue;
      }
      const category = await this.masterData.requirePriceCategory(item.category, null);
      if (item.quoteRef !== undefined)
        await this.checkQuote(apiClientId, { ...input, ...item, category: category.code });
      rows.push({
        lineNo,
        priceCategoryCode: category.code,
        quantity: dec(item.quantity),
        quoteRef: item.quoteRef ?? null,
        ...measuresOf(item),
      });
    }
    return rows;
  }

  private async checkQuote(
    apiClientId: string,
    input: Pick<
      CsBookingRequestCreate,
      'originId' | 'destinationId' | 'quoteRef' | 'pieces' | 'lengthCm' | 'widthCm' | 'heightCm'
    > & {
      category: string;
      quantity: string;
    },
  ): Promise<void> {
    const quote = await this.prisma.csQuote.findFirst({
      where: { ref: input.quoteRef, apiClientId },
    });
    const sameMeasure = (sent: string | undefined, kept: Prisma.Decimal | null) =>
      sent === undefined || kept === null || kept.eq(dec(sent));
    const same =
      quote !== null &&
      quote.originLocationId === input.originId &&
      quote.destinationLocationId === input.destinationId &&
      quote.priceCategoryCode === input.category &&
      quote.quantity !== null &&
      quote.quantity.eq(dec(input.quantity)) &&
      (input.pieces === undefined || quote.pieces === null || quote.pieces === input.pieces) &&
      sameMeasure(input.lengthCm, quote.lengthCm) &&
      sameMeasure(input.widthCm, quote.widthCm) &&
      sameMeasure(input.heightCm, quote.heightCm);
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
 * cs:booking_requests:create, and, for a customer token, a grant that still holds. Its branches
 * and the services its bot offers now.
 */
/**
 * Plan 09 sections 2 and 12: the request of a proven owner, never an asserted one: a customer
 * token's own request, or a signed channel identity (plan 08) whose subject is its sender. The key
 * alone is no proof: 403 OWNER_PROOF_REQUIRED.
 */
function provenOwner(
  caller: BookingRequestCaller,
  id: string,
  proof: { channel: CsSenderChannel; subjectId: string } | null,
  what: string,
): Prisma.CsBookingRequestWhereInput {
  return { id, ...provenOwnerOf(caller, proof, what) };
}

/** The proven owner's requests (any id): as provenOwner, the key alone is no proof. */
function provenOwnerOf(
  caller: BookingRequestCaller,
  proof: { channel: CsSenderChannel; subjectId: string } | null,
  what: string,
): Prisma.CsBookingRequestWhereInput {
  if (caller.kind === 'customer')
    return { apiClientId: caller.client.id, ownerRef: ownerRef(caller) };
  if (proof)
    return {
      apiClientId: caller.client.id,
      senderChannel: proof.channel,
      senderId: proof.subjectId,
    };
  throw coded(
    HttpStatus.FORBIDDEN,
    'OWNER_PROOF_REQUIRED',
    `${what} needs the customer token or a signed channel identity of the sender`,
  );
}

export async function currentKey(
  tx: Prisma.TransactionClient,
  caller: BookingRequestCaller,
): Promise<{ branchIds: string[]; services: CsRequestService[] }> {
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
  return { branchIds: key.branches.map((b) => b.branchId), services: keyServices(key) };
}

function conflict(): HttpException {
  return coded(
    HttpStatus.CONFLICT,
    'IDEMPOTENCY_CONFLICT',
    'This idempotency key was used for another request',
  );
}

/**
 * Which request a caller may read (section 7.2): its owner through the key that made it;
 * a request by names belongs to the key itself (its bot names no sender to read by), never to a
 * customer token the key issued (F126-5). Matches nothing when the caller names no owner.
 */
function ownedWhere(
  caller: BookingRequestCaller,
  id: string,
  sender: { channel: CsSenderChannel; id: string } | null,
): Prisma.CsBookingRequestWhereInput {
  const owner = caller.kind === 'customer' ? ownerRef(caller) : sender && ownerRef(caller, sender);
  const mine = owner === null ? null : { id, apiClientId: caller.client.id, ownerRef: owner };
  const byKey =
    caller.kind === 'key'
      ? { id, apiClientId: caller.client.id, botNames: { not: Prisma.AnyNull } }
      : null;
  const where = [mine, byKey].filter((w) => w !== null);
  return where.length === 0 ? { id: { in: [] } } : { OR: where };
}

function cancelRequestOf(row: CsBookingRequest): CsCancelRequestDto | null {
  return row.cancelRequestedAt === null
    ? null
    : {
        requestedAt: row.cancelRequestedAt.toISOString(),
        closedAt: row.cancelRequestClosedAt?.toISOString() ?? null,
      };
}

function createdBody(row: CsBookingRequest): CsBookingRequestCreated {
  return { requestId: row.id, status: stateOf(row), reference: row.reference };
}

/** Plan 09e section 2: the other sender's columns, from the bot's explicit marker. */
function otherSenderData(other: CsOtherSender | undefined): {
  otherSenderName: string | null;
  otherSenderPhone: string | null;
} {
  return { otherSenderName: other?.name.trim() ?? null, otherSenderPhone: other?.phone ?? null };
}
