import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateSupplierPaymentRequest,
  Page,
  SupplierPaymentDto,
  SupplierPaymentStatus,
  SupplierPaymentSummaryDto,
} from '@nolon/shared';
import { AccountsService } from '../accounting/accounts.service.js';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import { USD_DECIMALS } from '../accounting/journal-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { ZERO, dec, roundMoney } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { relievedUsd } from '../billing/invoice-math.js';
import { Prisma, type SupplierPayment } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SuppliersService } from './suppliers.service.js';

export interface SupplierPaymentFilters extends PageQuery {
  status?: SupplierPaymentStatus;
  supplierId?: string;
}

type Tx = Prisma.TransactionClient;

const details = {
  supplier: { select: { name: true } },
  cashAccount: { select: { code: true, nameEn: true, nameAr: true } },
  journalEntry: { select: { number: true } },
  cancelJournal: { select: { number: true } },
  allocations: {
    include: { bill: { select: { number: true } } },
    orderBy: { bill: { number: 'asc' } },
  },
} satisfies Prisma.SupplierPaymentInclude;

type PaymentWithDetails = Prisma.SupplierPaymentGetPayload<{ include: typeof details }>;

/**
 * Payments to suppliers (annex C rule 9 and section 3). Recording a payment posts its entry at
 * once: money out of a cash or bank account, paying approved bills of the supplier in one branch
 * and currency, in full (there are no supplier advances in phase 1). The realized exchange
 * difference against the bills' rates is booked with it. A mistaken payment is cancelled, which
 * posts the reversing entry and gives the amounts back to the bills.
 */
