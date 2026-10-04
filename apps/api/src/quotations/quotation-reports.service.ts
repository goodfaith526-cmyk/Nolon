import { Injectable } from '@nestjs/common';
import type { QuotationStatus } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { andIf, sqlDate, uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Quotation figures for the sales conversion report (annex D section 3, report 3): the quotations
 * sent in the period (by the day they were sent, in their branch), in the report's branches.
 */
@Injectable()
export class QuotationReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async sentInPeriod(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string; customerId?: string },
  ): Promise<{
    counts: { branchId: string; status: QuotationStatus; count: number }[];
    /** Approved ones (the only ones a booking can be made from), for the booking check. */
    approved: { id: string; branchId: string }[];
  }> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return { counts: [], approved: [] };
    const where = Prisma.sql`
      FROM "quotations" x
      JOIN "branches" b ON b."id" = x."branch_id"
      WHERE x."branch_id" IN ${uuidList(branchIds)}
        AND x."sent_at" IS NOT NULL
        AND (x."sent_at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.customerId, (id) => Prisma.sql`x."customer_id" = ${id}::uuid`)}`;
    const [counts, approved] = await Promise.all([
      this.prisma.$queryRaw<{ branchId: string; status: QuotationStatus; count: number }[]>`
        SELECT x."branch_id" AS "branchId", x."status"::text AS "status", count(*)::int AS "count"
        ${where}
        GROUP BY x."branch_id", x."status"`,
      this.prisma.$queryRaw<{ id: string; branchId: string }[]>`
        SELECT x."id", x."branch_id" AS "branchId" ${where} AND x."status" = 'APPROVED'`,
    ]);
    return { counts, approved };
  }
}
