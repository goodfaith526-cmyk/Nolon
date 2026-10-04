import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BillableTripDto,
  CreateSupplierBillRequest,
  OpeningSupplierItemRequest,
  Page,
  SupplierBillDto,
  SupplierBillInput,
  SupplierBillLineInput,
  SupplierBillStatus,
  SupplierBillSummaryDto,
} from '@nolon/shared';
import { BASE_CURRENCY } from '@nolon/shared';
import { AutoJournalService, type BillLineForPosting } from '../accounting/auto-journal.service.js';
import { ExpenseCategoriesService } from '../accounting/expense-categories.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import { toUsd } from '../accounting/journal-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { Prisma, type SupplierBill } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { TripCostsService } from '../transport/trip-costs.service.js';
import { SuppliersService } from './suppliers.service.js';

export interface SupplierBillFilters extends PageQuery {
  status?: SupplierBillStatus;
  supplierId?: string;
  /** Approved bills with a balance left. */
  openOnly?: boolean;
}

type Tx = Prisma.TransactionClient;

const details = {
  supplier: { select: { name: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: { shipment: { select: { number: true } }, trip: { select: { number: true } } },
  },
  journalEntry: { select: { number: true } },
  cancelJournal: { select: { number: true } },
  allocations: {
    include: {
      payment: { select: { id: true, number: true, paymentDate: true, status: true } },
    },
    orderBy: { payment: { paymentDate: 'asc' } },
  },
} satisfies Prisma.SupplierBillInclude;

type BillWithDetails = Prisma.SupplierBillGetPayload<{ include: typeof details }>;

interface CheckedLine {
  kind: SupplierBillLineInput['kind'];
  chargeTypeCode: string | null;
  shipmentId: string | null;
  tripId: string | null;
  expenseCategoryCode: string | null;
  description: string | null;
  amount: Decimal;
}

/**
 * Supplier bills (scope 13; annex C rules 7, 8, 11a and 12). A bill belongs to one branch and
 * currency and is edited as a DRAFT; approving it numbers it and posts its entry together. Lines
 * are shipment costs by charge type, a carrier's completed trips (clearing their accruals) or
 * general expenses by category. An approved bill with no payment is cancelled by its reversing
 * entry, which gives its trips' accruals back.
 */
@Injectable()
export class SupplierBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly fxRates: FxRatesService,
    private readonly currencies: CurrenciesService,
    private readonly masterData: MasterDataService,
    private readonly expenseCategories: ExpenseCategoriesService,
    private readonly shipments: ShipmentsService,
    private readonly tripCosts: TripCostsService,
    private readonly suppliers: SuppliersService,
  ) {}

  async list(user: AuthUser, filters: SupplierBillFilters): Promise<Page<SupplierBillSummaryDto>> {
    const where: Prisma.SupplierBillWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
      ...(filters.openOnly
        ? {
            status: 'APPROVED',
            paidAmount: { lt: this.prisma.supplierBill.fields.total },
          }
        : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { supplierReference: { contains: filters.q, mode: 'insensitive' } },
              { supplier: { name: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.supplierBill.findMany({
        where,
        include: details,
        orderBy: [{ billDate: 'desc' }, { createdAt: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.supplierBill.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<SupplierBillDto> {
    return toDto(await this.findScoped(user, id), user);
  }

  /** Trips a bill of the supplier can settle (rule 11a), for the bill form. */
  billableTrips(user: AuthUser, supplierId: string, branchId?: string): Promise<BillableTripDto[]> {
    if (branchId) assertBranchAccess(user, branchId);
    return this.tripCosts.billableTrips(user, supplierId, branchId);
  }

  /**
   * A draft bill in one of the user's branches. The client's `requestId` becomes the bill's id, so
   * an exact retry returns the first draft; anything else reusing the id is refused.
   */
  async create(user: AuthUser, input: CreateSupplierBillRequest): Promise<SupplierBillDto> {
    assertBranchAccess(user, input.branchId);
    const done = await this.prisma.supplierBill.findUnique({
      where: { id: input.requestId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (done) return this.retry(user, done, input);
    const supplier = await this.suppliers.requireSupplier(input.supplierId);
    if (!supplier.isActive) throw new BadRequestException('The supplier is inactive');
    const draft = await this.checkDraft(user, input);
    try {
      await this.prisma.supplierBill.create({
        data: {
          id: input.requestId,
          supplierId: supplier.id,
          ...draft.fields,
          createdById: user.id,
          lines: { create: draft.lines.map((l, index) => ({ lineNo: index + 1, ...l })) },
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.supplierBill.findUnique({
        where: { id: input.requestId },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      });
      if (!raced) throw error;
      return this.retry(user, raced, input);
    }
    return this.get(user, input.requestId);
  }

  /** An exact retry returns the bill the request created; any other reuse is a 409. */
  private retry(
    user: AuthUser,
    existing: Prisma.SupplierBillGetPayload<{ include: { lines: true } }>,
    input: CreateSupplierBillRequest,
  ): Promise<SupplierBillDto> {
    const same =
      !existing.isOpening &&
      existing.supplierId === input.supplierId &&
      existing.createdById === user.id &&
      existing.branchId === input.branchId &&
      existing.currency === input.currency &&
      sameRate(existing.fxRate, input.currency, input.fxRate) &&
      fromDbDate(existing.billDate) === input.billDate &&
      fromDbDate(existing.dueDate) === input.dueDate &&
      existing.supplierReference === (input.supplierReference ?? null) &&
      existing.notes === (input.notes ?? null) &&
      existing.lines.length === input.lines.length &&
      existing.lines.every((line, index) => {
        const sent = input.lines[index];
        return (
          sent !== undefined &&
          line.kind === sent.kind &&
          line.amount.eq(dec(sent.amount)) &&
          line.description === (sent.description ?? null) &&
          (sent.kind !== 'SHIPMENT_COST' ||
            (line.shipmentId === (sent.shipmentId ?? null) &&
              line.chargeTypeCode === (sent.chargeTypeCode ?? null))) &&
          (sent.kind !== 'TRIP' || line.tripId === (sent.tripId ?? null)) &&
          (sent.kind !== 'EXPENSE' ||
            line.expenseCategoryCode === (sent.expenseCategoryCode ?? null))
        );
      });
    if (!same) throw new ConflictException('This request id was already used: send a new id');
    return this.get(user, existing.id);
  }

  /** Drafts only; the lines are replaced as a whole. */
  async update(user: AuthUser, id: string, input: SupplierBillInput): Promise<SupplierBillDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') throw new ConflictException('Only a draft bill is edited');
    const draft = await this.checkDraft(user, input);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, ['DRAFT']);
      await tx.supplierBillLine.deleteMany({ where: { billId: id } });
      await tx.supplierBill.update({
        where: { id },
        data: {
          ...draft.fields,
          lines: { create: draft.lines.map((l, index) => ({ lineNo: index + 1, ...l })) },
        },
      });
    });
    return this.get(user, id);
  }

  /**
   * Numbers the bill and posts its entry, together. Inside the transaction the supplier, the
   * currency and the expense categories are share-locked and checked again, and each trip is
   * locked and marked billed (rule 11a: an accrual is cleared once).
   */
  async approve(user: AuthUser, id: string): Promise<SupplierBillDto> {
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, ['DRAFT']);
      const bill = await tx.supplierBill.findUniqueOrThrow({
        where: { id },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      });
      if (bill.lines.length === 0 || !bill.total.gt(0)) {
        throw new BadRequestException('A bill needs at least one line with an amount');
      }
      await this.suppliers.requireActiveInTx(tx, bill.supplierId);
      await this.currencies.requireActiveInTx(tx, bill.currency);
      const trips = await this.tripCosts.markCarrierBilled(
        tx,
        bill.lines.flatMap((l) => (l.tripId ? [l.tripId] : [])),
        bill,
      );
      const lines: (BillLineForPosting & { description: string | null })[] = [];
      for (const line of bill.lines) {
        lines.push({
          ...(await this.postingLine(tx, line, trips, bill.branchId)),
          description: line.description,
        });
      }
      const billDate = fromDbDate(bill.billDate);
      const year = billDate.slice(0, 4);
      const number = formatDocumentNumber(
        'SB',
        await nextSequenceValue(tx, 'SUPPLIER_BILL', year),
        year,
      );
      const totalUsd = toUsd(bill.total, bill.fxRate, bill.currency);
      const { entry, payableAccountId } = await this.autoJournal.supplierBillApproved(
        tx,
        {
          id,
          number,
          branchId: bill.branchId,
          supplierId: bill.supplierId,
          currency: bill.currency,
          fxRate: bill.fxRate,
          billDate,
          total: bill.total,
          totalUsd,
          lines,
        },
        user.id,
      );
      await tx.supplierBill.update({
        where: { id },
        data: {
          status: 'APPROVED',
          number,
          totalUsd,
          journalEntryId: entry.id,
          payableAccountId,
          approvedAt: new Date(),
          approvedById: user.id,
        },
      });
    });
    return this.get(user, id);
  }

  /**
   * A draft is cancelled with a reason. An approved bill nothing has paid is cancelled by its
   * reversing entry, dated today in the branch; its trips can then be billed again.
   */
  async cancel(user: AuthUser, id: string, reason: string): Promise<SupplierBillDto> {
    const existing = await this.findScoped(user, id);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: existing.branchId },
      select: { timezone: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const status = await lockStatus(tx, id, ['DRAFT', 'APPROVED']);
      const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id } });
      let cancelJournalEntryId: string | null = null;
      if (status === 'APPROVED') {
        if (bill.isOpening) {
          throw new ConflictException('An opening item is corrected by a journal entry');
        }
        if (!bill.paidAmount.isZero()) {
          throw new ConflictException('Cancel the payments of this bill first');
        }
        if (!bill.journalEntryId) throw new Error('An approved bill has an entry');
        const reversal = await this.autoJournal.reverseDocumentEntry(
          tx,
          bill.journalEntryId,
          todayIn(branch.timezone),
          user.id,
          `Cancellation of supplier bill ${bill.number ?? ''}: ${reason}`,
        );
        await this.tripCosts.releaseCarrierBill(tx, id);
        cancelJournalEntryId = reversal.id;
      }
      await tx.supplierBill.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: new Date(),
          cancelledById: user.id,
          cancelJournalEntryId,
        },
      });
    });
    return this.get(user, id);
  }

  /**
   * Annex C rule 15: a supplier's bill still open at go-live, recorded as an approved opening item
   * (no lines) and posted at once against opening equity. Payments then settle it like any bill.
   * The client's `requestId` becomes its id, so a retry returns the first item.
   */
  async createOpeningItem(
    user: AuthUser,
    input: OpeningSupplierItemRequest,
  ): Promise<SupplierBillDto> {
    assertBranchAccess(user, input.branchId);
    if (input.dueDate < input.billDate) {
      throw new BadRequestException('The due date is before the bill date');
    }
    if (input.entryDate < input.billDate) {
      throw new BadRequestException('The opening entry is dated before the bill');
    }
    const amount = dec(input.amount);
    const done = await this.prisma.supplierBill.findUnique({ where: { id: input.requestId } });
    if (done) return this.openingRetry(user, done, input);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.suppliers.requireActiveInTx(tx, input.supplierId);
        const currency = await this.currencies.requireActiveInTx(tx, input.currency);
        checkAmount(amount, currency.decimalPlaces);
        const fxRate = await this.fxRates.resolve(currency.code, input.entryDate, input.fxRate);
        const totalUsd = toUsd(amount, fxRate, currency.code);
        const year = input.entryDate.slice(0, 4);
        const number = formatDocumentNumber(
          'OBS',
          await nextSequenceValue(tx, 'OPENING_BILL', year),
          year,
        );
        const { entry, payableAccountId } = await this.autoJournal.openingSupplierItem(
          tx,
          {
            sourceId: input.requestId,
            number,
            reference: input.reference,
            branchId: input.branchId,
            supplierId: input.supplierId,
            entryDate: input.entryDate,
            currency: currency.code,
            fxRate,
            amount,
            amountUsd: totalUsd,
          },
          user.id,
        );
        await tx.supplierBill.create({
          data: {
            id: input.requestId,
            number,
            branchId: input.branchId,
            supplierId: input.supplierId,
            supplierReference: input.reference,
            isOpening: true,
            currency: currency.code,
            fxRate,
            billDate: toDbDate(input.billDate),
            dueDate: toDbDate(input.dueDate),
            status: 'APPROVED',
            total: amount,
            totalUsd,
            journalEntryId: entry.id,
            payableAccountId,
            createdById: user.id,
            approvedById: user.id,
            approvedAt: new Date(),
          },
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.supplierBill.findUnique({ where: { id: input.requestId } });
      if (!raced) throw error;
      return this.openingRetry(user, raced, input);
    }
    return this.get(user, input.requestId);
  }

  /** An exact retry returns the opening item the request recorded; any other reuse is a 409. */
  private async openingRetry(
    user: AuthUser,
    existing: SupplierBill,
    input: OpeningSupplierItemRequest,
  ): Promise<SupplierBillDto> {
    const entry = existing.journalEntryId
      ? await this.prisma.journalEntry.findUnique({
          where: { id: existing.journalEntryId },
          select: { entryDate: true },
        })
      : null;
    const same =
      existing.isOpening &&
      entry !== null &&
      existing.supplierId === input.supplierId &&
      existing.createdById === user.id &&
      existing.branchId === input.branchId &&
      existing.currency === input.currency &&
      sameRate(existing.fxRate, input.currency, input.fxRate) &&
      fromDbDate(entry.entryDate) === input.entryDate &&
      fromDbDate(existing.billDate) === input.billDate &&
      fromDbDate(existing.dueDate) === input.dueDate &&
      existing.supplierReference === input.reference &&
      existing.total.eq(dec(input.amount));
    if (!same) throw new ConflictException('This request id was already used: send a new id');
    return this.get(user, existing.id);
  }

  /** Inside the approval: what a stored line posts to, with its references checked again. */
  private async postingLine(
    tx: Tx,
    line: {
      kind: SupplierBillLineInput['kind'];
      chargeTypeCode: string | null;
      shipmentId: string | null;
      tripId: string | null;
      expenseCategoryCode: string | null;
      amount: Decimal;
    },
    trips: Map<string, { number: string; accrualEntryId: string }>,
    branchId: string,
  ): Promise<BillLineForPosting> {
    if (line.kind === 'SHIPMENT_COST' && line.chargeTypeCode && line.shipmentId) {
      // Under a share lock: the shipment stays in the bill's branch and is not cancelled meanwhile.
      const shipment = await this.shipments.lockForCostInTx(tx, line.shipmentId);
      if (shipment.branchId !== branchId) {
        throw new BadRequestException('A shipment on the bill is of another branch');
      }
      if (shipment.status === 'CANCELLED') {
        throw new BadRequestException('A shipment on the bill is cancelled');
      }
      return {
        kind: 'SHIPMENT_COST',
        chargeTypeCode: line.chargeTypeCode,
        shipmentId: line.shipmentId,
        amount: line.amount,
      };
    }
    if (line.kind === 'EXPENSE' && line.expenseCategoryCode) {
      const category = await this.expenseCategories.requireActiveInTx(tx, line.expenseCategoryCode);
      return { kind: 'EXPENSE', accountId: category.accountId, amount: line.amount };
    }
    const trip = line.tripId ? trips.get(line.tripId) : undefined;
    if (line.kind === 'TRIP' && line.tripId && trip) {
      return {
        kind: 'TRIP',
        tripId: line.tripId,
        tripNumber: trip.number,
        accrualEntryId: trip.accrualEntryId,
        amount: line.amount,
      };
    }
    throw new Error(`Bill line of kind ${line.kind} is incomplete`);
  }

  /**
   * Checks a draft: the branch is the user's, the dates, the currency and rate, and each line's
   * references (a shipment the user may see, an external trip of the bill's branch, an active
   * charge type or expense category). Amounts are in the currency's minor units.
   */
  private async checkDraft(user: AuthUser, input: SupplierBillInput) {
    assertBranchAccess(user, input.branchId);
    if (input.dueDate < input.billDate) {
      throw new BadRequestException('The due date is before the bill date');
    }
    const currency = await this.currencies.requireActive(input.currency);
    const fxRate = await this.fxRates.resolve(currency.code, input.billDate, input.fxRate);
    const tripIds = input.lines.flatMap((l) => (l.tripId ? [l.tripId] : []));
    if (new Set(tripIds).size !== tripIds.length) {
      throw new BadRequestException('Each trip appears once on a bill');
    }
    const categories = new Map(
      (await this.expenseCategories.list()).map((c) => [c.code, c.isActive]),
    );
    const lines: CheckedLine[] = [];
    for (const [index, line] of input.lines.entries()) {
      const label = `Line ${index + 1}`;
      const amount = dec(line.amount);
      checkAmount(amount, currency.decimalPlaces, label);
      const base = {
        kind: line.kind,
        chargeTypeCode: null,
        shipmentId: null,
        tripId: null,
        expenseCategoryCode: null,
        description: line.description ?? null,
        amount,
      };
      if (line.kind === 'SHIPMENT_COST') {
        if (!line.shipmentId || !line.chargeTypeCode) {
          throw new BadRequestException(`${label}: a shipment cost needs a shipment and a charge`);
        }
        const shipment = await this.shipments.requireAccessible(user, line.shipmentId);
        if (shipment.branchId !== input.branchId) {
          throw new BadRequestException(`${label}: the shipment is of another branch`);
        }
        if (shipment.status === 'CANCELLED') {
          throw new BadRequestException(`${label}: the shipment is cancelled`);
        }
        await this.masterData.requireChargeType(line.chargeTypeCode);
        lines.push({ ...base, shipmentId: line.shipmentId, chargeTypeCode: line.chargeTypeCode });
      } else if (line.kind === 'TRIP') {
        if (!line.tripId) throw new BadRequestException(`${label}: choose the trip`);
        const trip = await this.tripCosts.requireBillableTrip(user, line.tripId);
        if (trip.branchId !== input.branchId) {
          throw new BadRequestException(`${label}: trip ${trip.number} is of another branch`);
        }
        lines.push({ ...base, tripId: trip.id });
      } else {
        const code = line.expenseCategoryCode ?? '';
        if (!categories.get(code)) {
          throw new BadRequestException(`${label}: unknown or inactive expense category`);
        }
        lines.push({ ...base, expenseCategoryCode: code });
      }
    }
    const total = lines.reduce((sum, l) => sum.plus(l.amount), ZERO);
    return {
      lines,
      fields: {
        branchId: input.branchId,
        supplierReference: input.supplierReference ?? null,
        currency: currency.code,
        fxRate,
        billDate: toDbDate(input.billDate),
        dueDate: toDbDate(input.dueDate),
        notes: input.notes ?? null,
        total,
        totalUsd: toUsd(total, fxRate, currency.code),
      },
    };
  }

  private async findScoped(user: AuthUser, id: string): Promise<BillWithDetails> {
    const bill = await this.prisma.supplierBill.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!bill) throw new NotFoundException('Supplier bill not found');
    return bill;
  }
}