@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly accounts: AccountsService,
    private readonly fxRates: FxRatesService,
    private readonly currencies: CurrenciesService,
    private readonly suppliers: SuppliersService,
  ) {}

  async list(
    user: AuthUser,
    filters: SupplierPaymentFilters,
  ): Promise<Page<SupplierPaymentSummaryDto>> {
    const where: Prisma.SupplierPaymentWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { reference: { contains: filters.q, mode: 'insensitive' } },
              { supplier: { name: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.supplierPayment.findMany({
        where,
        include: details,
        orderBy: [{ paymentDate: 'desc' }, { number: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.supplierPayment.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<SupplierPaymentDto> {
    return toDto(await this.findScoped(user, id), user);
  }

  /**
   * Records the payment and posts its entry. The client's `requestId` becomes the payment's id:
   * an exact retry returns the first payment and posts nothing more; anything else reusing the id
   * is refused.
   */
  async create(user: AuthUser, input: CreateSupplierPaymentRequest): Promise<SupplierPaymentDto> {
    assertBranchAccess(user, input.branchId);
    await this.suppliers.requireSupplier(input.supplierId);
    const billIds = input.allocations.map((a) => a.billId);
    if (billIds.length === 0) throw new BadRequestException('Allocate the payment to bills');
    if (new Set(billIds).size !== billIds.length) {
      throw new BadRequestException('Each bill appears once');
    }
    const amount = input.allocations.reduce((sum, a) => sum.plus(dec(a.amount)), ZERO);
    const done = await this.prisma.supplierPayment.findUnique({ where: { id: input.requestId } });
    if (done) return this.retry(user, done, input);
    try {
      await this.prisma.$transaction(async (tx) => {
        const currency = await this.currencies.requireActiveInTx(tx, input.currency);
        const decimals = currency.decimalPlaces;
        const fxRate = await this.fxRates.resolve(currency.code, input.paymentDate, input.fxRate);
        await this.accounts.requireCash(tx, input.cashAccountId, input.branchId, currency.code);
        // Lock the bills in a fixed order so two payments for the same bills cannot deadlock.
        const bills = await lockBills(tx, [...billIds].sort());
        // A retry that queued on the same bills finds the payment the first request committed.
        if (await tx.supplierPayment.findUnique({ where: { id: input.requestId } })) {
          throw new AlreadyRecorded();
        }
        const allocations = input.allocations.map((a) => {
          const bill = bills.get(a.billId);
          if (!bill || bill.supplierId !== input.supplierId || bill.branchId !== input.branchId) {
            throw new BadRequestException(
              'An allocation is to a bill of another supplier or branch',
            );
          }
          if (bill.status !== 'APPROVED' || !bill.payableAccountId) {
            throw new BadRequestException(`Bill ${bill.number ?? ''} is not approved`);
          }
          if (bill.currency !== currency.code) {
            throw new BadRequestException(
              `Bill ${bill.number ?? ''} is in ${bill.currency}; pay it in that currency`,
            );
          }
          const share = dec(a.amount);
          if (!share.gt(0) || !roundMoney(share, decimals).eq(share)) {
            throw new BadRequestException(
              `Allocated amounts must be positive with ${decimals} decimal places`,
            );
          }
          const outstanding = bill.total.minus(bill.paidAmount);
          if (share.gt(outstanding)) {
            throw new BadRequestException(
              `Bill ${bill.number ?? ''} has ${outstanding.toFixed()} ${bill.currency} left`,
            );
          }
          return {
            bill,
            payableAccountId: bill.payableAccountId,
            amount: share,
            relievedUsd: relievedUsd(bill, share, bill.fxRate, bill.currency, USD_DECIMALS),
          };
        });
        const year = input.paymentDate.slice(0, 4);
        const number = formatDocumentNumber(
          'SP',
          await nextSequenceValue(tx, 'SUPPLIER_PAYMENT', year),
          year,
        );
        const entry = await this.autoJournal.supplierPaymentRecorded(
          tx,
          {
            id: input.requestId,
            number,
            branchId: input.branchId,
            supplierId: input.supplierId,
            paymentDate: input.paymentDate,
            currency: currency.code,
            fxRate,
            amount,
            cashAccountId: input.cashAccountId,
            allocations: allocations.map((a) => ({
              billNumber: a.bill.number ?? '',
              payableAccountId: a.payableAccountId,
              billFxRate: a.bill.fxRate,
              amount: a.amount,
              relievedUsd: a.relievedUsd,
            })),
          },
          user.id,
        );
        await tx.supplierPayment.create({
          data: {
            id: input.requestId,
            number,
            branchId: input.branchId,
            supplierId: input.supplierId,
            paymentDate: toDbDate(input.paymentDate),
            currency: currency.code,
            fxRate,
            requestedFxRate: input.fxRate ? dec(input.fxRate) : null,
            amount,
            cashAccountId: input.cashAccountId,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            journalEntryId: entry.id,
            createdById: user.id,
            allocations: {
              create: allocations.map((a) => ({
                billId: a.bill.id,
                amount: a.amount,
                relievedUsd: a.relievedUsd,
              })),
            },
          },
        });
        for (const a of allocations) {
          await tx.supplierBill.update({
            where: { id: a.bill.id },
            data: { paidAmount: { increment: a.amount }, paidUsd: { increment: a.relievedUsd } },
          });
        }
      });
    } catch (error) {
      if (!(error instanceof AlreadyRecorded) && !isUniqueViolation(error)) throw error;
      // A concurrent request with the same id committed first.
      const raced = await this.prisma.supplierPayment.findUnique({
        where: { id: input.requestId },
      });
      if (!raced) throw error;
      return this.retry(user, raced, input);
    }
    return this.get(user, input.requestId);
  }

  /** Posts the reversing entry, dated today in the branch, and gives the amounts back. */
  async cancel(user: AuthUser, id: string, reason: string): Promise<SupplierPaymentDto> {
    const existing = await this.findScoped(user, id);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: existing.branchId },
      select: { timezone: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "supplier_payments" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (rows[0]?.status !== 'POSTED') {
        throw new ConflictException('The payment is already cancelled');
      }
      const allocations = await tx.supplierPaymentAllocation.findMany({ where: { paymentId: id } });
      await lockBills(tx, allocations.map((a) => a.billId).sort());
      const reversal = await this.autoJournal.reverseDocumentEntry(
        tx,
        existing.journalEntryId,
        todayIn(branch.timezone),
        user.id,
        `Cancellation of supplier payment ${existing.number}: ${reason}`,
      );
      for (const a of allocations) {
        await tx.supplierBill.update({
          where: { id: a.billId },
          data: { paidAmount: { decrement: a.amount }, paidUsd: { decrement: a.relievedUsd } },
        });
      }
      await tx.supplierPayment.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: new Date(),
          cancelledById: user.id,
          cancelJournalEntryId: reversal.id,
        },
      });
    });
    return this.get(user, id);
  }

  /** An exact retry gets the first payment; anything else reusing the id is refused. */
  private async retry(
    user: AuthUser,
    done: SupplierPayment,
    input: CreateSupplierPaymentRequest,
  ): Promise<SupplierPaymentDto> {
    const allocations = await this.prisma.supplierPaymentAllocation.findMany({
      where: { paymentId: done.id },
    });
    const asked = new Map(input.allocations.map((a) => [a.billId, dec(a.amount)]));
    const same =
      done.createdById === user.id &&
      sameRequestedRate(done.requestedFxRate, input.fxRate) &&
      done.reference === (input.reference ?? null) &&
      done.notes === (input.notes ?? null) &&
      done.supplierId === input.supplierId &&
      done.branchId === input.branchId &&
      done.currency === input.currency &&
      done.cashAccountId === input.cashAccountId &&
      fromDbDate(done.paymentDate) === input.paymentDate &&
      allocations.length === asked.size &&
      allocations.every((a) => asked.get(a.billId)?.eq(a.amount) === true);
    if (!same) {
      throw new ConflictException(
        'This request id was already used for a different payment: send a new id',
      );
    }
    return this.get(user, done.id);
  }

  private async findScoped(user: AuthUser, id: string): Promise<PaymentWithDetails> {
    const payment = await this.prisma.supplierPayment.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!payment) throw new NotFoundException('Supplier payment not found');
    return payment;
  }
}

