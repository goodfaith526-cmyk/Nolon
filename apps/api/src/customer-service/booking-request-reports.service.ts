import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { sqlDate, uuidList } from '../common/report-sql.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Where a bot booking request came from, for the marketing summary. */
export type RequestSource = 'bot' | 'website';

export interface MarketingRequestRow {
  month: string;
  originId: string | null;
  destinationId: string | null;
  category: string | null;
  source: RequestSource;
  count: number;
}

/**
 * Counts of the bots' booking requests for the marketing summary (docs/plans/11). Counts only: no
 * customer, sender, phone, name or amount.
 */
@Injectable()
export class BookingRequestReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Requests made between `from` and `to` that belong to `branchIds`: routed to one of them, or
   * awaiting routing with one of them among their candidates. Days are in the request's branch
   * (UTC while it awaits routing). By month, route, shipment type and source: the website chat
   * (sender channel web) or a bot (Telegram, WhatsApp, or a customer token). A request with several
   * item types counts once under each; one without items counts under its own type.
   */
  async marketingMonthly(
    branchIds: readonly string[],
    from: string,
    to: string,
  ): Promise<MarketingRequestRow[]> {
    if (branchIds.length === 0) return [];
    const branches = Prisma.sql`ARRAY[${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))}]`;
    const day = Prisma.sql`(r."created_at" AT TIME ZONE coalesce(b."timezone", 'UTC'))::date`;
    return this.prisma.$queryRaw`
      SELECT to_char(${day}, 'YYYY-MM') AS "month",
             r."origin_location_id"::text AS "originId",
             r."destination_location_id"::text AS "destinationId",
             c."category" AS "category",
             CASE WHEN r."sender_channel" = 'web' THEN 'website' ELSE 'bot' END AS "source",
             count(*)::int AS "count"
      FROM "cs_booking_requests" r
      LEFT JOIN "branches" b ON b."id" = r."branch_id"
      LEFT JOIN LATERAL (
        SELECT DISTINCT i."price_category_code" AS "category"
        FROM "cs_booking_request_items" i WHERE i."request_id" = r."id"
        UNION
        SELECT r."price_category_code"
        WHERE NOT EXISTS (SELECT 1 FROM "cs_booking_request_items" n WHERE n."request_id" = r."id")
      ) c ON true
      WHERE (r."branch_id" IN ${uuidList(branchIds)}
             OR (r."branch_id" IS NULL AND r."allowed_branch_ids" && ${branches}))
        AND ${day} BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
      GROUP BY 1, 2, 3, 4, 5`;
  }
}
