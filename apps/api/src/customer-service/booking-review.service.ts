import { CustomersService } from '../customers/customers.service.js';
import { CustomerIdentityService } from './customer-identity.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CS_ESTIMATE_MAX_DAYS, loadTypeOf } from '@nolon/shared';
import type {
  BookingItemInput,
  CargoType,
  RateUnit,
  CsApprovalPriceDto,
  CsApproveRequest,
  CsBookingRequestStaffDto,
  CsDropOffChoiceDto,
  CsEstimateRequest,
  CsEstimateTerms,
  CsRequestPhotoType,
  CsPriceInputs,
  CsBookingRequestSummaryDto,
  CsName,
  CsRejectReasonDto,
  CsRejectReasonInput,
  CsRequestItemDto,
  CsResolveItem,
  CsSetDropOff,
  CsRejectRequest,
  CsReviewFilter,
  CsCloseCancelRequest,
  CsRouteRequest,
  CsSenderChannel,
  CreateBookingRequest,
  Permission,
} from '@nolon/shared';
import { AuditService, codeEntityId } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { fromDbDateOrNull, todayIn, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import { CsEventsService } from './cs-events.service.js';
import { BOOKED } from './customer-stages.js';
import { BookingConfirmChecksRegistry } from '../bookings/booking-confirm-checks.registry.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { cbmFromDimensions } from '../bookings/cbm.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import {
  type CsBookingRequest,
  type CsBookingRequestItem,
  type CsBookingRequestStatus,
  type CsQuote,
  Prisma,
} from '../generated/prisma/client.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { stateOf } from './booking-requests.service.js';
import { type EstimateTerms, estimateOf, storedTerms } from './estimates.js';
import { type ApprovalPrice, QuoteService } from './quote.service.js';

type Tx = Prisma.TransactionClient;

/** The most requests a staff list shows at once (newest first). */
const LIST_LIMIT = 200;

const VIEW: Permission = 'cs_booking_requests:view';
const ROUTE: Permission = 'cs_booking_requests:update';
const DECIDE: Permission = 'cs_booking_requests:approve';

type Row = CsBookingRequest & {
  customer: { number: string } | null;
  booking: {
    number: string;
    items: {
      id: string;
      lineNo: number;
      cargoType: string;
      quantity: number;
      description: string | null;
    }[];
  } | null;
  items: CsBookingRequestItem[];
  dropOff: CsDropOffChoiceDto | null;
  photos: { id: string; contentType: string; sizeBytes: number; createdAt: Date }[];
};
type QuotedRow = Row & { quote: CsQuote | null };

const rowInclude = {
  customer: { select: { number: true } },
  booking: {
    select: {
      number: true,
      items: {
        orderBy: { lineNo: 'asc' },
        select: { id: true, lineNo: true, cargoType: true, quantity: true, description: true },
      },
    },
  },
  items: { orderBy: { lineNo: 'asc' } },
  dropOff: { select: { id: true, branchId: true, code: true, nameAr: true, nameEn: true } },
  // Plan 09 section 12: the photos' details only; staff fetch each one's bytes on its own.
  photos: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, contentType: true, sizeBytes: true, createdAt: true },
  },
} as const;
const withQuote = { ...rowInclude, quote: true } as const;

/** Staff have not decided these (plan 09 section 12: an estimate awaits the customer too). */
const UNDECIDED: CsBookingRequestStatus[] = ['PENDING', 'AWAITING_ROUTING', 'ESTIMATED'];

function undecided(r: Pick<CsBookingRequest, 'status' | 'expiresAt'>, now = new Date()): boolean {
  return UNDECIDED.includes(r.status) && r.expiresAt.getTime() > now.getTime();
}

/**
 * Whether `user` may see a request (plan 04a section 3; Codex F131-1): one with a branch, when they
 * hold VIEW there; one awaiting routing, when they may route or decide it in one of the branches
 * it may go to. Per row and per branch from the person's access, never from a route's narrowed
 * branch list, so a branch where they may only route it still counts.
 */
export function visibleTo(
  user: AuthUser,
  r: Pick<CsBookingRequest, 'branchId' | 'allowedBranchIds'>,
): boolean {
  if (r.branchId !== null) return user.access.has(VIEW, r.branchId);
  return r.allowedBranchIds.some((b) => user.access.has(ROUTE, b) || user.access.has(DECIDE, b));
}

/** Whether `user` may use the review screen at all: VIEW, ROUTE or DECIDE in some branch. */
export function mayReview(user: AuthUser): boolean {
  return [VIEW, ROUTE, DECIDE].some((p) => user.access.any(p));
}

/**
 * The branches of a request where `user` may decide it: its branch, or (awaiting routing) the
 * branches it may go to.
 */
function decideBranches(
  user: AuthUser,
  r: Pick<CsBookingRequest, 'branchId' | 'allowedBranchIds'>,
): string[] {
  const candidates = r.branchId !== null ? [r.branchId] : r.allowedBranchIds;
  return candidates.filter((b) => user.access.has(DECIDE, b));
}

/**
 * Staff review of the bot's booking requests (plan 04a, R3-ج1): the list of the staff member's
 * branches, a request with its advisory price check, routing a request awaiting routing to one of
 * its branches, and rejection with an approved reason. Each write rechecks, in its transaction
 * with the request row locked: the version (409 when stale), the state (undecided and not expired),
 * the person's permission in the branch, and that the key that made the request is still active
 * and serves that branch. Approval is the booking form's (R3-ج2).
 */