/**
 * Whether the retry sent the rate the first request sent, at Decimal precision: both omitted, or
 * both the same number. The rate the first request resolved from the table is not consulted, so
 * editing the table afterwards does not turn an exact retry into a conflict.
 */
function sameRequestedRate(
  stored: Prisma.Decimal | null,
  sent: string | null | undefined,
): boolean {
  if (!sent) return stored === null;
  return stored !== null && stored.eq(dec(sent));
}

/** Raised inside the transaction when the payment id is already recorded. */
class AlreadyRecorded extends Error {}

interface LockedBill {
  id: string;
  number: string | null;
  supplierId: string;
  branchId: string;
  status: string;
  payableAccountId: string | null;
  currency: string;
  fxRate: Prisma.Decimal;
  total: Prisma.Decimal;
  totalUsd: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  paidUsd: Prisma.Decimal;
}

async function lockBills(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedBill>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<LockedBill[]>`
    SELECT "id", "number", "supplier_id" AS "supplierId", "branch_id" AS "branchId",
           "status"::text AS "status", "payable_account_id" AS "payableAccountId", "currency",
           "fx_rate" AS "fxRate", "total", "total_usd" AS "totalUsd",
           "paid_amount" AS "paidAmount", "paid_usd" AS "paidUsd"
    FROM "supplier_bills"
    WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY "id"
    FOR UPDATE`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        ...r,
        fxRate: new Prisma.Decimal(r.fxRate),
        total: new Prisma.Decimal(r.total),
        totalUsd: new Prisma.Decimal(r.totalUsd),
        paidAmount: new Prisma.Decimal(r.paidAmount),
        paidUsd: new Prisma.Decimal(r.paidUsd),
      },
    ]),
  );
}

function toSummary(p: PaymentWithDetails): SupplierPaymentSummaryDto {
  return {
    id: p.id,
    number: p.number,
    branchId: p.branchId,
    supplierId: p.supplierId,
    supplierName: p.supplier.name,
    paymentDate: fromDbDate(p.paymentDate),
    currency: p.currency,
    amount: p.amount.toFixed(),
    status: p.status,
  };
}

function toDto(p: PaymentWithDetails, user: AuthUser): SupplierPaymentDto {
  return {
    ...toSummary(p),
    fxRate: p.fxRate.toFixed(),
    cashAccountId: p.cashAccountId,
    cashAccountCode: p.cashAccount.code,
    cashAccountNameEn: p.cashAccount.nameEn,
    cashAccountNameAr: p.cashAccount.nameAr,
    reference: p.reference,
    notes: p.notes,
    allocations: p.allocations.map((a) => ({
      billId: a.billId,
      billNumber: a.bill.number ?? '',
      amount: a.amount.toFixed(),
      relievedUsd: a.relievedUsd.toFixed(),
    })),
    journalEntryId: p.journalEntryId,
    journalEntryNumber: p.journalEntry.number,
    cancelJournalEntryId: p.cancelJournalEntryId,
    cancelJournalEntryNumber: p.cancelJournal?.number ?? null,
    cancelReason: p.cancelReason,
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    actions: {
      canCancel: p.status === 'POSTED' && user.permissions.has('supplier_payments:cancel'),
    },
  };
}
