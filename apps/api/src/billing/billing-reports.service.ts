import { Injectable } from '@nestjs/common';
import type {
  AgingAmountsDto,
  ArAgingDto,
  ArAgingInvoiceDto,
  InvoicesReceiptsDto,
} from '@nolon/shared';
import { toUsd } from '../accounting/journal-math.js';
import { sum } from '../accounting/report-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, dec } from '../common/money.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgingTotals, agingBucket, daysPastDue } from './aging.js';

/**
 * Billing reports (annex D section 4): AR aging and the invoices and receipts of a period. Only
 * approved invoices and receipts whose journal entries are POSTED count, in the report's branches
 * (the requested one, checked against the user's, or all of the user's).
 */
/** AR aging from the invoices alone; the reports module adds the customers' advances. */
export type InvoiceAging = Omit<ArAgingDto, 'customers' | 'totalAdvancesUsd' | 'netUsd'> & {
  customers: { customerId: string; customerName: string; amounts: AgingAmountsDto }[];
};

@Injectable()
export class BillingReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open approved invoices as of a date: the total less the receipts allocated to it that were
   * dated on or before the date and not cancelled by then (a cancellation counts from its
   * reversing entry's date). Buckets are on the USD carrying value still open.
   */
  async arAging(
    user: AuthUser,
    asOf: string,
    branchId?: string,
    customerId?: string,
  ): Promise<InvoiceAging> {
    const branchIds = reportBranchIds(user, branchId);
    const at = toDbDate(asOf);
    const onlyCustomer = customerId
      ? Prisma.sql`AND i."customer_id" = ${customerId}::uuid`
      : Prisma.empty;
    const rows =
      branchIds.length === 0
        ? []
        : await this.prisma.$queryRaw<
            {
              invoiceId: string;
              number: string;
              branchCode: string;
              customerId: string;
              customerName: string;
              invoiceDate: Date;
              dueDate: Date;
              currency: string;
              total: Decimal;
              outstanding: Decimal;
              outstandingUsd: Decimal;
            }[]
          >`
            SELECT i."id" AS "invoiceId", i."number", b."code" AS "branchCode",
                   i."customer_id" AS "customerId", c."name" AS "customerName",
                   i."invoice_date" AS "invoiceDate", i."due_date" AS "dueDate", i."currency",
                   i."total",
                   i."total" - coalesce(sum(a."amount") FILTER (WHERE r."id" IS NOT NULL), 0) AS "outstanding",
                   i."total_usd" - coalesce(sum(a."relieved_usd") FILTER (WHERE r."id" IS NOT NULL), 0) AS "outstandingUsd"
            FROM "customer_invoices" i
            JOIN "journal_entries" ie ON ie."id" = i."journal_entry_id" AND ie."status" = 'POSTED'
            JOIN "branches" b ON b."id" = i."branch_id"
            JOIN "customers" c ON c."id" = i."customer_id"
            LEFT JOIN "receipt_allocations" a ON a."invoice_id" = i."id"
            LEFT JOIN "receipts" r ON r."id" = a."receipt_id"
              AND r."receipt_date" <= ${at}
              AND EXISTS (
                SELECT 1 FROM "journal_entries" re
                WHERE re."id" = r."journal_entry_id" AND re."status" = 'POSTED')
              AND NOT EXISTS (
                SELECT 1 FROM "journal_entries" ce
                WHERE ce."id" = r."cancel_journal_entry_id" AND ce."status" = 'POSTED'
                  AND ce."entry_date" <= ${at})
            WHERE i."status" = 'APPROVED'
              AND i."invoice_date" <= ${at}
              AND i."branch_id" IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
              ${onlyCustomer}
            GROUP BY i."id", b."code", c."name"
            HAVING i."total" - coalesce(sum(a."amount") FILTER (WHERE r."id" IS NOT NULL), 0) <> 0
                OR i."total_usd" - coalesce(sum(a."relieved_usd") FILTER (WHERE r."id" IS NOT NULL), 0) <> 0
            ORDER BY c."name", i."due_date", i."number"`;
    const totals = new AgingTotals();
    const byCustomer = new Map<string, { name: string; totals: AgingTotals }>();
    const invoices: ArAgingInvoiceDto[] = rows.map((r) => {
      const dueDate = fromDbDate(r.dueDate);
      const days = daysPastDue(asOf, dueDate);
      const bucket = agingBucket(days);
      const outstandingUsd = dec(r.outstandingUsd);
      totals.add(bucket, outstandingUsd);
      const customer = byCustomer.get(r.customerId) ?? {
        name: r.customerName,
        totals: new AgingTotals(),
      };
      customer.totals.add(bucket, outstandingUsd);
      byCustomer.set(r.customerId, customer);
      return {
        invoiceId: r.invoiceId,
        number: r.number,
        branchCode: r.branchCode,
        customerId: r.customerId,
        customerName: r.customerName,
        invoiceDate: fromDbDate(r.invoiceDate),
        dueDate,
        currency: r.currency,
        total: dec(r.total).toFixed(),
        outstanding: dec(r.outstanding).toFixed(),
        outstandingUsd: outstandingUsd.toFixed(),
        daysPastDue: days,
        bucket,
      };
    });
    const customers = [...byCustomer].map(([id, c]) => ({
      customerId: id,
      customerName: c.name,
      amounts: c.totals.toDto(),
    }));
    return {
      asOf,
      branchId: branchId ?? null,
      customerId: customerId ?? null,
      customers,
      invoices,
      totals: totals.toDto(),
    };
  }

  /**
   * Approved invoices dated in the period and receipts dated in it. A receipt is shown cancelled,
   * and left out of the received total, only when its cancellation entry is posted and dated on or
   * before the end of the period (as in AR aging): a later cancellation does not rewrite the past. A receipt's USD value is its cash line's, the
   * amount at the receipt's rate.
   */
  async invoicesAndReceipts(
    user: AuthUser,
    from: string,
    to: string,
    branchId?: string,
    customerId?: string,
  ): Promise<InvoicesReceiptsDto> {
    const branchIds = reportBranchIds(user, branchId);
    const common = {
      branchId: { in: branchIds },
      journalEntry: { status: 'POSTED' as const },
      ...(customerId ? { customerId } : {}),
    };
    const [invoices, receipts] = await Promise.all([
      this.prisma.customerInvoice.findMany({
        where: {
          ...common,
          status: 'APPROVED',
          invoiceDate: { gte: toDbDate(from), lte: toDbDate(to) },
        },
        include: {
          branch: { select: { code: true } },
          customer: { select: { name: true } },
          shipment: { select: { number: true } },
        },
        orderBy: [{ invoiceDate: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.receipt.findMany({
        where: { ...common, receiptDate: { gte: toDbDate(from), lte: toDbDate(to) } },
        include: {
          branch: { select: { code: true } },
          customer: { select: { name: true } },
          cashAccount: { select: { code: true } },
          cancelJournal: { select: { status: true, entryDate: true } },
        },
        orderBy: [{ receiptDate: 'asc' }, { number: 'asc' }],
      }),
    ]);
    const receiptRows = receipts.map((r) => ({
      receiptId: r.id,
      number: r.number,
      receiptDate: fromDbDate(r.receiptDate),
      branchCode: r.branch.code,
      customerId: r.customerId,
      customerName: r.customer.name,
      currency: r.currency,
      amount: r.amount.toFixed(),
      amountUsd: toUsd(r.amount, r.fxRate, r.currency),
      cashAccountCode: r.cashAccount.code,
      status:
        r.cancelJournal?.status === 'POSTED' && r.cancelJournal.entryDate <= toDbDate(to)
          ? ('CANCELLED' as const)
          : ('POSTED' as const),
    }));
    return {
      from,
      to,
      branchId: branchId ?? null,
      customerId: customerId ?? null,
      invoices: invoices.map((i) => ({
        invoiceId: i.id,
        number: i.number ?? '',
        invoiceDate: fromDbDate(i.invoiceDate),
        dueDate: fromDbDate(i.dueDate),
        branchCode: i.branch.code,
        customerId: i.customerId,
        customerName: i.customer.name,
        shipmentNumber: i.shipment.number,
        currency: i.currency,
        total: i.total.toFixed(),
        totalUsd: i.totalUsd.toFixed(),
      })),
      receipts: receiptRows.map((r) => ({ ...r, amountUsd: r.amountUsd.toFixed() })),
      totalInvoicedUsd: sum(invoices.map((i) => i.totalUsd)).toFixed(),
      totalReceivedUsd: sum(
        receiptRows.filter((r) => r.status === 'POSTED').map((r) => r.amountUsd),
      ).toFixed(),
    };
  }
}
