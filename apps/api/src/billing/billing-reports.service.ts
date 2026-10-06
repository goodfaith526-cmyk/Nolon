import { Injectable } from '@nestjs/common';
import type {
  AgingAmountsDto,
  AuditLogEntryDto,
  ArAgingDto,
  ArAgingInvoiceDto,
  InvoicesReceiptsDto,
} from '@nolon/shared';
import { toUsd } from '../accounting/journal-math.js';
import { sum } from '../accounting/report-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { type AlertRows, type AlertSqlRow, alertRows } from '../common/alert-rows.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, dec } from '../common/money.js';
import {
  type AuditQuery,
  type DocumentAuditRow,
  andIf,
  documentAuditSql,
  sqlDate,
  toAuditEntry,
  uuidList,
} from '../common/report-sql.js';
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
   * Alert 2: approved invoices still open (less paid and credited) whose due date is more than
   * `graceDays` before today (in the invoice's branch), longest overdue first.
   */
  async overdueInvoices(user: AuthUser, graceDays: number, limit: number): Promise<AlertRows> {
    const branchIds = reportBranchIds(user);
    if (branchIds.length === 0) return { count: 0, rows: [] };
    return alertRows(
      await this.prisma.$queryRaw<AlertSqlRow[]>`
        SELECT *, count(*) OVER ()::int AS "count" FROM (
          SELECT i."id" AS "refId", i."number", b."code" AS "branchCode", c."name" AS "detail",
                 i."due_date" AS "since",
                 ((now() AT TIME ZONE b."timezone")::date - i."due_date")::int AS "days"
          FROM "customer_invoices" i
          JOIN "branches" b ON b."id" = i."branch_id"
          JOIN "customers" c ON c."id" = i."customer_id"
          WHERE i."branch_id" IN ${uuidList(branchIds)}
            AND i."status" = 'APPROVED' AND i."number" IS NOT NULL
            AND i."total" - i."paid_amount" - i."credited_amount" > 0
        ) overdue
        WHERE "days" > ${graceDays}
        ORDER BY "days" DESC, "number"
        LIMIT ${limit}`,
    );
  }

  /**
   * Open approved invoices as of a date: the total less the receipts allocated to it that were
   * dated on or before the date and not cancelled by then (a cancellation counts from its
   * reversing entry's date), and less the credit notes approved against it dated on or before the
   * date. Opening items count from their opening entry's date. Buckets are on the USD carrying
   * value still open.
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
            WITH paid AS (
              SELECT a."invoice_id", sum(a."amount") AS "amount", sum(a."relieved_usd") AS "usd"
              FROM "receipt_allocations" a
              JOIN "receipts" r ON r."id" = a."receipt_id"
              JOIN "journal_entries" re ON re."id" = r."journal_entry_id" AND re."status" = 'POSTED'
              WHERE r."receipt_date" <= ${at}
                AND NOT EXISTS (
                  SELECT 1 FROM "journal_entries" ce
                  WHERE ce."id" = r."cancel_journal_entry_id" AND ce."status" = 'POSTED'
                    AND ce."entry_date" <= ${at})
              GROUP BY a."invoice_id"
            ), credited AS (
              SELECT n."invoice_id", sum(n."amount") AS "amount", sum(n."amount_usd") AS "usd"
              FROM "credit_notes" n
              JOIN "journal_entries" ne ON ne."id" = n."journal_entry_id" AND ne."status" = 'POSTED'
              WHERE n."status" = 'APPROVED' AND n."credit_date" <= ${at}
              GROUP BY n."invoice_id"
            ), open AS (
              SELECT i."id",
                     i."total" - coalesce(p."amount", 0) - coalesce(k."amount", 0) AS "outstanding",
                     i."total_usd" - coalesce(p."usd", 0) - coalesce(k."usd", 0) AS "outstandingUsd"
              FROM "customer_invoices" i
              LEFT JOIN paid p ON p."invoice_id" = i."id"
              LEFT JOIN credited k ON k."invoice_id" = i."id"
            )
            SELECT i."id" AS "invoiceId", i."number", b."code" AS "branchCode",
                   i."customer_id" AS "customerId", c."name" AS "customerName",
                   i."invoice_date" AS "invoiceDate", i."due_date" AS "dueDate", i."currency",
                   i."total", o."outstanding", o."outstandingUsd"
            FROM "customer_invoices" i
            JOIN "journal_entries" ie ON ie."id" = i."journal_entry_id" AND ie."status" = 'POSTED'
            JOIN open o ON o."id" = i."id"
            JOIN "branches" b ON b."id" = i."branch_id"
            JOIN "customers" c ON c."id" = i."customer_id"
            WHERE i."status" = 'APPROVED'
              AND i."invoice_date" <= ${at}
              AND ie."entry_date" <= ${at}
              AND i."branch_id" IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
              ${onlyCustomer}
              AND (o."outstanding" <> 0 OR o."outstandingUsd" <> 0)
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
          // Opening items were invoiced before go-live, not in a period of this system.
          isOpening: false,
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
        shipmentNumber: i.shipment?.number ?? '',
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

  /**
   * Revenue per customer: approved invoices dated in the period whose entries are posted, in USD
   * at their own rate, most revenue first.
   */
  async revenueByCustomer(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string; customerId?: string },
    limit?: number,
  ): Promise<
    { customerId: string; customerName: string; invoices: number; revenueUsd: Decimal }[]
  > {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      { customerId: string; customerName: string; invoices: number; revenueUsd: Decimal }[]
    >`
      SELECT i."customer_id" AS "customerId", c."name" AS "customerName",
             count(*)::int AS "invoices", sum(i."total_usd") AS "revenueUsd"
      FROM "customer_invoices" i
      JOIN "journal_entries" ie ON ie."id" = i."journal_entry_id" AND ie."status" = 'POSTED'
      JOIN "customers" c ON c."id" = i."customer_id"
      WHERE i."status" = 'APPROVED'
        AND NOT i."is_opening"
        AND i."branch_id" IN ${uuidList(branchIds)}
        AND i."invoice_date" BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.customerId, (id) => Prisma.sql`i."customer_id" = ${id}::uuid`)}
      GROUP BY i."customer_id", c."name"
      ORDER BY sum(i."total_usd") DESC, c."name"
      ${limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}`;
    return rows.map((r) => ({ ...r, revenueUsd: dec(r.revenueUsd) }));
  }

  /**
   * Audit log: invoices created, approved and cancelled, receipts created and cancelled, and
   * credit notes created, approved and cancelled, recorded in the period (days in the document's
   * branch), newest first. A draft has no number yet ("—"). An invoice cancellation does not
   * record who did it. Credit notes carry the status each step reached and their reason.
   */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const events = Prisma.sql`
      SELECT i."branch_id", i."created_at" AS "at", i."created_by_id" AS "user_id",
             'INVOICE' AS "entity", 'CREATED' AS "action",
             coalesce(i."number", '—') AS "reference", NULL AS "status", NULL AS "detail"
      FROM "customer_invoices" i
      UNION ALL
      SELECT i."branch_id", i."approved_at", i."approved_by_id", 'INVOICE', 'APPROVED',
             i."number", NULL, NULL
      FROM "customer_invoices" i WHERE i."approved_at" IS NOT NULL
      UNION ALL
      SELECT i."branch_id", i."cancelled_at", NULL, 'INVOICE', 'CANCELLED',
             coalesce(i."number", '—'), NULL, i."cancel_reason"
      FROM "customer_invoices" i
      WHERE i."cancelled_at" IS NOT NULL
      UNION ALL
      SELECT r."branch_id", r."created_at", r."created_by_id", 'RECEIPT', 'CREATED',
             r."number", NULL, NULL
      FROM "receipts" r
      UNION ALL
      SELECT r."branch_id", r."cancelled_at", r."cancelled_by_id", 'RECEIPT', 'CANCELLED',
             r."number", NULL, r."cancel_reason"
      FROM "receipts" r WHERE r."cancelled_at" IS NOT NULL
      UNION ALL
      SELECT n."branch_id", n."created_at", n."created_by_id", 'CREDIT_NOTE', 'CREATED',
             coalesce(n."number", '—'), 'DRAFT', n."reason"
      FROM "credit_notes" n
      UNION ALL
      SELECT n."branch_id", n."approved_at", n."approved_by_id", 'CREDIT_NOTE', 'APPROVED',
             n."number", 'APPROVED', NULL
      FROM "credit_notes" n WHERE n."approved_at" IS NOT NULL
      UNION ALL
      SELECT n."branch_id", n."cancelled_at", n."cancelled_by_id", 'CREDIT_NOTE', 'CANCELLED',
             coalesce(n."number", '—'), 'CANCELLED', n."cancel_reason"
      FROM "credit_notes" n WHERE n."cancelled_at" IS NOT NULL`;
    const rows = await this.prisma.$queryRaw<DocumentAuditRow[]>(
      documentAuditSql(events, branchIds, q),
    );
    return rows.map(toAuditEntry);
  }
}
