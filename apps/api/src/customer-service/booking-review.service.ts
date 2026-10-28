import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CsApprovalPriceDto,
  CsApproveRequest,
  CsBookingRequestStaffDto,
  CsPriceInputs,
  CsBookingRequestSummaryDto,
  CsName,
  CsRejectReasonDto,
  CsRejectReasonInput,
  CsRejectRequest,
  CsReviewFilter,
  CsRouteRequest,
  CsSenderChannel,
  CreateBookingRequest,
  Permission,
} from '@nolon/shared';
import { AuditService, codeEntityId } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { fromDbDateOrNull, todayIn, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { type CsBookingRequest, type CsQuote, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { stateOf } from './booking-requests.service.js';
import { type ApprovalPrice, QuoteService } from './quote.service.js';

type Tx = Prisma.TransactionClient;

/** The most requests a staff list shows at once (newest first). */
const LIST_LIMIT = 200;

const VIEW: Permission = 'cs_booking_requests:view';
const ROUTE: Permission = 'cs_booking_requests:update';
const DECIDE: Permission = 'cs_booking_requests:approve';

type Row = CsBookingRequest & {
  customer: { number: string } | null;
  booking: { number: string } | null;
};
type QuotedRow = Row & { quote: CsQuote | null };

const rowInclude = {
  customer: { select: { number: true } },
  booking: { select: { number: true } },
} as const;
const withQuote = { ...rowInclude, quote: true } as const;

function undecided(r: Pick<CsBookingRequest, 'status' | 'expiresAt'>, now = new Date()): boolean {
  return (
    (r.status === 'PENDING' || r.status === 'AWAITING_ROUTING') &&
    r.expiresAt.getTime() > now.getTime()
  );
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
  ) {}

  async list(user: AuthUser, filter: CsReviewFilter): Promise<CsBookingRequestSummaryDto[]> {
    const now = new Date();
    const viewable = user.access.branchesWith([VIEW]);
    const routable = user.access
      .branchIds()
      .filter((b) => user.access.has(ROUTE, b) || user.access.has(DECIDE, b));
    const status: Prisma.CsBookingRequestWhereInput =
      filter === 'open'
        ? { status: { in: ['PENDING', 'AWAITING_ROUTING'] }, expiresAt: { gt: now } }
        : filter === 'expired'
          ? { status: { in: ['PENDING', 'AWAITING_ROUTING'] }, expiresAt: { lte: now } }
          : filter === 'pending' || filter === 'awaiting_routing'
            ? {
                status: filter === 'pending' ? 'PENDING' : 'AWAITING_ROUTING',
                expiresAt: { gt: now },
              }
            : { status: filter === 'approved' ? 'APPROVED' : 'REJECTED' };
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
    return staffDto(user, row, priceCheck);
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
      return tx.csBookingRequest.update({
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
    });
    // As route: the row this transaction wrote.
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
    const { pricing } = input;
    // F137-1: the booking is the cargo priced, its route, mode, cargo and load type the inputs'.
    const cargo = await this.quotes.cargoOf(pricing);
    const booking: CreateBookingRequest = {
      ...input.booking,
      originLocationId: pricing.originId,
      destinationLocationId: pricing.destinationId,
      mode: pricing.mode,
      loadType: cargo.loadType,
      cargoType: cargo.cargoType,
      items: [],
    };
    await this.currencies.requireActive(input.paymentCurrency);
    const prepared = await this.bookings.prepareCreate(user, booking);
    const written = await this.prisma.$transaction(async (tx) => {
      const row = await lockRequest(tx, user, id, input.version);
      if (row.status !== 'PENDING' || row.branchId === null) {
        throw new ConflictException('Only a pending request with a branch is approved');
      }
      if (!decideBranches(user, row).includes(row.branchId)) {
        throw new ForbiddenException('You may not approve this request');
      }
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
      // F137-2: the pricing currency share-locked through commit, before the price is computed
      // again; one withdrawn since staff saw the price makes it stale.
      await requirePriceCurrency(tx, pricing.currency);
      const now = await this.quotes.priceFor(pricing, row.branchId);
      await requireSamePrice(tx, now, input.pricingFingerprint);
      const bookingId = await this.bookings.insertInTx(tx, user, prepared);
      return tx.csBookingRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          bookingId,
          paymentCurrency: input.paymentCurrency,
          approvedCategoryCode: cargo.category,
          approvedQuantity: dec(pricing.quantity),
          approvedCurrency: pricing.currency,
          approvedTotal: now.dto.total === null ? null : dec(now.dto.total),
          decidedById: user.id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
        include: withQuote,
      });
    });
    // As route and reject (F131-3): the row this transaction wrote.
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
  const rows = await tx.$queryRaw<{ is_active: boolean }[]>`
    SELECT "is_active" FROM "currencies" WHERE "code" = ${code} FOR SHARE`;
  if (rows[0]?.is_active !== true) throw priceStale(null);
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
    actions: {
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
