import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BookingDraftCreateRequest,
  BookingDraftDto,
  BookingDraftListItemDto,
  BookingDraftRequest,
  BookingFromQuotationRequest,
  BookingItemInput,
  CreateBookingRequest,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import {
  decimalKey,
  draftExpiry,
  draftStatus,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import { DraftsService, keyReused, lockDraftRow } from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BookingsService, type PreparedBooking } from './bookings.service.js';

const LABEL = 'booking draft';
const ASSISTANT_ONLY = 'Booking drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a booking draft';

const details = {
  items: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  sourceQuotation: { select: { number: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  booking: { select: { number: true } },
} satisfies Prisma.BookingDraftInclude;

type DraftRow = Prisma.BookingDraftGetPayload<{ include: typeof details }>;

type DirectRequest = CreateBookingRequest;
type FromQuotationRequest = BookingFromQuotationRequest & { quotationId: string };

function isFromQuotation(
  input: DirectRequest | FromQuotationRequest,
): input is FromQuotationRequest {
  return 'quotationId' in input && typeof input.quotationId === 'string';
}

function storedItems(items: readonly BookingItemInput[] | undefined) {
  const decimal = (v: string | null | undefined) => (v === null || v === undefined ? null : dec(v));
  return (items ?? []).map((item, i) => ({
    lineNo: i + 1,
    cargoType: item.cargoType,
    containerTypeCode: item.containerTypeCode ?? null,
    description: item.description ?? null,
    quantity: item.quantity,
    lengthCm: decimal(item.lengthCm),
    widthCm: decimal(item.widthCm),
    heightCm: decimal(item.heightCm),
    weightKg: decimal(item.weightKg),
    volumeCbm: decimal(item.volumeCbm),
  }));
}

type StoredItem = ReturnType<typeof storedItems>[number];

function itemInput(item: StoredItem): BookingItemInput {
  return {
    cargoType: item.cargoType,
    containerTypeCode: item.containerTypeCode,
    description: item.description,
    quantity: item.quantity,
    lengthCm: toDecimalStringOrNull(item.lengthCm),
    widthCm: toDecimalStringOrNull(item.widthCm),
    heightCm: toDecimalStringOrNull(item.heightCm),
    weightKg: toDecimalStringOrNull(item.weightKg),
    volumeCbm: toDecimalStringOrNull(item.volumeCbm),
  };
}

/** The request a stored draft proposes, in the shape BookingsService takes. */
export function requestOf(d: DraftRow): BookingDraftRequest {
  const parties = {
    shipperId: d.shipperId,
    consigneeId: d.consigneeId,
    notifyPartyId: d.notifyPartyId,
    requestedDeparture: d.requestedDeparture ? fromDbDate(d.requestedDeparture) : null,
    specialInstructions: d.specialInstructions,
    items: d.items.map(itemInput),
  };
  if (d.sourceQuotationId) {
    return {
      quotationId: d.sourceQuotationId,
      quotationNumber: d.sourceQuotation?.number ?? '',
      services: d.services,
      ...parties,
    };
  }
  // The source check (migration) guarantees route and cargo on a direct draft.
  if (!d.originLocationId || !d.destinationLocationId || !d.mode || !d.cargoType) {
    throw new Error(`Booking draft ${d.id} has no route or cargo`);
  }
  return {
    customerId: d.customerId,
    originLocationId: d.originLocationId,
    destinationLocationId: d.destinationLocationId,
    mode: d.mode,
    loadType: d.loadType,
    cargoType: d.cargoType,
    cargoDescription: d.cargoDescription,
    services: d.services,
    ...parties,
  };
}

/** sha256 of the normalised request: decimals canonical, missing and null alike, keys sorted. */
export function bookingRequestHash(input: DirectRequest | FromQuotationRequest): string {
  const lower = (v: string | null | undefined) => v?.toLowerCase() ?? null;
  const common = {
    services: input.services ? [...new Set(input.services)].sort() : null,
    shipperId: lower(input.shipperId),
    consigneeId: lower(input.consigneeId),
    notifyPartyId: lower(input.notifyPartyId),
    requestedDeparture: input.requestedDeparture ?? null,
    specialInstructions: input.specialInstructions ?? null,
    items: storedItems(input.items).map((i) => ({
      ...i,
      containerTypeCode: i.containerTypeCode,
      lengthCm: decimalKey(i.lengthCm),
      widthCm: decimalKey(i.widthCm),
      heightCm: decimalKey(i.heightCm),
      weightKg: decimalKey(i.weightKg),
      volumeCbm: decimalKey(i.volumeCbm),
    })),
  };
  if (isFromQuotation(input)) {
    return requestHash({
      kind: 'QUOTATION',
      quotationId: input.quotationId.toLowerCase(),
      ...common,
    });
  }
  return requestHash({
    kind: 'DIRECT',
    customerId: input.customerId.toLowerCase(),
    originLocationId: input.originLocationId.toLowerCase(),
    destinationLocationId: input.destinationLocationId.toLowerCase(),
    mode: input.mode,
    loadType: input.loadType ?? null,
    cargoType: input.cargoType,
    cargoDescription: input.cargoDescription ?? null,
    ...common,
  });
}

/**
 * Booking drafts proposed by the staff AI assistant (entry drafts, src/drafts): from an approved
 * quotation or directly for a customer. A person approves (an ordinary DRAFT booking is created
 * through BookingsService in the same transaction, with that person's permissions and branches:
 * not confirmed, no shipment) or rejects. Access follows the customer's branch.
 */
@Injectable()
export class BookingDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly drafts: DraftsService,
  ) {}

  async create(user: AuthUser, body: BookingDraftCreateRequest): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...input } = body;
    // What NOLON would check on a real create, for this user now; nothing is written.
    const prepared = await this.prepare(user, input);
    const hash = bookingRequestHash(input);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const fromQuotation = isFromQuotation(input);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.bookingDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        const draft = await tx.bookingDraft.create({
          data: {
            ...scope,
            branchId: prepared.branchId,
            customerId: prepared.customerId,
            sourceQuotationId: prepared.quotationId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            ...(fromQuotation
              ? {}
              : {
                  originLocationId: input.originLocationId,
                  destinationLocationId: input.destinationLocationId,
                  mode: input.mode,
                  loadType: input.loadType ?? null,
                  cargoType: input.cargoType,
                  cargoDescription: input.cargoDescription ?? null,
                }),
            services: prepared.header.services,
            shipperId: input.shipperId ?? null,
            consigneeId: input.consigneeId ?? null,
            notifyPartyId: input.notifyPartyId ?? null,
            requestedDeparture: input.requestedDeparture
              ? toDbDate(input.requestedDeparture)
              : null,
            specialInstructions: input.specialInstructions ?? null,
          },
          select: { id: true },
        });
        const items = storedItems(input.items);
        if (items.length > 0) {
          await tx.bookingDraftItem.createMany({
            data: items.map((item) => ({ ...item, draftId: draft.id })),
          });
        }
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.bookingDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Booking draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<BookingDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.bookingDraft.findMany({
      where: { ...branchScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return drafts.map((d) => reviewFields(d, user, now));
  }

  async get(user: AuthUser, id: string): Promise<BookingDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return toDto(draft, user, now, check);
  }

  /**
   * A person approves the version they reviewed: the booking is created through BookingsService
   * with their permissions and branches, in the same transaction as the approval. Approving an
   * approved draft returns it as it is, without a second booking.
   */
  async approve(user: AuthUser, id: string, version: number): Promise<BookingDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    const prepared = await this.prepare(user, serviceRequest(requestOf(current)));
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'booking_drafts', id);
      if (!locked) throw new NotFoundException('Booking draft not found');
      if (locked.state === 'APPROVED') return;
      requireOpen(locked, version, LABEL);
      const bookingId = await this.bookings.insertInTx(tx, user, prepared);
      await tx.bookingDraft.update({
        where: { id },
        data: {
          state: 'APPROVED',
          bookingId,
          decidedById: user.id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<BookingDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'booking_drafts', id);
      if (!locked) throw new NotFoundException('Booking draft not found');
      requireOpen(locked, input.version, LABEL);
      await tx.bookingDraft.update({
        where: { id },
        data: {
          state: 'REJECTED',
          rejectReason: input.reason,
          decidedById: user.id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  private prepare(
    user: AuthUser,
    input: DirectRequest | FromQuotationRequest,
  ): Promise<PreparedBooking> {
    if (isFromQuotation(input)) {
      const { quotationId, ...rest } = input;
      return this.bookings.prepareFromQuotation(user, quotationId, rest);
    }
    return this.bookings.prepareCreate(user, input);
  }

  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    try {
      await this.prepare(user, serviceRequest(requestOf(draft)));
      return { ok: true, total: null, currency: null };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.bookingDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Booking draft not found');
    return draft;
  }
}

/** The stored request without its display-only fields. */
function serviceRequest(request: BookingDraftRequest): DirectRequest | FromQuotationRequest {
  if (request.quotationId === undefined) return request;
  return {
    quotationId: request.quotationId,
    services: request.services,
    shipperId: request.shipperId,
    consigneeId: request.consigneeId,
    notifyPartyId: request.notifyPartyId,
    requestedDeparture: request.requestedDeparture,
    specialInstructions: request.specialInstructions,
    items: request.items,
  };
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.items.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

function toDto(
  d: DraftRow,
  user: AuthUser,
  now: Date,
  check: EntryDraftCheck | null,
): BookingDraftDto {
  return { ...baseFields(d, user, now), request: requestOf(d), check };
}

function reviewFields(d: DraftRow, user: AuthUser, now: Date): BookingDraftListItemDto {
  return {
    ...baseFields(d, user, now),
    lineCount: d.items.length,
    sourceQuotationNumber: d.sourceQuotation?.number ?? null,
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<BookingDraftDto, 'request' | 'check'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('bookings:create');
  return {
    id: d.id,
    branchId: d.branchId,
    customerId: d.customerId,
    customerName: d.customer.name,
    subject: d.customer.name,
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: false, canDecide: open },
    bookingId: d.bookingId,
    bookingNumber: d.booking?.number ?? null,
  };
}
