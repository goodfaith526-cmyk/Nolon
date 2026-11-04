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

  /**
   * The marketing summary's bookings (docs/plans/11) in `branchIds`, made between `from` and `to`
   * (days in their branch): counts by month, route, shipment type, whether a bot request made it,
   * and status now. A booking with several types counts once under each; none is a null type.
   * Counts only: no customer, number or amount.
   */
  async marketingMonthly(
    branchIds: readonly string[],
    from: string,
    to: string,
  ): Promise<
    {
      month: string;
      originId: string;
      destinationId: string;
      category: string | null;
      fromRequest: boolean;
      status: BookingStatus;
      count: number;
    }[]
  > {
    if (branchIds.length === 0) return [];
    return this.prisma.$queryRaw`
      SELECT to_char((k."created_at" AT TIME ZONE b."timezone")::date, 'YYYY-MM') AS "month",
             k."origin_location_id"::text AS "originId",
             k."destination_location_id"::text AS "destinationId",
             c."category" AS "category",
             EXISTS (SELECT 1 FROM "cs_booking_requests" r WHERE r."booking_id" = k."id") AS "fromRequest",
             k."status"::text AS "status", count(*)::int AS "count"
      FROM "bookings" k
      JOIN "branches" b ON b."id" = k."branch_id"
      LEFT JOIN LATERAL (
        SELECT DISTINCT i."price_category_code" AS "category"
        FROM "booking_items" i WHERE i."booking_id" = k."id"
      ) c ON true
      WHERE k."branch_id" IN ${uuidList(branchIds)}
        AND (k."created_at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
      GROUP BY 1, 2, 3, 4, 5, 6`;
  }
}
