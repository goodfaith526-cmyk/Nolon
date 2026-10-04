import { Injectable } from '@nestjs/common';
import type {
  AuditLogEntryDto,
  DashboardTripRefDto,
  ReportLocationDto,
  TripKind,
  TripStatus,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { fromDbDate } from '../common/dates.js';
import { type AuditQuery, andIf, overLimit, sqlDate, uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface TripReportQuery {
  from: string;
  to: string;
  branchId?: string;
  kind?: TripKind;
  vehicleId?: string;
  driverId?: string;
  carrierId?: string;
}

/** A trip of the report, with the journal entries its cost was posted by. */
export interface TripRow {
  tripId: string;
  number: string;
  branchCode: string;
  kind: TripKind;
  status: TripStatus;
  tripDate: string;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
  vehicleId: string | null;
  vehicle: string | null;
  driverId: string | null;
  driver: string | null;
  carrierId: string | null;
  carrierName: string | null;
  shipments: number;
  /** Rule 10 expense entries (cancelled ones too: their reversals net them out) and the rule 11 accrual. */
  costEntryIds: string[];
}

interface TripColumns {
  tripId: string;
  number: string;
  status: TripStatus;
  vehicle: string | null;
  driver: string | null;
  oId: string;
  oCode: string;
  oNameEn: string;
  oNameAr: string;
  dId: string;
  dCode: string;
  dNameEn: string;
  dNameAr: string;
}

const TRIP_COLUMNS = Prisma.sql`
  t."id" AS "tripId", t."number", t."status"::text AS "status",
  coalesce(v."plate_number", t."external_vehicle") AS "vehicle",
  coalesce(dr."name", t."external_driver") AS "driver",
  o."id" AS "oId", o."code" AS "oCode", o."name_en" AS "oNameEn", o."name_ar" AS "oNameAr",
  d."id" AS "dId", d."code" AS "dCode", d."name_en" AS "dNameEn", d."name_ar" AS "dNameAr"`;

const TRIP_JOINS = Prisma.sql`
  JOIN "branches" b ON b."id" = t."branch_id"
  JOIN "locations" o ON o."id" = t."origin_location_id"
  JOIN "locations" d ON d."id" = t."destination_location_id"
  LEFT JOIN "vehicles" v ON v."id" = t."vehicle_id"
  LEFT JOIN "drivers" dr ON dr."id" = t."driver_id"`;

/** The trip's day: its departure (actual, else planned), else its creation, in its branch. */
const TRIP_DAY = Prisma.sql`
  (coalesce(t."actual_departure", t."planned_departure", t."created_at") AT TIME ZONE b."timezone")::date`;

function route(r: TripColumns): { origin: ReportLocationDto; destination: ReportLocationDto } {
  return {
    origin: { id: r.oId, code: r.oCode, nameEn: r.oNameEn, nameAr: r.oNameAr },
    destination: { id: r.dId, code: r.dCode, nameEn: r.dNameEn, nameAr: r.dNameAr },
  };
}

/**
 * Trip figures of the operational reports and the branch dashboard (annex D sections 2 and 3), in
 * the report's branches. The cost itself is read from the ledger by the caller, from the entries
 * listed here.
 */
@Injectable()
export class TripReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Report 9: trips whose day is in the period. */
  async trips(
    user: AuthUser,
    q: TripReportQuery,
    limit: number,
  ): Promise<{ trips: TripRow[]; truncated: boolean }> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return { trips: [], truncated: false };
    const rows = await this.prisma.$queryRaw<
      (TripColumns & {
        branchCode: string;
        kind: TripKind;
        tripDate: Date;
        vehicleId: string | null;
        driverId: string | null;
        carrierId: string | null;
        carrierName: string | null;
        shipments: number;
        costEntryIds: string[];
      })[]
    >`
      SELECT ${TRIP_COLUMNS}, b."code" AS "branchCode", t."kind"::text AS "kind",
             ${TRIP_DAY} AS "tripDate", t."vehicle_id" AS "vehicleId", t."driver_id" AS "driverId",
             t."carrier_id" AS "carrierId", c."name" AS "carrierName",
             (SELECT count(*)::int FROM "trip_shipments" ts WHERE ts."trip_id" = t."id") AS "shipments",
             array_remove(
               array_append(
                 coalesce((SELECT array_agg(x."journal_entry_id"::text) FROM "trip_expenses" x
                           WHERE x."trip_id" = t."id"), ARRAY[]::text[]),
                 t."accrual_entry_id"::text),
               NULL) AS "costEntryIds"
      FROM "trips" t
      ${TRIP_JOINS}
      LEFT JOIN "carriers" c ON c."id" = t."carrier_id"
      WHERE t."branch_id" IN ${uuidList(branchIds)}
        AND ${TRIP_DAY} BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.kind, (kind) => Prisma.sql`t."kind"::text = ${kind}`)}
        ${andIf(q.vehicleId, (id) => Prisma.sql`t."vehicle_id" = ${id}::uuid`)}
        ${andIf(q.driverId, (id) => Prisma.sql`t."driver_id" = ${id}::uuid`)}
        ${andIf(q.carrierId, (id) => Prisma.sql`t."carrier_id" = ${id}::uuid`)}
      ORDER BY ${TRIP_DAY}, t."number"
      LIMIT ${limit + 1}`;
    const capped = overLimit(rows, limit);
    return {
      trips: capped.rows.map((r) => ({
        tripId: r.tripId,
        number: r.number,
        branchCode: r.branchCode,
        kind: r.kind,
        status: r.status,
        tripDate: fromDbDate(r.tripDate),
        ...route(r),
        vehicleId: r.vehicleId,
        vehicle: r.vehicle,
        driverId: r.driverId,
        driver: r.driver,
        carrierId: r.carrierId,
        carrierName: r.carrierName,
        shipments: r.shipments,
        costEntryIds: r.costEntryIds,
      })),
      truncated: capped.truncated,
    };
  }

  /** Branch dashboard: trips on the road (departed or arrived) and how many are planned. */
  async dashboard(
    user: AuthUser,
    branchId: string,
    limit: number,
  ): Promise<{ active: DashboardTripRefDto[]; planned: number }> {
    const branchIds = reportBranchIds(user, branchId);
    const [active, planned] = await Promise.all([
      this.prisma.$queryRaw<TripColumns[]>`
        SELECT ${TRIP_COLUMNS}
        FROM "trips" t
        ${TRIP_JOINS}
        WHERE t."branch_id" IN ${uuidList(branchIds)} AND t."status" IN ('DEPARTED', 'ARRIVED')
        ORDER BY t."actual_departure", t."number"
        LIMIT ${limit}`,
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS "count" FROM "trips" t
        WHERE t."branch_id" IN ${uuidList(branchIds)} AND t."status" = 'PLANNED'`,
    ]);
    return {
      active: active.map((r) => ({
        tripId: r.tripId,
        number: r.number,
        status: r.status,
        vehicle: r.vehicle,
        driver: r.driver,
        ...route(r),
      })),
      planned: planned[0]?.count ?? 0,
    };
  }

  /**
   * Audit log: trips created and cancelled, trip expenses posted and cancelled, and proofs of
   * delivery recorded in the period. A trip's cancellation does not record who did it.
   */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string;
        userId: string | null;
        userName: string | null;
        entity: 'TRIP' | 'TRIP_EXPENSE' | 'POD';
        action: 'CREATED' | 'CANCELLED';
        reference: string;
        status: TripStatus | null;
        detail: string | null;
      }[]
    >`
      WITH events AS (
        SELECT t."branch_id", t."created_at" AS "at", t."created_by_id" AS "user_id",
               'TRIP' AS "entity", 'CREATED' AS "action", t."number" AS "reference",
               'PLANNED' AS "status", t."notes" AS "detail"
        FROM "trips" t
        UNION ALL
        SELECT t."branch_id", t."cancelled_at", NULL, 'TRIP', 'CANCELLED', t."number",
               'CANCELLED', t."cancel_reason"
        FROM "trips" t WHERE t."cancelled_at" IS NOT NULL
        UNION ALL
        SELECT x."branch_id", x."created_at", x."created_by_id", 'TRIP_EXPENSE', 'CREATED',
               x."number", NULL,
               x."description" || ': ' || trim_scale(x."amount")::text || ' ' || x."currency"
        FROM "trip_expenses" x
        UNION ALL
        SELECT x."branch_id", x."cancelled_at", x."cancelled_by_id", 'TRIP_EXPENSE', 'CANCELLED',
               x."number", NULL, x."cancel_reason"
        FROM "trip_expenses" x WHERE x."cancelled_at" IS NOT NULL
        UNION ALL
        SELECT p."branch_id", p."created_at", p."created_by_id", 'POD', 'CREATED', p."number",
               NULL, p."recipient_name" || ' (' || p."recipient_capacity" || ')'
        FROM "proofs_of_delivery" p
      )
      SELECT x."at", b."code" AS "branchCode", x."user_id" AS "userId", u."full_name" AS "userName",
             x."entity", x."action", x."reference", x."status", x."detail"
      FROM events x
      JOIN "branches" b ON b."id" = x."branch_id"
      LEFT JOIN "users" u ON u."id" = x."user_id"
      WHERE x."branch_id" IN ${uuidList(branchIds)}
        AND (x."at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.userId, (id) => Prisma.sql`x."user_id" = ${id}::uuid`)}
      ORDER BY x."at" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  }
}
