import { Injectable } from '@nestjs/common';
import type { BookingStatus } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { andIf, sqlDate, uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Most quotation ids checked per query (bound parameters are limited). */
const ID_CHUNK = 1000;

/**
 * Booking figures for the sales conversion report (annex D section 3, report 3), in the report's
 * branches: bookings created in the period, and which quotations were booked.
 */
@Injectable()
export class BookingReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bookings created in the period (days in their branch), by branch, status and origin. */
  async createdInPeriod(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string; customerId?: string },
  ): Promise<{ branchId: string; status: BookingStatus; fromQuotation: boolean; count: number }[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    return this.prisma.$queryRaw`
      SELECT k."branch_id" AS "branchId", k."status"::text AS "status",
             k."quotation_id" IS NOT NULL AS "fromQuotation", count(*)::int AS "count"
      FROM "bookings" k
      JOIN "branches" b ON b."id" = k."branch_id"
      WHERE k."branch_id" IN ${uuidList(branchIds)}
        AND (k."created_at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.customerId, (id) => Prisma.sql`k."customer_id" = ${id}::uuid`)}
      GROUP BY 1, 2, 3`;
  }

  /** Of `quotationIds`, those with a booking (not cancelled) in the user's branches. */
  async bookedQuotationIds(
    user: AuthUser,
    quotationIds: readonly string[],
    branchId?: string,
  ): Promise<Set<string>> {
    const branchIds = reportBranchIds(user, branchId);
    const booked = new Set<string>();
    if (branchIds.length === 0) return booked;
    for (let i = 0; i < quotationIds.length; i += ID_CHUNK) {
      const chunk = quotationIds.slice(i, i + ID_CHUNK);
      const rows = await this.prisma.$queryRaw<{ quotationId: string }[]>`
        SELECT k."quotation_id" AS "quotationId"
        FROM "bookings" k
        WHERE k."quotation_id" IN ${uuidList(chunk)}
          AND k."status" <> 'CANCELLED'
          AND k."branch_id" IN ${uuidList(branchIds)}`;
      for (const r of rows) booked.add(r.quotationId);
    }
    return booked;
  }
}