@Injectable()
export class BookingReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: QuoteService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly currencies: CurrenciesService,
    private readonly identities: CustomerIdentityService,
    private readonly customers: CustomersService,
    private readonly masterData: MasterDataService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    confirmChecks: BookingConfirmChecksRegistry,
    private readonly events: CsEventsService,
  ) {
    confirmChecks.register((tx, bookingId) => requireCargoComplete(tx, bookingId));
  }

  async list(user: AuthUser, filter: CsReviewFilter): Promise<CsBookingRequestSummaryDto[]> {
    const now = new Date();
    const viewable = user.access.branchesWith([VIEW]);
    const routable = user.access
      .branchIds()
      .filter((b) => user.access.has(ROUTE, b) || user.access.has(DECIDE, b));
    const status: Prisma.CsBookingRequestWhereInput =
      filter === 'open'
        ? { status: { in: UNDECIDED }, expiresAt: { gt: now } }
        : filter === 'expired'
          ? { status: { in: UNDECIDED }, expiresAt: { lte: now } }
          : filter === 'pending' || filter === 'awaiting_routing' || filter === 'estimated'
            ? {
                status:
                  filter === 'pending'
                    ? 'PENDING'
                    : filter === 'estimated'
                      ? 'ESTIMATED'
                      : 'AWAITING_ROUTING',
                expiresAt: { gt: now },
              }
            : filter === 'cancel_requested'
              ? {
                  status: 'APPROVED',
                  cancelRequestedAt: { not: null },
                  cancelRequestClosedAt: null,
                }
              : {
                  status:
                    filter === 'approved'
                      ? 'APPROVED'
                      : filter === 'cancelled'
                        ? 'CANCELLED'
                        : 'REJECTED',
                };
    const rows = await this.prisma.csBookingRequest.findMany({
      where: {
        AND: [
          status,
          {
            OR: [
              { branchId: { in: viewable } },
              { branchId: null, allowedBranchIds: { hasSome: routable } },
            ],
          },
        ],
      },
      include: rowInclude,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.filter((r) => visibleTo(user, r)).map((r) => summary(r, now));
  }

  async detail(user: AuthUser, id: string): Promise<CsBookingRequestStaffDto> {
    const row = await this.prisma.csBookingRequest.findUnique({
      where: { id },
      include: withQuote,
    });
    if (!row || !visibleTo(user, row)) throw new NotFoundException('Booking request not found');
    return this.format(user, row);
  }

  /** A request as staff see it, with the advisory price check of its quote. */
  private async format(user: AuthUser, row: QuotedRow): Promise<CsBookingRequestStaffDto> {
    const priceCheck = row.quote
      ? await this.quotes.recheck(row.quote, row.quantity, row.branchId)
      : null;
    const dto = staffDto(user, row, priceCheck);
    // Plan 09 section 12: a request with an OTHER item, undecided, in a branch where they decide.
    dto.actions.canEstimate =
      this.env.CS_ESTIMATES_ENABLED &&
      undecided(row) &&
      (row.status === 'PENDING' || row.status === 'ESTIMATED') &&
      row.branchId !== null &&
      user.access.has(DECIDE, row.branchId) &&
      row.items.some((i) => i.isOther);
    // Plan 09 section 11: the points staff may name, while they may approve or correct.
    // Both actions need DECIDE in the request's branch, and a point is named from that branch only.
    if ((dto.actions.canApprove || dto.actions.canSetDropOff) && row.branchId !== null)
      dto.dropOffChoices = await this.prisma.warehouse.findMany({
        where: { isActive: true, acceptsDropOff: true, branchId: row.branchId },
        orderBy: { code: 'asc' },
        select: { id: true, branchId: true, code: true, nameAr: true, nameEn: true },
      });
    // The request's ordinary branch permission authorises only its linked profile's minimum.
    const profile = row.profileId
      ? await this.prisma.customerProfile.findUnique({
          where: { id: row.profileId },
          select: {
            id: true,
            number: true,
            name: true,
            phone: true,
            phoneVerified: true,
            needsReview: true,
            version: true,
          },
        })
      : null;
    return { ...dto, profile };
  }

  /** Plan 04a section 3: AWAITING_ROUTING to PENDING, at one of its branches the key still serves. */
  async route(
    user: AuthUser,
    id: string,
    input: CsRouteRequest,
  ): Promise<CsBookingRequestStaffDto> {
    const written = await this.prisma.$transaction(async (tx) => {
      const row = await lockRequest(tx, user, id, input.version);
      if (row.status !== 'AWAITING_ROUTING') {
        throw new ConflictException('Only a request awaiting routing is routed');
      }
      if (
        !row.allowedBranchIds.includes(input.branchId) ||
        !user.access.has(ROUTE, input.branchId)
      ) {
        throw new ForbiddenException('You may not route this request to that branch');
      }
      await requireKeyServes(tx, row.apiClientId, input.branchId);
      return tx.csBookingRequest.update({
        where: { id },
        data: {
          status: 'PENDING',
          branchId: input.branchId,
          routedById: user.id,
          routedAt: new Date(),
          version: { increment: 1 },
        },
        include: withQuote,
      });
    });
    // The row as this transaction wrote it (Codex F131-1, F131-3): routing to a branch where the
    // person may not view still answers with what they wrote, and never with a later version.
    return this.format(user, written);
  }

  /**
   * Plan 04a section 3: an undecided request to REJECTED, with an active approved reason the
   * customer reads; the internal note stays with staff. One awaiting routing is rejected for the
   * branch of the person who rejects it (the first of its branches they decide in).
   */
  /**
   * Plan 09 section 12: staff price a request with an item outside the standard categories, for
   * the customer to accept. With the request locked: its version, undecided and not expired,
   * pending or estimated, with a branch where the person decides, and an OTHER item. The amount
   * above zero in an active currency; valid after now and at most CS_ESTIMATE_MAX_DAYS ahead, and
   * the request expires with it. Each estimate is a new version and clears an earlier acceptance
   * (Codex F165-2): an acceptance never covers a price it did not see. Audited.
   */
  async estimate(
    user: AuthUser,
    id: string,
    input: CsEstimateRequest,
  ): Promise<CsBookingRequestStaffDto> {
    if (!this.env.CS_ESTIMATES_ENABLED)
      throw new ServiceUnavailableException({
        code: 'ESTIMATES_UNAVAILABLE',
        message: 'Estimates are not switched on yet',
      });
    const amount = dec(input.amount);
    if (!amount.isFinite() || amount.lte(0))
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: 'The amount must be above zero',
      });
    const validUntil = new Date(input.validUntil);
    const now = new Date();
    if (
      Number.isNaN(validUntil.getTime()) ||
      validUntil.getTime() <= now.getTime() ||
      validUntil.getTime() > now.getTime() + CS_ESTIMATE_MAX_DAYS * 86_400_000
    )
      throw new BadRequestException({
        code: 'INVALID_VALID_UNTIL',
        message: `The estimate is valid after now and at most ${CS_ESTIMATE_MAX_DAYS} days ahead`,
      });
    await this.currencies.requireActive(input.currency);
    // Codex F171-2: staff set the terms the estimate prices, a route of two active places.
    const route: CsEstimateTerms = {
      originId: input.terms.originId.toLowerCase(),
      destinationId: input.terms.destinationId.toLowerCase(),
      mode: input.terms.mode,
      loadType: input.terms.loadType ?? null,
    };
    await this.masterData.requireRoute(route.originId, route.destinationId);
    const written = await this.prisma.$transaction(async (tx) => {
      const row = await lockRequest(tx, user, id, input.version);
      if ((row.status !== 'PENDING' && row.status !== 'ESTIMATED') || row.branchId === null)
        throw new ConflictException('Only a pending request with a branch is estimated');
      if (!user.access.has(DECIDE, row.branchId))
        throw new ForbiddenException('You may not price this request');
      const items = await tx.csBookingRequestItem.findMany({
        where: { requestId: id },
        orderBy: { lineNo: 'asc' },
      });
      if (!items.some((i) => i.isOther))
        throw new ConflictException({
          code: 'ESTIMATE_NOT_NEEDED',
          message: 'Only a request with an item outside the standard categories is estimated',
        });
      await requireKeyServes(tx, row.apiClientId, row.branchId);
      await this.currencies.requireActiveInTx(tx, input.currency);
      await this.masterData.requireLocationInTx(tx, route.originId);
      await this.masterData.requireLocationInTx(tx, route.destinationId);
      const terms = estimateTermsOf(route, row.services, items);
      const version = row.estimateVersion + 1;
      await this.audit.record(tx, user, {
        branchId: row.branchId,
        entity: 'CS_BOOKING_REQUEST',
        entityId: row.id,
        reference: row.reference,
        action: 'UPDATED',
        changes: [
          {
            field: 'estimate',
            before:
              row.estimateAmount === null
                ? null
                : `v${row.estimateVersion} ${toDecimalString(row.estimateAmount)} ${row.estimateCurrency ?? ''}`,
            after: `v${version} ${toDecimalString(amount)} ${input.currency}`,
          },
          {
            field: 'estimateValidUntil',
            before: row.estimateValidUntil?.toISOString() ?? null,
            after: validUntil.toISOString(),
          },
          {
            field: 'estimateTerms',
            before: row.estimateTerms === null ? null : JSON.stringify(row.estimateTerms),
            after: JSON.stringify(terms),
          },
        ],
      });
      const estimated = await tx.csBookingRequest.update({
        where: { id },
        data: {
          status: 'ESTIMATED',
          estimateAmount: amount,
          estimateCurrency: input.currency,
          estimateNoteAr: input.noteAr?.trim() || null,
          estimateNoteEn: input.noteEn?.trim() || null,
          estimateValidUntil: validUntil,
          estimateVersion: version,
          estimatedById: user.id,
          estimatedAt: now,
          estimateAcceptedAt: null,
          estimateAcceptedVersion: null,
          estimateTerms: termsJson(terms),
          // The request lives as long as its estimate (plan 09 section 12).
          expiresAt: validUntil,
          version: { increment: 1 },
        },
        include: withQuote,
      });
      await this.events.emitInTx(tx, estimated, ['request.estimated'], now);
      return estimated;
    });
    return this.format(user, written);
  }

  /**
   * Plan 09 section 12: a photo the customer sent, for staff who may view the request in its
   * branch (or route it while unrouted), as visibleTo decides.
   */
  async photo(
    user: AuthUser,
    id: string,
    photoId: string,
  ): Promise<{ contentType: string; content: Uint8Array }> {
    const row = await this.prisma.csBookingRequest.findUnique({ where: { id } });
    if (!row || !visibleTo(user, row)) throw new NotFoundException('Booking request not found');
    const photo = await this.prisma.csBookingRequestPhoto.findFirst({
      where: { id: photoId, requestId: id },
      select: { contentType: true, content: true },
    });
    if (!photo) throw new NotFoundException('Photo not found');
    return photo;
  }

  async reject(
    user: AuthUser,
    id: string,
    input: CsRejectRequest,
  ): Promise<CsBookingRequestStaffDto> {
    const written = await this.prisma.$transaction(async (tx) => {
      const row = await lockRequest(tx, user, id, input.version);
      const branchId = decideBranches(user, row).sort()[0];
      if (branchId === undefined) throw new ForbiddenException('You may not decide this request');
      await requireKeyServes(tx, row.apiClientId, branchId);
      const reasons = await tx.$queryRaw<{ code: string }[]>`
        SELECT "code" FROM "cs_reject_reasons"
        WHERE "code" = ${input.reasonCode} AND "is_active" FOR SHARE`;
      if (reasons.length === 0) {
        throw new ConflictException(`Unknown or inactive reason: ${input.reasonCode}`);
      }
      const rejected = await tx.csBookingRequest.update({
        where: { id },
        data: {
          status: 'REJECTED',
          branchId,
          rejectReasonCode: input.reasonCode,
          internalNote: input.internalNote ?? null,
          decidedById: user.id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
        include: withQuote,
      });
      await this.events.emitInTx(tx, rejected, ['request.rejected']);
      return rejected;
    });
    // As route: the row this transaction wrote.
    return this.format(user, written);
  }

  /**
   * Plan 09 section 2: staff mark a customer's cancel ask on an approved request as handled (they
   * cancelled the booking with its own route, or talked the customer out of it). The request stays
   * approved; only the ask closes. The request's version, locked; approve in its branch.
   */
  async closeCancelRequest(
    user: AuthUser,
    id: string,
    input: CsCloseCancelRequest,
  ): Promise<CsBookingRequestStaffDto> {
    const written = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "cs_booking_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const row = await tx.csBookingRequest.findUnique({ where: { id } });
      if (!row || !visibleTo(user, row)) throw new NotFoundException('Booking request not found');
      if (row.version !== input.version) {
        throw new ConflictException('The request changed: open it again');
      }
      if (
        row.status !== 'APPROVED' ||
        row.cancelRequestedAt === null ||
        row.cancelRequestClosedAt !== null
      ) {
        throw new ConflictException('There is no open cancel ask on this request');
      }
      if (row.branchId === null || !user.access.has(DECIDE, row.branchId)) {
        throw new ForbiddenException('You may not decide this request');
      }
      const closed = await tx.csBookingRequest.update({
        where: { id },
        data: {
          cancelRequestClosedAt: new Date(),
          cancelRequestClosedById: user.id,
          version: { increment: 1 },
        },
        include: withQuote,
      });
      await this.audit.record(tx, user, {
        branchId: row.branchId,
        entity: 'CS_BOOKING_REQUEST',
        entityId: row.id,
        reference: row.reference,
        action: 'UPDATED',
        changes: [{ field: 'cancelRequestClosedAt', before: null, after: 'closed' }],
      });
      return closed;
    });
    return this.format(user, written);
  }

  /**
   * The engine's price for an approval's inputs (plan 04a section 1), for a request `user` may
   * approve, in its branch. The screen shows it and sends its fingerprint back on approval.
   */
  async price(user: AuthUser, id: string, inputs: CsPriceInputs): Promise<CsApprovalPriceDto> {
    const row = await this.prisma.csBookingRequest.findUnique({ where: { id } });
    if (!row || !visibleTo(user, row)) throw new NotFoundException('Booking request not found');
    if (row.branchId === null || decideBranches(user, row).length === 0) {
      throw new ForbiddenException('You may not approve this request');
    }
    return (await this.quotes.priceFor(inputs, row.branchId)).dto;
  }

  /**
   * Plan 04a section 3 (R3-ج2): the booking made through the ordinary create checks, with the
   * person's permissions, and the request approved, in one transaction. Inside it, with the
   * request row locked: the version, the state (PENDING, not expired), the booking in the
   * request's branch and (a request of a customer) for that customer, the person's approve
   * permission there, the key still active and serving it, the payment and pricing currencies
   * active, and the price again (requireSamePrice). The booking is the cargo priced (Codex F137-1):
   * route, mode, cargo and load type from the pricing inputs, no line; the request keeps what was
   * priced. Any refusal makes neither the booking nor the approval.
   */
  async approve(
    user: AuthUser,
    id: string,
    input: CsApproveRequest,
  ): Promise<CsBookingRequestStaffDto> {
    await this.currencies.requireActive(input.paymentCurrency);
    const initial = await this.prisma.csBookingRequest.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNo: 'asc' } } },
    });
    if (!initial || !visibleTo(user, initial))
      throw new NotFoundException('Booking request not found');
    // Plan 09 section 4: one priced line per standard item (or the one-item shape's pricing).
    // Plan 09 section 12: a request with an OTHER item is approved at the estimate the customer
    // accepted (checked again under the lock), never at an engine price.
    const estimated = initial.items.some((i) => i.isOther);
    if (estimated && !estimateAccepted(initial)) throw estimateRequired();
    // Codex F171-2: checked first here for a clear answer, and again under the lock.
    if (estimated) requireEstimateTerms(initial.estimateTerms, input, initial.items);
    const lines = approvalLines(input, initial.items);
    // F137-1: the booking is the cargo priced, its route, mode, cargo and load type the inputs'.
    const cargos = await Promise.all(
      lines.map((l) =>
        l.inputs
          ? this.quotes.cargoOf(l.inputs)
          : Promise.resolve({
              category: null,
              cargoType: 'GENERAL' as const,
              unit: 'PER_PIECE' as const,
              loadType: input.pricing.loadType ?? loadTypeOf(input.pricing.mode, 'GENERAL'),
            }),
      ),
    );
    const loadTypes = new Set(cargos.map((c) => c.loadType));
    if (loadTypes.size > 1)
      throw new UnprocessableEntityException({
        code: 'MIXED_LOAD',
        message: 'The items need different load types: book them separately',
      });
    const cargoTypes = new Set(cargos.map((c) => c.cargoType));
    // Plan 09 section 4: an item becomes a booking line only when its count is certain.
    const made = lines.flatMap((line, index) => {
      const cargo = cargos[index]!;
      // Codex F167-1: the line books what was priced, the approved category and quantity.
      const item = !line.item
        ? null
        : line.inputs && cargo.category !== null
          ? bookingLineOf(
              line.item,
              { ...cargo, category: cargo.category },
              dec(line.inputs.quantity),
            )
          : line.item.isOther
            ? otherLineOf(line.item)
            : null;
      return item && line.item ? [{ itemId: line.item.id, item }] : [];
    });
    const booking: Omit<CreateBookingRequest, 'customerId'> & { customerId?: string } = {
      ...input.booking,
      originLocationId: input.pricing.originId,
      destinationLocationId: input.pricing.destinationId,
      mode: input.pricing.mode,
      loadType: cargos[0]!.loadType,
      cargoType: cargoTypes.size === 1 ? cargos[0]!.cargoType : 'GENERAL',
      items: made.map((m) => m.item),
    };
    if (!initial.profileId && !booking.customerId)
      throw new BadRequestException('Choose the booking customer');
    const prepareProfile =
      initial.profileId && initial.branchId
        ? await this.bookings.prepareForNewCustomer(booking, initial.branchId)
        : null;
    const legacyPrepared = !initial.profileId
      ? await this.bookings.prepareCreate(user, { ...booking, customerId: booking.customerId! })
      : null;
    const written = await this.prisma.$transaction(async (tx) => {
      const row = await lockRequest(tx, user, id, input.version);
      if (row.status !== 'PENDING' || row.branchId === null) {
        throw new ConflictException('Only a pending request with a branch is approved');
      }
      if (!decideBranches(user, row).includes(row.branchId)) {
        throw new ForbiddenException('You may not approve this request');
      }
      // The items as they are under the request's lock: the ones staff priced.
      const lockedItems = await tx.csBookingRequestItem.findMany({
        where: { requestId: id },
        orderBy: { lineNo: 'asc' },
      });
      if (!sameItems(lockedItems, initial.items))
        throw new ConflictException('The request changed: reopen it');
      await requireKeyServes(tx, row.apiClientId, row.branchId);
      let prepared = legacyPrepared;
      if (row.profileId) {
        this.identities.requireBookingEnabled();
        const profile = await this.identities.lockProfile(tx, row.profileId);
        if (profile.version !== input.profileVersion)
          throw new ConflictException({
            code: 'PROFILE_VERSION_CONFLICT',
            message: 'The customer profile changed: reopen the request',
          });
        if (!prepareProfile) throw new ConflictException('The request changed: reopen it');
        if (profile.needsReview)
          throw new ConflictException({
            code: 'PROFILE_REVIEW_REQUIRED',
            message: 'Resolve customer identity proposals before approval',
          });
        const accountId = await this.customers.profileAccountInTx(tx, user, profile, row.branchId);
        if (booking.customerId && booking.customerId !== accountId)
          throw new BadRequestException('A linked request uses its own customer');
        prepared = prepareProfile(accountId);
      }
      if (!prepared) throw new ConflictException('The request changed: reopen it');
      if (prepared.branchId !== row.branchId) {
        throw new BadRequestException({
          message: "The booking's customer is not of the request's branch",
          code: 'BRANCH_MISMATCH',
        });
      }
      if (row.customerId !== null && prepared.customerId !== row.customerId) {
        throw new BadRequestException({
          message: "A customer's request is booked for that customer",
          code: 'CUSTOMER_MISMATCH',
        });
      }
      await requireKeyServes(tx, row.apiClientId, row.branchId);
      await this.currencies.requireActiveInTx(tx, input.paymentCurrency);
      const totals: (Prisma.Decimal | null)[] = [];
      if (estimated) {
        // Codex F165-2: the version accepted is the current one, still valid, under the lock.
        if (!estimateAccepted(row) || row.estimateCurrency === null) throw estimateRequired();
        // Codex F171-1: the estimate's own currency, share-locked through commit: one withdrawn
        // since the estimate needs a new estimate in an active currency.
        if (!(await currencyActiveInTx(tx, row.estimateCurrency)))
          throw new ConflictException({
            code: 'ESTIMATE_CURRENCY_INACTIVE',
            message: "The estimate's currency was withdrawn: estimate again in an active one",
          });
        // Codex F171-2: the acceptance covers the terms it priced, never other ones: the route,
        // mode and load type approved, the request's services and its items under the lock.
        requireEstimateTerms(row.estimateTerms, input, lockedItems);
        totals.push(...lines.map(() => null));
      } else {
        // F137-2: the pricing currency share-locked through commit, before the price is computed
        // again; one withdrawn since staff saw the price makes it stale.
        await requirePriceCurrency(tx, input.pricing.currency);
        for (const line of lines) {
          if (!line.inputs) throw estimateRequired();
          const now = await this.quotes.priceFor(line.inputs, row.branchId);
          await requireSamePrice(tx, now, line.fingerprint);
          totals.push(now.dto.total === null ? null : dec(now.dto.total));
        }
      }
      const bookingId = await this.bookings.insertInTx(tx, user, prepared);
      if (lines.some((l) => l.item !== null)) {
        // The booking's lines in order, as made from `made`: each item linked to its line.
        const bookingLines = await tx.bookingItem.findMany({
          where: { bookingId },
          orderBy: { lineNo: 'asc' },
          select: { id: true },
        });
        const lineOf = new Map(made.map((m, index) => [m.itemId, bookingLines[index]?.id ?? null]));
        for (const [index, line] of lines.entries()) {
          if (!line.item) continue;
          await tx.csBookingRequestItem.update({
            where: { id: line.item.id },
            data: {
              approvedCategoryCode: cargos[index]!.category,
              approvedQuantity: line.inputs ? dec(line.inputs.quantity) : null,
              approvedTotal: totals[index] ?? null,
              bookingItemId: lineOf.get(line.item.id) ?? null,
            },
          });
        }
      }
      if (row.profileId)
        await tx.customerProfileReview.create({
          data: {
            companyId: this.identities.companyId,
            actorId: user.id,
            entityId: row.profileId,
            action: 'BOOKING_ACCOUNT',
            reason: 'Staff approved the linked customer in the booking branch',
            snapshot: {
              accountId: prepared.customerId,
              branchId: row.branchId,
              bookingId,
              requestId: row.id,
            },
          },
        });
      const dropOffId = await dropOffFor(tx, user, row.branchId, input.dropOffId);
      // The request's total: the lines' sum when every line is priced, else none.
      const priced = totals.filter((t): t is Prisma.Decimal => t !== null);
      // Plan 09 section 12: an estimated request's total is the accepted estimate, in its currency.
      const total = estimated
        ? row.estimateAmount
        : priced.length === totals.length
          ? priced.reduce((sum, t) => sum.plus(t), dec('0'))
          : null;
      const firstPriced = lines.findIndex((l) => l.inputs !== null);
      const approved = await tx.csBookingRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          // Plan 09 section 5: the stage the customer now reads; a shipment stage notice compares.
          lastStageCode: BOOKED,
          bookingId,
          paymentCurrency: input.paymentCurrency,
          approvedCategoryCode: firstPriced < 0 ? null : cargos[firstPriced]!.category,
          approvedQuantity: firstPriced < 0 ? null : dec(lines[firstPriced]!.inputs!.quantity),
          approvedCurrency: estimated ? row.estimateCurrency : input.pricing.currency,
          approvedTotal: total,
          dropOffWarehouseId: dropOffId,
          decidedById: user.id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
        include: withQuote,
      });
      await this.events.emitInTx(tx, approved, ['request.approved']);
      return approved;
    });
    // As route and reject (F131-3): the row this transaction wrote.
    return this.format(user, written);
  }

  /**
   * Plan 09 section 11: staff correct the drop-off point of an approved request, with the same
   * checks as on approval (an active point taking shipments, in a branch where they may approve),
   * under the request's lock and version. Audited.
   */
  async setDropOff(
    user: AuthUser,
    id: string,
    input: CsSetDropOff,
  ): Promise<CsBookingRequestStaffDto> {
    const written = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "cs_booking_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const row = await tx.csBookingRequest.findUnique({ where: { id } });
      if (!row || !visibleTo(user, row)) throw new NotFoundException('Booking request not found');
      if (row.version !== input.version)
        throw new ConflictException('The request changed: reopen it');
      if (row.status !== 'APPROVED' || row.branchId === null)
        throw new ConflictException('Only an approved request has a drop-off point');
      if (!user.access.has(DECIDE, row.branchId))
        throw new ForbiddenException('You may not change this request');
      const dropOffId = await dropOffFor(tx, user, row.branchId, input.dropOffId);
      await this.audit.record(tx, user, {
        branchId: row.branchId,
        entity: 'CS_BOOKING_REQUEST',
        entityId: row.id,
        reference: row.reference,
        action: 'UPDATED',
        changes: [
          { field: 'dropOffWarehouseId', before: row.dropOffWarehouseId, after: dropOffId },
        ],
      });
      return tx.csBookingRequest.update({
        where: { id },
        data: { dropOffWarehouseId: dropOffId, version: { increment: 1 } },
        include: withQuote,
      });
    });
    return this.format(user, written);
  }

  /**
   * Plan 09 section 4: staff link an item that made no booking line to the line they added to the
   * draft booking. In one transaction with the booking locked (as confirmation locks it): the
   * person's bookings:update in the request's branch, the booking still a draft, the item the
   * request's and not linked yet, and the line the booking's and no other item's. Audited.
   */
  async resolveItem(
    user: AuthUser,
    id: string,
    itemId: string,
    input: CsResolveItem,
  ): Promise<CsBookingRequestStaffDto> {
    const written = await this.prisma.$transaction(async (tx) => {
      const initial = await tx.csBookingRequest.findUnique({ where: { id } });
      if (!initial || !visibleTo(user, initial))
        throw new NotFoundException('Booking request not found');
      if (initial.branchId === null || !user.access.has('bookings:update', initial.branchId))
        throw new ForbiddenException('You may not change this booking');
      if (initial.bookingId === null)
        throw new ConflictException('Only an approved request has a booking');
      const booking = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "bookings"
        WHERE "id" = ${initial.bookingId}::uuid FOR UPDATE`;
      if (booking[0]?.status !== 'DRAFT')
        throw new ConflictException('Only a draft booking has items to complete');
      await tx.$queryRaw`
        SELECT 1 FROM "cs_booking_request_items" WHERE "id" = ${itemId}::uuid FOR UPDATE`;
      const item = await tx.csBookingRequestItem.findUnique({ where: { id: itemId } });
      if (!item || item.requestId !== id) throw new NotFoundException('Item not found');
      if (item.bookingItemId !== null)
        throw new ConflictException({
          code: 'ITEM_RESOLVED',
          message: 'This item already has its booking line',
        });
      const line = await tx.bookingItem.findUnique({
        where: { id: input.bookingItemId },
        select: { bookingId: true, lineNo: true, csRequestItem: { select: { id: true } } },
      });
      if (!line || line.bookingId !== initial.bookingId)
        throw new BadRequestException({
          code: 'LINE_NOT_OF_BOOKING',
          message: "Choose a line of this request's booking",
        });
      if (line.csRequestItem !== null)
        throw new ConflictException({
          code: 'LINE_TAKEN',
          message: 'That line already completes another item',
        });
      await tx.csBookingRequestItem.update({
        where: { id: itemId },
        data: {
          bookingItemId: input.bookingItemId,
          resolvedAt: new Date(),
          resolvedById: user.id,
        },
      });
      await this.audit.record(tx, user, {
        branchId: initial.branchId,
        entity: 'CS_BOOKING_REQUEST',
        entityId: initial.id,
        reference: initial.reference,
        action: 'UPDATED',
        changes: [
          {
            field: `items.${item.lineNo}.bookingLine`,
            before: null,
            after: String(line.lineNo),
          },
        ],
      });
      return tx.csBookingRequest.findUniqueOrThrow({ where: { id }, include: withQuote });
    });
    return this.format(user, written);
  }

  async reasons(): Promise<CsRejectReasonDto[]> {
    const rows = await this.prisma.csRejectReason.findMany({
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
    });
    return rows.map(reasonDto);
  }

  /** Adds or changes a reason (the Administrator, master_data:update), in the audit log. */
  async setReason(
    user: AuthUser,
    code: string,
    input: CsRejectReasonInput,
  ): Promise<CsRejectReasonDto> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ code: string }[]>`
        SELECT "code" FROM "cs_reject_reasons" WHERE "code" = ${code} FOR UPDATE`;
      const before =
        locked.length > 0 ? await tx.csRejectReason.findUnique({ where: { code } }) : null;
      const after = before
        ? await tx.csRejectReason.update({ where: { code }, data: input })
        : await tx.csRejectReason.create({ data: { code, ...input } });
      const fields = ['textAr', 'textEn', 'isActive'] as const;
      const pick = (r: CsRejectReasonInput) => ({
        textAr: r.textAr,
        textEn: r.textEn,
        isActive: r.isActive,
      });
      await this.audit.record(tx, user, {
        branchId: null,
        entity: 'CS_REJECT_REASON',
        entityId: codeEntityId('CS_REJECT_REASON', code),
        reference: code,
        action: before ? 'UPDATED' : 'CREATED',
        changes: changedOf(before ? pick(before) : null, pick(after), fields),
      });
      return reasonDto(after);
    });
  }
}

function changedOf(
  before: CsRejectReasonInput | null,
  after: CsRejectReasonInput,
  fields: readonly (keyof CsRejectReasonInput)[],
) {
  return fields.flatMap((field) => {
    const was = before ? String(before[field]) : null;
    const now = String(after[field]);
    return was === now ? [] : [{ field, before: was, after: now }];
  });
}

/**
 * The request row locked for update, read after the lock, for a write by `user`: 404 unless they
 * see it, 409 when their version is stale or the request is decided or expired.
 */
async function lockRequest(tx: Tx, user: AuthUser, id: string, version: number) {
  await tx.$queryRaw`SELECT 1 FROM "cs_booking_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const row = await tx.csBookingRequest.findUnique({ where: { id } });
  if (!row || !visibleTo(user, row)) throw new NotFoundException('Booking request not found');
  if (row.version !== version) {
    throw new ConflictException('The request changed: open it again');
  }
  if (!undecided(row)) throw new ConflictException('The request is decided or expired');
  return row;
}

/** The key that made the request, share-locked: still active and serving `branchId`, else 409. */
async function requireKeyServes(tx: Tx, apiClientId: string, branchId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "api_clients" WHERE "id" = ${apiClientId}::uuid FOR SHARE`;
  const key = await tx.apiClient.findUnique({
    where: { id: apiClientId },
    include: { branches: { where: { branchId }, select: { branchId: true } } },
  });
  if (!key?.isActive || key.branches.length === 0) {
    throw new ConflictException('The key that sent this request no longer serves that branch');
  }
}

/**
 * Plan 09 section 4 (F161-3): a booking made from a bot request is confirmed only when every item
 * of the request has its booking line. The items are locked in the confirming transaction, so a
 * resolve and a confirm never race; any path to confirmation (screen, API, assistant draft) runs
 * this. A booking from no bot request has no items and passes.
 */
async function requireCargoComplete(tx: Tx, bookingId: string): Promise<void> {
  const open = await tx.$queryRaw<{ id: string; line_no: number }[]>`
    SELECT i."id", i."line_no" FROM "cs_booking_request_items" i
    JOIN "cs_booking_requests" r ON r."id" = i."request_id"
    WHERE r."booking_id" = ${bookingId}::uuid
    ORDER BY i."line_no"
    FOR UPDATE OF i`;
  const missing = open.length
    ? await tx.csBookingRequestItem.findMany({
        where: { id: { in: open.map((o) => o.id) }, bookingItemId: null },
        orderBy: { lineNo: 'asc' },
        select: { id: true, lineNo: true },
      })
    : [];
  if (missing.length > 0)
    throw new ConflictException({
      code: 'CARGO_INCOMPLETE',
      message: 'Complete the cargo lines of the bot request before confirming',
      items: missing,
    });
}

/**
 * Plan 09 section 11: the drop-off point of an approval or a correction, share-locked through
 * commit. A named point must be active, take shipments, and be in a branch where the person may
 * approve (400 DROP_OFF_NOT_ALLOWED otherwise). None named: the request's branch's only active
 * point, or none when it has several or none.
 */
async function dropOffFor(
  tx: Tx,
  user: AuthUser,
  branchId: string,
  named: string | undefined,
): Promise<string | null> {
  if (named !== undefined) {
    const rows = await tx.$queryRaw<
      { branch_id: string; is_active: boolean; accepts_drop_off: boolean }[]
    >`SELECT "branch_id"::text AS "branch_id", "is_active", "accepts_drop_off"
      FROM "warehouses" WHERE "id" = ${named}::uuid FOR SHARE`;
    const point = rows[0];
    // A point of the request's own branch (the one deciding it), never another's.
    if (
      !point?.is_active ||
      !point.accepts_drop_off ||
      point.branch_id !== branchId ||
      !user.access.has(DECIDE, point.branch_id)
    )
      throw new BadRequestException({
        code: 'DROP_OFF_NOT_ALLOWED',
        message: "Choose an active drop-off point of the request's branch",
      });
    return named;
  }
  const points = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS "id" FROM "warehouses"
    WHERE "branch_id" = ${branchId}::uuid AND "is_active" AND "accepts_drop_off"
    LIMIT 2 FOR SHARE`;
  return points.length === 1 ? points[0]!.id : null;
}

/** An approval line: the inputs priced, the fingerprint staff saw, and the item it prices. */
interface ApprovalLine {
  /** Null: an OTHER item (or one with no category) of an estimated request, priced by none. */
  inputs: CsPriceInputs | null;
  fingerprint: string | null;
  item: CsBookingRequestItem | null;
}

/**
 * Plan 09 section 4: what an approval prices. A request with no item rows (the one-item shape)
 * prices `pricing.category`/`quantity`; one with items sends one line per item, in order, and no
 * category or quantity of its own. An OTHER item is priced by staff's estimate (plan 09 section
 * 12), never by the engine: until that exists, the request is not approved.
 */
function approvalLines(input: CsApproveRequest, items: CsBookingRequestItem[]): ApprovalLine[] {
  const { category, quantity, ...route } = input.pricing;
  const mismatch = (message: string) =>
    new BadRequestException({ code: 'LINES_MISMATCH', message });
  if (items.length === 0) {
    if (input.lines !== undefined) throw mismatch('This request has no items: price it as one');
    if (category === undefined || quantity === undefined)
      throw new BadRequestException({
        code: 'LINES_REQUIRED',
        message: 'Name the category and quantity priced',
      });
    return [
      {
        inputs: { ...route, category, quantity },
        fingerprint: input.pricingFingerprint ?? null,
        item: null,
      },
    ];
  }
  if (items.some((i) => i.isOther)) {
    // Plan 09 section 12: the accepted estimate prices the whole request; the items' own
    // categories and quantities make the booking lines, so staff send no lines or fingerprint.
    if (
      category !== undefined ||
      quantity !== undefined ||
      input.pricingFingerprint !== undefined ||
      input.lines !== undefined
    )
      throw mismatch('A request with an estimate is approved at the estimate: send no lines');
    return items.map((item) => ({
      inputs:
        !item.isOther && item.priceCategoryCode !== null && item.quantity !== null
          ? { ...route, category: item.priceCategoryCode, quantity: toDecimalString(item.quantity) }
          : null,
      fingerprint: null,
      item,
    }));
  }
  if (category !== undefined || quantity !== undefined || input.pricingFingerprint !== undefined)
    throw mismatch('A request with items is priced per line');
  if (input.lines === undefined)
    throw new BadRequestException({ code: 'LINES_REQUIRED', message: 'Price each item' });
  if (input.lines.length !== items.length) throw mismatch('Price each item once, in order');
  return input.lines.map((line, index) => ({
    inputs: { ...route, category: line.category, quantity: line.quantity },
    fingerprint: line.pricingFingerprint,
    item: items[index]!,
  }));
}

/** Codex F165-2: the customer accepted the current estimate, and it is still valid. */
function estimateAccepted(
  r: Pick<
    CsBookingRequest,
    'estimateVersion' | 'estimateAcceptedVersion' | 'estimateValidUntil' | 'estimateAmount'
  >,
  now = new Date(),
): boolean {
  return (
    r.estimateVersion > 0 &&
    r.estimateAmount !== null &&
    r.estimateAcceptedVersion === r.estimateVersion &&
    r.estimateValidUntil !== null &&
    r.estimateValidUntil.getTime() > now.getTime()
  );
}

function estimateTermsOf(
  route: CsEstimateTerms,
  services: readonly string[],
  items: CsBookingRequestItem[],
): EstimateTerms {
  const cargo = items
    .map((i) =>
      [
        i.lineNo,
        i.isOther ? 'OTHER' : i.priceCategoryCode,
        i.quantity?.toString(),
        i.pieces,
        i.lengthCm?.toString(),
        i.widthCm?.toString(),
        i.heightCm?.toString(),
        i.weightKg?.toString(),
      ].join(':'),
    )
    .join('|');
  return {
    originId: route.originId,
    destinationId: route.destinationId,
    mode: route.mode,
    loadType: route.loadType,
    services: [...new Set(services)].sort(),
    cargo,
  };
}

/** 409 ESTIMATE_TERMS_CHANGED unless the approval books what the accepted estimate priced. */
function requireEstimateTerms(
  stored: Prisma.JsonValue,
  input: CsApproveRequest,
  items: CsBookingRequestItem[],
): void {
  const approved = estimateTermsOf(
    {
      originId: input.pricing.originId.toLowerCase(),
      destinationId: input.pricing.destinationId.toLowerCase(),
      mode: input.pricing.mode,
      loadType: input.pricing.loadType ?? null,
    },
    input.booking.services ?? [],
    items,
  );
  if (!sameTerms(stored, approved))
    throw new ConflictException({
      code: 'ESTIMATE_TERMS_CHANGED',
      message:
        'The route, mode, services or items differ from the accepted estimate: estimate again',
    });
}

function termsJson(t: EstimateTerms): Prisma.InputJsonObject {
  return {
    originId: t.originId,
    destinationId: t.destinationId,
    mode: t.mode,
    loadType: t.loadType,
    services: t.services,
    cargo: t.cargo,
  };
}

function sameTerms(stored: Prisma.JsonValue, approved: EstimateTerms): boolean {
  const terms = storedTerms(stored);
  return (
    terms !== null &&
    terms.originId === approved.originId &&
    terms.destinationId === approved.destinationId &&
    terms.mode === approved.mode &&
    terms.loadType === approved.loadType &&
    terms.cargo === approved.cargo &&
    terms.services.join(',') === approved.services.join(',')
  );
}

function estimateRequired(): ConflictException {
  return new ConflictException({
    code: 'ESTIMATE_REQUIRED',
    message: 'The customer must accept the current estimate of this request first',
  });
}

/**
 * Plan 09 section 12: the booking line of an OTHER item, GENERAL cargo of its pieces, described
 * in the customer's words; no pieces, no line (staff complete it before confirming).
 */
function otherLineOf(item: CsBookingRequestItem): BookingItemInput | null {
  if (item.pieces === null || item.pieces < 1) return null;
  const decimal = (d: Prisma.Decimal | null) => (d === null ? null : toDecimalString(d));
  const sized = item.lengthCm !== null && item.widthCm !== null && item.heightCm !== null;
  return {
    cargoType: 'GENERAL',
    quantity: item.pieces,
    description: item.description,
    lengthCm: sized ? decimal(item.lengthCm) : null,
    widthCm: sized ? decimal(item.widthCm) : null,
    heightCm: sized ? decimal(item.heightCm) : null,
    weightKg: decimal(item.weightKg),
  };
}

/** Whether the items under the lock are the ones read before it (same rows, same values). */
function sameItems(a: CsBookingRequestItem[], b: CsBookingRequestItem[]): boolean {
  const key = (i: CsBookingRequestItem) =>
    [
      i.id,
      i.lineNo,
      i.priceCategoryCode,
      i.isOther,
      i.quantity?.toString(),
      i.pieces,
      i.lengthCm?.toString(),
      i.widthCm?.toString(),
      i.heightCm?.toString(),
      i.weightKg?.toString(),
      i.bookingItemId,
    ].join('|');
  return a.length === b.length && a.every((item, index) => key(item) === key(b[index]!));
}

/**
 * Plan 09 section 4 (F161-3): the booking line an item becomes, by the approved category's unit
 * and the approved quantity (Codex F167-1: what staff priced, not the customer's first figure),
 * with no guess. A unit counted in packages takes a whole quantity, or else the pieces; a CBM, kg
 * or per-shipment price takes the pieces only, with the approved quantity as its volume or weight.
 * The customer's physical facts (pieces, one piece's dimensions, weight) are kept as given; the
 * dimensions only as a full set (F167-2), which intake requires. A container line needs its
 * container type, which the bot does not send. No certain count: no line, and staff complete it
 * before confirming.
 */
function bookingLineOf(
  item: CsBookingRequestItem,
  cargo: { category: string; cargoType: CargoType; unit: RateUnit },
  quantity: Prisma.Decimal,
): BookingItemInput | null {
  if (cargo.cargoType === 'CONTAINER' || cargo.unit === 'PER_CONTAINER') return null;
  const counted = ['PER_PIECE', 'PER_PALLET', 'PER_BARREL'].includes(cargo.unit);
  const count = counted && quantity.isInteger() ? quantity.toNumber() : item.pieces;
  if (count === null || count < 1) return null;
  const decimal = (d: Prisma.Decimal | null) => (d === null ? null : toDecimalString(d));
  // A partial set (a request saved before intake required all three) stays on the item only.
  const sized = item.lengthCm !== null && item.widthCm !== null && item.heightCm !== null;
  // Codex F167-1: a booking line's volume is its pieces' dimensions when it has them, and its
  // weight is the customer's when given. An approved CBM or kg that disagrees with those facts
  // makes no line: neither is dropped (the item keeps the facts, the request the approved
  // quantity), and staff add the line with the right measurements before confirming.
  if (
    cargo.unit === 'PER_CBM' &&
    sized &&
    !cbmFromDimensions(item.lengthCm!, item.widthCm!, item.heightCm!, count).eq(quantity)
  )
    return null;
  if (cargo.unit === 'PER_KG' && item.weightKg !== null && !item.weightKg.eq(quantity)) return null;
  return {
    cargoType: cargo.cargoType,
    quantity: count,
    priceCategoryCode: cargo.category,
    lengthCm: sized ? decimal(item.lengthCm) : null,
    widthCm: sized ? decimal(item.widthCm) : null,
    heightCm: sized ? decimal(item.heightCm) : null,
    weightKg: cargo.unit === 'PER_KG' ? toDecimalString(quantity) : decimal(item.weightKg),
    volumeCbm: cargo.unit === 'PER_CBM' ? toDecimalString(quantity) : null,
  };
}

/**
 * 409 PRICE_STALE (plan 04a section 1) unless the price computed now has the fingerprint staff
 * saw and its card, share-locked here, is still the same approved card: a cancellation either
 * committed before (and is seen) or waits for this transaction. No approved price now passes only
 * when staff saw none.
 */
async function requireSamePrice(tx: Tx, now: ApprovalPrice, seen: string | null): Promise<void> {
  const stale = () => priceStale(now.dto);
  if (now.dto.pricingFingerprint !== seen) throw stale();
  if (now.card === null) return;
  const cards = await tx.$queryRaw<
    {
      status: string;
      approved_at: Date | null;
      price: Prisma.Decimal;
      minimum_charge: Prisma.Decimal;
      valid_from: Date;
      valid_to: Date | null;
    }[]
  >`SELECT "status"::text AS "status", "approved_at", "price", "minimum_charge", "valid_from", "valid_to"
    FROM "rate_cards" WHERE "id" = ${now.card.id}::uuid FOR SHARE`;
  const card = cards[0];
  const today = toDbDate(todayIn('UTC')).getTime();
  if (
    !card ||
    card.status !== 'APPROVED' ||
    card.approved_at?.getTime() !== now.card.approvedAt.getTime() ||
    !card.price.eq(now.card.price) ||
    !card.minimum_charge.eq(now.card.minimumCharge) ||
    card.valid_from.getTime() > today ||
    (card.valid_to !== null && card.valid_to.getTime() < today)
  ) {
    throw stale();
  }
}

function priceStale(price: CsApprovalPriceDto | null): ConflictException {
  return new ConflictException({
    message: 'The price changed: check it again before approving',
    code: 'PRICE_STALE',
    price,
  });
}

/**
 * 409 PRICE_STALE unless the pricing currency, share-locked here, is active: a deactivation either
 * committed before (and is seen) or waits for this transaction (Codex F137-2).
 */
async function requirePriceCurrency(tx: Tx, code: string): Promise<void> {
  if (!(await currencyActiveInTx(tx, code))) throw priceStale(null);
}

/** Whether the currency is active, share-locked until the caller commits. */
async function currencyActiveInTx(tx: Tx, code: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ is_active: boolean }[]>`
    SELECT "is_active" FROM "currencies" WHERE "code" = ${code} FOR SHARE`;
  return rows[0]?.is_active === true;
}

function reasonDto(r: {
  code: string;
  textAr: string;
  textEn: string;
  isActive: boolean;
}): CsRejectReasonDto {
  return { code: r.code, textAr: r.textAr, textEn: r.textEn, isActive: r.isActive };
}

function summary(r: Row, now = new Date()): CsBookingRequestSummaryDto {
  return {
    id: r.id,
    reference: r.reference,
    // Staff see the real state: a request by names awaiting routing is not "pending" to them.
    status: stateOf({ status: r.status, expiresAt: r.expiresAt }, now),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    branchId: r.branchId,
    originId: r.originLocationId,
    destinationId: r.destinationLocationId,
    category: r.priceCategoryCode,
    quantity: toDecimalString(r.quantity),
    senderName: r.senderName,
    channel: (r.senderChannel as CsSenderChannel | null) ?? null,
    customerId: r.customerId,
    byNames: r.botNames !== null,
  };
}

function itemDto(i: CsBookingRequestItem): CsRequestItemDto {
  const decimal = (d: Prisma.Decimal | null) => (d === null ? null : toDecimalString(d));
  return {
    id: i.id,
    lineNo: i.lineNo,
    category: i.priceCategoryCode,
    botKind: (i.botKind as CsName | null) ?? null,
    isOther: i.isOther,
    description: i.description,
    quantity: decimal(i.quantity),
    pieces: i.pieces,
    dimensions:
      i.lengthCm !== null && i.widthCm !== null && i.heightCm !== null
        ? {
            lengthCm: toDecimalString(i.lengthCm),
            widthCm: toDecimalString(i.widthCm),
            heightCm: toDecimalString(i.heightCm),
          }
        : null,
    weightKg: decimal(i.weightKg),
    quoteRef: i.quoteRef,
    approvedTotal: decimal(i.approvedTotal),
    bookingItemId: i.bookingItemId,
  };
}

function staffDto(
  user: AuthUser,
  r: Row,
  priceCheck: CsBookingRequestStaffDto['priceCheck'],
): CsBookingRequestStaffDto {
  const open = undecided(r);
  return {
    ...summary(r),
    version: r.version,
    allowedBranchIds: r.allowedBranchIds,
    customerNumber: r.customer?.number ?? null,
    contactPhone: r.contactPhone,
    consigneeName: r.consigneeName,
    consigneePhone: r.consigneePhone,
    handover: r.handover,
    services: r.services as CsBookingRequestStaffDto['services'],
    requestedDate: fromDbDateOrNull(r.requestedDate),
    language: (r.language as 'ar' | 'en' | null) ?? null,
    botNames: (r.botNames as { origin: CsName; destination: CsName; kind: CsName } | null) ?? null,
    botQuotedPrice:
      r.botQuotedAmount !== null && r.botQuotedCurrency !== null
        ? { amount: toDecimalString(r.botQuotedAmount), currency: r.botQuotedCurrency }
        : null,
    quoteRef: r.quoteRef,
    pieces: r.pieces,
    dimensions:
      r.lengthCm !== null && r.widthCm !== null && r.heightCm !== null
        ? {
            lengthCm: toDecimalString(r.lengthCm),
            widthCm: toDecimalString(r.widthCm),
            heightCm: toDecimalString(r.heightCm),
          }
        : null,
    items: r.items.map(itemDto),
    bookingLines: r.booking?.items ?? [],
    priceCheck,
    routedAt: r.routedAt?.toISOString() ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    rejectReasonCode: r.rejectReasonCode,
    internalNote: r.internalNote,
    bookingId: r.bookingId,
    bookingNumber: r.booking?.number ?? null,
    paymentCurrency: r.paymentCurrency,
    approvedPricing:
      r.approvedCategoryCode !== null && r.approvedQuantity !== null && r.approvedCurrency !== null
        ? {
            category: r.approvedCategoryCode,
            quantity: toDecimalString(r.approvedQuantity),
            currency: r.approvedCurrency,
            total: r.approvedTotal === null ? null : toDecimalString(r.approvedTotal),
          }
        : null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    cancelRequest:
      r.cancelRequestedAt === null
        ? null
        : {
            requestedAt: r.cancelRequestedAt.toISOString(),
            closedAt: r.cancelRequestClosedAt?.toISOString() ?? null,
            reason: r.cancelRequestReason,
          },
    instantAccount:
      r.instantAccount === null
        ? null
        : { outcome: r.instantAccount, customerId: r.instantCustomerId },
    dropOffId: r.dropOffWarehouseId,
    dropOffPoint: r.dropOff,
    dropOffChoices: [],
    estimate: (() => {
      const estimate = estimateOf(r);
      return estimate
        ? {
            ...estimate,
            acceptedVersion: r.estimateAcceptedVersion,
            acceptedAt: r.estimateAcceptedAt?.toISOString() ?? null,
            terms: (() => {
              const terms = storedTerms(r.estimateTerms);
              return terms
                ? {
                    originId: terms.originId,
                    destinationId: terms.destinationId,
                    mode: terms.mode,
                    loadType: terms.loadType,
                  }
                : null;
            })(),
          }
        : null;
    })(),
    photos: r.photos.map((p) => ({
      id: p.id,
      contentType: p.contentType as CsRequestPhotoType,
      sizeBytes: p.sizeBytes,
      createdAt: p.createdAt.toISOString(),
    })),
    actions: {
      // Set by format(), which knows whether estimates are switched on.
      canEstimate: false,
      canSetDropOff:
        r.status === 'APPROVED' && r.branchId !== null && user.access.has(DECIDE, r.branchId),
      canCloseCancelRequest:
        r.status === 'APPROVED' &&
        r.cancelRequestedAt !== null &&
        r.cancelRequestClosedAt === null &&
        r.branchId !== null &&
        user.access.has(DECIDE, r.branchId),
      canRoute:
        open &&
        r.status === 'AWAITING_ROUTING' &&
        r.allowedBranchIds.some((b) => user.access.has(ROUTE, b)),
      canReject: open && decideBranches(user, r).length > 0,
      canApprove:
        open &&
        r.status === 'PENDING' &&
        r.branchId !== null &&
        decideBranches(user, r).includes(r.branchId) &&
        user.access.has('bookings:create', r.branchId),
    },
  };
}
