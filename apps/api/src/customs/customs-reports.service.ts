import { Injectable } from '@nestjs/common';
import type { CustomsStatus } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { type AlertRows, type AlertSqlRow, alertRows } from '../common/alert-rows.js';
import { fromDbDate, fromDbDateOrNull } from '../common/dates.js';
import {
  type AuditQuery,
  type ShipmentAuditEntry,
  andIf,
  overLimit,
  sqlDate,
} from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { shipmentIdVisibleIn } from '../shipments/shipment-scope.js';
import { clearanceDays, daysOpen } from './customs-rules.js';

/** A customs file of the report (its shipment's number comes from the shipments module). */
export interface CustomsFileRow {
  clearanceId: string;
  shipmentId: string;
  branchCode: string;
  status: CustomsStatus;
  declarationNumber: string | null;
  brokerName: string | null;
  openedOn: string;
  submittedOn: string | null;
  clearedOn: string | null;
  clearanceDays: number | null;
  daysOpen: number | null;
}

/**
 * Customs figures of the operational reports (annex D section 3, report 8), for the shipments
 * visible in the report's branches (owned or shared). A file is in a period by its submission
 * day, or by the day it was opened while it has not been submitted.
 */
@Injectable()
export class CustomsReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Alert 3: customs files not cleared, of shipments not cancelled, with no change for more than
   * `days` days (since their last update, in the shipment's branch), longest first. `number` is
   * left empty: the shipment's number comes from the shipments module.
   */
  async stalled(user: AuthUser, days: number, limit: number): Promise<AlertRows> {
    const branchIds = reportBranchIds(user);
    if (branchIds.length === 0) return { count: 0, rows: [] };
    return alertRows(
      await this.prisma.$queryRaw<AlertSqlRow[]>`
        SELECT *, count(*) OVER ()::int AS "count" FROM (
          SELECT x."shipment_id" AS "refId", '' AS "number", b."code" AS "branchCode",
                 x."status"::text AS "detail",
                 (x."updated_at" AT TIME ZONE b."timezone")::date AS "since",
                 ((now() AT TIME ZONE b."timezone")::date
                   - (x."updated_at" AT TIME ZONE b."timezone")::date)::int AS "days"
          FROM "customs_clearances" x
          JOIN "branches" b ON b."id" = x."branch_id"
          WHERE ${shipmentIdVisibleIn(Prisma.sql`x."shipment_id"`, branchIds)}
            AND x."status" <> 'CLEARED'
            AND NOT EXISTS (SELECT 1 FROM "shipments" cs
                            WHERE cs."id" = x."shipment_id" AND cs."status" = 'CANCELLED')
        ) stalled
        WHERE "days" > ${days}
        ORDER BY "days" DESC, "refId"
        LIMIT ${limit}`,
    );
  }

  async files(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string; status?: CustomsStatus },
    limit: number,
  ): Promise<{
    byStatus: { status: CustomsStatus; count: number }[];
    cleared: { files: number; totalDays: number };
    files: CustomsFileRow[];
    truncated: boolean;
  }> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) {
      return { byStatus: [], cleared: { files: 0, totalDays: 0 }, files: [], truncated: false };
    }
    const base = Prisma.sql`
      WITH f AS (
        SELECT x.*, b."code" AS "branchCode",
               (x."created_at" AT TIME ZONE b."timezone")::date AS "openedOn",
               (now() AT TIME ZONE b."timezone")::date AS "today"
        FROM "customs_clearances" x
        JOIN "branches" b ON b."id" = x."branch_id"
        WHERE ${shipmentIdVisibleIn(Prisma.sql`x."shipment_id"`, branchIds)}
      ),
      p AS (
        SELECT * FROM f
        WHERE coalesce(f."submitted_on", f."openedOn") BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
          ${andIf(q.status, (status) => Prisma.sql`f."status"::text = ${status}`)}
      )`;
    const [byStatus, cleared, rows] = await Promise.all([
      this.prisma.$queryRaw<{ status: CustomsStatus; count: number }[]>`
        ${base}
        SELECT "status"::text AS "status", count(*)::int AS "count" FROM p GROUP BY "status"`,
      this.prisma.$queryRaw<{ files: number; totalDays: number }[]>`
        ${base}
        SELECT count(*)::int AS "files",
               coalesce(sum(greatest("cleared_on" - "submitted_on", 0)), 0)::int AS "totalDays"
        FROM p
        WHERE "status" = 'CLEARED' AND "submitted_on" IS NOT NULL AND "cleared_on" IS NOT NULL`,
      this.prisma.$queryRaw<
        {
          id: string;
          shipment_id: string;
          branchCode: string;
          status: CustomsStatus;
          declaration_number: string | null;
          broker_name: string | null;
          openedOn: Date;
          submitted_on: Date | null;
          cleared_on: Date | null;
          today: Date;
        }[]
      >`
        ${base}
        SELECT "id", "shipment_id", "branchCode", "status"::text AS "status",
               "declaration_number", "broker_name", "openedOn", "submitted_on", "cleared_on", "today"
        FROM p
        ORDER BY coalesce("submitted_on", "openedOn"), "created_at", "id"
        LIMIT ${limit + 1}`,
    ]);
    const capped = overLimit(rows, limit);
    return {
      byStatus,
      cleared: cleared[0] ?? { files: 0, totalDays: 0 },
      files: capped.rows.map((r) => {
        const openedOn = fromDbDate(r.openedOn);
        const submittedOn = fromDbDateOrNull(r.submitted_on);
        const clearedOn = fromDbDateOrNull(r.cleared_on);
        return {
          clearanceId: r.id,
          shipmentId: r.shipment_id,
          branchCode: r.branchCode,
          status: r.status,
          declarationNumber: r.declaration_number,
          brokerName: r.broker_name,
          openedOn,
          submittedOn,
          clearedOn,
          clearanceDays: r.status === 'CLEARED' ? clearanceDays(submittedOn, clearedOn) : null,
          daysOpen: daysOpen(clearedOn, submittedOn, openedOn, fromDbDate(r.today)),
        };
      }),
      truncated: capped.truncated,
    };
  }

  /**
   * Audit log: the latest update of each customs file (only the last one is kept) and the fees
   * added, recorded in the period. A removed fee leaves no record.
   */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<ShipmentAuditEntry[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string;
        userId: string;
        userName: string;
        action: 'UPDATED' | 'FEE_ADDED';
        shipmentId: string;
        status: CustomsStatus | null;
        detail: string | null;
      }[]
    >`
      WITH events AS (
        SELECT x."branch_id", x."updated_at" AS "at", x."updated_by_id" AS "user_id",
               'UPDATED' AS "action", x."shipment_id", x."status"::text AS "status",
               x."note" AS "detail"
        FROM "customs_clearances" x
        UNION ALL
        SELECT f."branch_id", f."created_at", f."created_by_id", 'FEE_ADDED', f."shipment_id",
               NULL, f."description" || ': ' || trim_scale(f."amount")::text || ' ' || f."currency"
        FROM "customs_fees" f
      )
      SELECT x."at", b."code" AS "branchCode", x."user_id" AS "userId", u."full_name" AS "userName",
             x."action", x."shipment_id" AS "shipmentId", x."status", x."detail"
      FROM events x
      JOIN "branches" b ON b."id" = x."branch_id"
      JOIN "users" u ON u."id" = x."user_id"
      WHERE ${shipmentIdVisibleIn(Prisma.sql`x."shipment_id"`, branchIds)}
        AND (x."at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.userId, (id) => Prisma.sql`x."user_id" = ${id}::uuid`)}
      ORDER BY x."at" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map((r) => ({ ...r, at: r.at.toISOString(), entity: 'CUSTOMS' }));
  }
}
