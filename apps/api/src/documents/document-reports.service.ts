import { Injectable } from '@nestjs/common';
import type { AuditLogEntryDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { type AuditQuery, andIf, sqlDate, uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Audit log source (annex D section 3, report 10): shipment documents uploaded and deleted. */
@Injectable()
export class DocumentReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string;
        userId: string;
        userName: string;
        action: 'UPLOADED' | 'DELETED';
        reference: string;
        detail: string;
      }[]
    >`
      WITH events AS (
        SELECT x."branch_id", x."uploaded_at" AS "at", x."uploaded_by_id" AS "user_id",
               'UPLOADED' AS "action", x."file_name" AS "reference", x."type_code" AS "detail"
        FROM "documents" x
        UNION ALL
        SELECT x."branch_id", x."deleted_at", x."deleted_by_id", 'DELETED', x."file_name",
               x."type_code"
        FROM "documents" x WHERE x."deleted_at" IS NOT NULL AND x."deleted_by_id" IS NOT NULL
      )
      SELECT x."at", b."code" AS "branchCode", x."user_id" AS "userId", u."full_name" AS "userName",
             x."action", x."reference", x."detail"
      FROM events x
      JOIN "branches" b ON b."id" = x."branch_id"
      JOIN "users" u ON u."id" = x."user_id"
      WHERE x."branch_id" IN ${uuidList(branchIds)}
        AND (x."at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.userId, (id) => Prisma.sql`x."user_id" = ${id}::uuid`)}
      ORDER BY x."at" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map((r) => ({ ...r, at: r.at.toISOString(), entity: 'DOCUMENT', status: null }));
  }
}