/** A rate the request named is the rate the document has (USD is always 1). */
function sameRate(stored: Decimal, currency: string, sent: string | null | undefined): boolean {
  return currency === BASE_CURRENCY || !sent || stored.eq(dec(sent));
}

function checkAmount(amount: Decimal, decimals: number, label = 'Amount'): void {
  if (!amount.gt(0) || !roundMoney(amount, decimals).eq(amount)) {
    throw new BadRequestException(`${label}: must be positive with ${decimals} decimal places`);
  }
}

/** Row lock, then 409 unless the bill has one of the expected statuses; returns its status. */
async function lockStatus(
  tx: Tx,
  id: string,
  expected: readonly SupplierBillStatus[],
): Promise<SupplierBillStatus> {
  const rows = await tx.$queryRaw<{ status: SupplierBillStatus }[]>`
    SELECT "status"::text AS "status" FROM "supplier_bills" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const status = rows[0]?.status;
  if (!status || !expected.includes(status)) {
    throw new ConflictException('The bill was changed by someone else; reload it');
  }
  return status;
}

function balance(b: { total: Decimal; paidAmount: Decimal }): Decimal {
  return b.total.minus(b.paidAmount);
}

function toSummary(b: BillWithDetails): SupplierBillSummaryDto {
  return {
    id: b.id,
    number: b.number,
    branchId: b.branchId,
    supplierId: b.supplierId,
    supplierName: b.supplier.name,
    supplierReference: b.supplierReference,
    isOpening: b.isOpening,
    currency: b.currency,
    billDate: fromDbDate(b.billDate),
    dueDate: fromDbDate(b.dueDate),
    status: b.status,
    total: b.total.toFixed(),
    paidAmount: b.paidAmount.toFixed(),
    balance: balance(b).toFixed(),
  };
}

function toDto(b: BillWithDetails, user: AuthUser): SupplierBillDto {
  const isDraft = b.status === 'DRAFT';
  const can = (p: 'update' | 'approve' | 'cancel') => user.permissions.has(`suppliers:${p}`);
  const cancellable = isDraft || (b.status === 'APPROVED' && !b.isOpening && b.paidAmount.isZero());
  return {
    ...toSummary(b),
    fxRate: b.fxRate.toFixed(),
    totalUsd: b.totalUsd.toFixed(),
    notes: b.notes,
    lines: b.lines.map((l) => ({
      lineNo: l.lineNo,
      kind: l.kind,
      chargeTypeCode: l.chargeTypeCode,
      shipmentId: l.shipmentId,
      shipmentNumber: l.shipment?.number ?? null,
      tripId: l.tripId,
      tripNumber: l.trip?.number ?? null,
      expenseCategoryCode: l.expenseCategoryCode,
      description: l.description,
      amount: l.amount.toFixed(),
    })),
    payments: b.allocations.map((a) => ({
      paymentId: a.payment.id,
      paymentNumber: a.payment.number,
      paymentDate: fromDbDate(a.payment.paymentDate),
      amount: a.amount.toFixed(),
      cancelled: a.payment.status === 'CANCELLED',
    })),
    journalEntryId: b.journalEntryId,
    journalEntryNumber: b.journalEntry?.number ?? null,
    cancelJournalEntryId: b.cancelJournalEntryId,
    cancelJournalEntryNumber: b.cancelJournal?.number ?? null,
    approvedAt: b.approvedAt?.toISOString() ?? null,
    cancelReason: b.cancelReason,
    actions: {
      canEdit: isDraft && can('update'),
      canApprove: isDraft && can('approve'),
      canCancel: cancellable && can('cancel'),
    },
  };
}
