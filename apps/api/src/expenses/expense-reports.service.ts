import { Injectable } from '@nestjs/common';
import type { AuditLogEntryDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import {
  type AuditQuery,
  type DocumentAuditRow,
  documentAuditSql,
  toAuditEntry,
} from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** What the expenses module gives the reports: its audit log entries. */
@Injectable()
export class ExpenseReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Audit log: general expenses created, approved and cancelled, recorded in the period (days in
   * the expense's branch), newest first, with the status each step reached. A draft has no
   * number yet ("—").
   */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const events = Prisma.sql`
      SELECT e."branch_id", e."created_at" AS "at", e."created_by_id" AS "user_id",
             'EXPENSE' AS "entity", 'CREATED' AS "action",
             coalesce(e."number", '—') AS "reference", 'DRAFT' AS "status",
             e."description" AS "detail"
      FROM "expenses" e
      UNION ALL
      SELECT e."branch_id", e."approved_at", e."approved_by_id", 'EXPENSE', 'APPROVED',
             e."number", 'APPROVED', NULL
      FROM "expenses" e WHERE e."approved_at" IS NOT NULL
      UNION ALL
      SELECT e."branch_id", e."cancelled_at", e."cancelled_by_id", 'EXPENSE', 'CANCELLED',
             coalesce(e."number", '—'), 'CANCELLED', e."cancel_reason"
      FROM "expenses" e WHERE e."cancelled_at" IS NOT NULL`;
    const rows = await this.prisma.$queryRaw<DocumentAuditRow[]>(
      documentAuditSql(events, branchIds, q),
    );
    return rows.map(toAuditEntry);
  }
}
