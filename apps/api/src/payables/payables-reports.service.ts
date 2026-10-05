import { Injectable } from '@nestjs/common';
import type { ApAgingBillDto, ApAgingDto, AuditLogEntryDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { AgingTotals, agingBucket, daysPastDue } from '../billing/aging.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, dec } from '../common/money.js';
import {
  type AuditQuery,
  type DocumentAuditRow,
  documentAuditSql,
  toAuditEntry,
} from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Payables reports (annex D section 4, report 6): AP aging, and the payables' audit log entries. Only bills whose approval entry is
 * POSTED count, in the report's branches (the requested one, checked against the user's, or all of
 * the user's).
 */
@Injectable()
export class PayablesReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bills open as of a date: approved by then (its entry dated on or before the date) and not
   * cancelled by then, less the payments allocated to them dated on or before the date and not
   * cancelled by then (a cancellation counts from its reversing entry's date). Buckets are on the
   * USD carrying value still open, by days past the due date.
   */
  async apAging(
    user: AuthUser,
    asOf: string,
    branchId?: string,
    supplierId?: string,
  ): Promise<ApAgingDto> {
    const branchIds = reportBranchIds(user, branchId);
    const at = toDbDate(asOf);
    const onlySupplier = supplierId
      ? Prisma.sql`AND sb."supplier_id" = ${supplierId}::uuid`
      : Prisma.empty;
    const rows =
      branchIds.length === 0
        ? []
        : await this.prisma.$queryRaw<
            {
              billId: string;
              number: string;
              supplierReference: string | null;
              branchCode: string;
              supplierId: string;
              supplierName: string;
              billDate: Date;
              dueDate: Date;
              currency: string;
              total: Decimal;
              outstanding: Decimal;
              outstandingUsd: Decimal;
            }[]
          >`
            WITH paid AS (
              SELECT a."bill_id", sum(a."amount") AS "amount", sum(a."relieved_usd") AS "usd"
              FROM "supplier_payment_allocations" a
              JOIN "supplier_payments" p ON p."id" = a."payment_id"
              JOIN "journal_entries" pe ON pe."id" = p."journal_entry_id" AND pe."status" = 'POSTED'
              WHERE p."payment_date" <= ${at}
                AND NOT EXISTS (
                  SELECT 1 FROM "journal_entries" ce
                  WHERE ce."id" = p."cancel_journal_entry_id" AND ce."status" = 'POSTED'
                    AND ce."entry_date" <= ${at})
              GROUP BY a."bill_id"
            )
            SELECT sb."id" AS "billId", sb."number", sb."supplier_reference" AS "supplierReference",
                   b."code" AS "branchCode", sb."supplier_id" AS "supplierId",
                   s."name" AS "supplierName", sb."bill_date" AS "billDate",
                   sb."due_date" AS "dueDate", sb."currency", sb."total",
                   sb."total" - coalesce(p."amount", 0) AS "outstanding",
                   sb."total_usd" - coalesce(p."usd", 0) AS "outstandingUsd"
            FROM "supplier_bills" sb
            JOIN "journal_entries" be ON be."id" = sb."journal_entry_id" AND be."status" = 'POSTED'
            LEFT JOIN "journal_entries" ce ON ce."id" = sb."cancel_journal_entry_id" AND ce."status" = 'POSTED'
            LEFT JOIN paid p ON p."bill_id" = sb."id"
            JOIN "branches" b ON b."id" = sb."branch_id"
            JOIN "suppliers" s ON s."id" = sb."supplier_id"
            WHERE sb."status" IN ('APPROVED', 'CANCELLED')
              AND be."entry_date" <= ${at}
              AND (ce."id" IS NULL OR ce."entry_date" > ${at})
              AND sb."branch_id" IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
              ${onlySupplier}
              AND (sb."total" - coalesce(p."amount", 0) <> 0
                   OR sb."total_usd" - coalesce(p."usd", 0) <> 0)
            ORDER BY s."name", sb."due_date", sb."number"`;
    const totals = new AgingTotals();
    const bySupplier = new Map<string, { name: string; totals: AgingTotals }>();
    const bills: ApAgingBillDto[] = rows.map((r) => {
      const dueDate = fromDbDate(r.dueDate);
      const days = daysPastDue(asOf, dueDate);
      const bucket = agingBucket(days);
      const outstandingUsd = dec(r.outstandingUsd);
      totals.add(bucket, outstandingUsd);
      const supplier = bySupplier.get(r.supplierId) ?? {
        name: r.supplierName,
        totals: new AgingTotals(),
      };
      supplier.totals.add(bucket, outstandingUsd);
      bySupplier.set(r.supplierId, supplier);
      return {
        billId: r.billId,
        number: r.number,
        supplierReference: r.supplierReference,
        branchCode: r.branchCode,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        billDate: fromDbDate(r.billDate),
        dueDate,
        currency: r.currency,
        total: dec(r.total).toFixed(),
        outstanding: dec(r.outstanding).toFixed(),
        outstandingUsd: outstandingUsd.toFixed(),
        daysPastDue: days,
        bucket,
      };
    });
    return {
      asOf,
      branchId: branchId ?? null,
      supplierId: supplierId ?? null,
      suppliers: [...bySupplier].map(([id, s]) => ({
        supplierId: id,
        supplierName: s.name,
        amounts: s.totals.toDto(),
      })),
      bills,
      totals: totals.toDto(),
    };
  }

  /**
   * Audit log: supplier bills created, approved and cancelled, and supplier payments posted and
   * cancelled, recorded in the period (days in the document's branch), newest first, with the
   * status each step reached. A draft bill has no number yet ("—"); an opening bill is created
   * approved.
   */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const events = Prisma.sql`
      SELECT b."branch_id", b."created_at" AS "at", b."created_by_id" AS "user_id",
             'SUPPLIER_BILL' AS "entity", 'CREATED' AS "action",
             coalesce(b."number", '—') AS "reference",
             CASE WHEN b."is_opening" THEN 'APPROVED' ELSE 'DRAFT' END AS "status",
             b."supplier_reference" AS "detail"
      FROM "supplier_bills" b
      UNION ALL
      SELECT b."branch_id", b."approved_at", b."approved_by_id", 'SUPPLIER_BILL', 'APPROVED',
             b."number", 'APPROVED', NULL
      FROM "supplier_bills" b WHERE b."approved_at" IS NOT NULL AND NOT b."is_opening"
      UNION ALL
      SELECT b."branch_id", b."cancelled_at", b."cancelled_by_id", 'SUPPLIER_BILL', 'CANCELLED',
             coalesce(b."number", '—'), 'CANCELLED', b."cancel_reason"
      FROM "supplier_bills" b WHERE b."cancelled_at" IS NOT NULL
      UNION ALL
      SELECT p."branch_id", p."created_at", p."created_by_id", 'SUPPLIER_PAYMENT', 'POSTED',
             p."number", 'POSTED', p."reference"
      FROM "supplier_payments" p
      UNION ALL
      SELECT p."branch_id", p."cancelled_at", p."cancelled_by_id", 'SUPPLIER_PAYMENT',
             'CANCELLED', p."number", 'CANCELLED', p."cancel_reason"
      FROM "supplier_payments" p WHERE p."cancelled_at" IS NOT NULL`;
    const rows = await this.prisma.$queryRaw<DocumentAuditRow[]>(
      documentAuditSql(events, branchIds, q),
    );
    return rows.map(toAuditEntry);
  }
}
