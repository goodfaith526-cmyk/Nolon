import { Injectable } from '@nestjs/common';
import { sqlDate } from '../common/report-sql.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Customer counts for reports: numbers only, never a customer's name, number or contact. */
@Injectable()
export class CustomerReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The marketing summary's new customers (docs/plans/11), by month: people whose first customer
   * account was opened between `from` and `to` (the day in that account's branch). Customers are
   * central (owner 2026-11-04), so every branch counts; a person is their unified profile, or the
   * account itself when it has none, so a second branch account is not a new customer.
   */
  async newCustomersByMonth(from: string, to: string): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ month: string; count: number }[]>`
      SELECT to_char(p."first_day", 'YYYY-MM') AS "month", count(*)::int AS "count"
      FROM (
        SELECT min((c."created_at" AT TIME ZONE b."timezone")::date) AS "first_day"
        FROM "customers" c
        JOIN "branches" b ON b."id" = c."branch_id"
        GROUP BY coalesce(c."profile_id", c."id")
      ) p
      WHERE p."first_day" BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.month, r.count]));
  }
}
