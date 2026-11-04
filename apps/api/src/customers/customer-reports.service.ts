import { Injectable } from '@nestjs/common';
import { sqlDate } from '../common/report-sql.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The time zone a customer's opening day is read in: a customer has no branch (plan 09f), and the
 * network is the world to Sudan, where most branches are (PTS, ATB, KRT).
 */
const CUSTOMER_DAY_TIMEZONE = 'Africa/Khartoum';

/** Customer counts for reports: numbers only, never a customer's name, number or contact. */
@Injectable()
export class CustomerReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The marketing summary's new customers (docs/plans/11), by month: people whose first customer
   * account was opened between `from` and `to`. Customers are central and have no branch (owner
   * 2026-11-04, plan 09f), so every branch counts and the day is taken in Sudan's time
   * (CUSTOMER_DAY_TIMEZONE); a person is their unified profile, or the account itself when it has
   * none, so a second account is not a new customer.
   */
  async newCustomersByMonth(from: string, to: string): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ month: string; count: number }[]>`
      SELECT to_char(p."first_day", 'YYYY-MM') AS "month", count(*)::int AS "count"
      FROM (
        SELECT min((c."created_at" AT TIME ZONE ${CUSTOMER_DAY_TIMEZONE})::date) AS "first_day"
        FROM "customers" c
        GROUP BY coalesce(c."profile_id", c."id")
      ) p
      WHERE p."first_day" BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.month, r.count]));
  }
}
