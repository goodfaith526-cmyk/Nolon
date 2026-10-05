import { Injectable } from '@nestjs/common';
import type {
  AuditLogEntryDto,
  DashboardShipmentRefDto,
  DashboardShipmentsDto,
  LateShipmentRowDto,
  ReportBranchDto,
  ReportLocationDto,
  ShipmentEventKind,
  ShipmentReportRowDto,
  ShipmentStatus,
  ShippingMode,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { fromDbDate, fromDbDateOrNull } from '../common/dates.js';
import { type Decimal, ZERO, dec } from '../common/money.js';
import { type AuditQuery, andIf, overLimit, sqlDate } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { shipmentVisibleIn } from './shipment-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { daysLate } from './lateness.js';

export interface ShipmentReportQuery {
  from: string;
  to: string;
  branchId?: string;
  customerId?: string;
  mode?: ShippingMode;
  status?: ShipmentStatus;
}

interface LocationColumns {
  oId: string;
  oCode: string;
  oNameEn: string;
  oNameAr: string;
  dId: string;
  dCode: string;
  dNameEn: string;
  dNameAr: string;
}

interface ShipmentColumns extends LocationColumns {
  shipmentId: string;
  number: string;
  branchCode: string;
  customerId: string;
  customerName: string;
  mode: ShippingMode;
  status: ShipmentStatus;
}

/** Origin and destination columns, with the joins they need (aliases o and d). */
const ROUTE_COLUMNS = Prisma.sql`
  o."id" AS "oId", o."code" AS "oCode", o."name_en" AS "oNameEn", o."name_ar" AS "oNameAr",
  d."id" AS "dId", d."code" AS "dCode", d."name_en" AS "dNameEn", d."name_ar" AS "dNameAr"`;
const ROUTE_JOINS = Prisma.sql`
  JOIN "locations" o ON o."id" = s."origin_location_id"
  JOIN "locations" d ON d."id" = s."destination_location_id"`;

/** The day a timestamp falls on in the shipment's branch (alias b). */
const localDay = (column: Prisma.Sql) => Prisma.sql`(${column} AT TIME ZONE b."timezone")::date`;

/** Whether the shipment has been delivered (alias s). */
const IS_DELIVERED = Prisma.sql`s."status" IN ('DELIVERED', 'CLOSED')`;

/**
 * The day a delivered or closed shipment was delivered (alias s, b): its last DELIVERED event,
 * else the day it was closed. Null when not delivered, or delivered on a day nothing recorded
 * (never guessed from the last update, which any later edit moves).
 */
const DELIVERED_ON = Prisma.sql`
  CASE WHEN ${IS_DELIVERED} THEN
    ${localDay(Prisma.sql`coalesce(
      (SELECT max(e."occurred_at") FROM "shipment_events" e
        WHERE e."shipment_id" = s."id" AND e."status" = 'DELIVERED'),
      s."closed_at")`)}
  END`;

function route(r: LocationColumns): { origin: ReportLocationDto; destination: ReportLocationDto } {
  return {
    origin: { id: r.oId, code: r.oCode, nameEn: r.oNameEn, nameAr: r.oNameAr },
    destination: { id: r.dId, code: r.dCode, nameEn: r.dNameEn, nameAr: r.dNameAr },
  };
}

function shipmentRef(r: ShipmentColumns) {
  return {
    shipmentId: r.shipmentId,
    number: r.number,
    branchCode: r.branchCode,
    customerId: r.customerId,
    customerName: r.customerName,
    ...route(r),
    mode: r.mode,
    status: r.status,
  };
}

const AUDIT_ACTION: Record<ShipmentEventKind, AuditLogEntryDto['action']> = {
  CREATED: 'CREATED',
  STATUS: 'STATUS',
  HOLD: 'HOLD',
  RESUME: 'RESUME',
  REVERT: 'REVERT',
  CANCEL: 'CANCELLED',
};

/**
 * The shipment figures of the operational reports and dashboards (annex D sections 2 and 3),
 * added up in SQL over the shipments visible in the report's branches (the requested branch,
 * checked against the user's, or all of the user's): those they own and those shared with them
 * (ShipmentBranch). Rows are labelled with the owning branch. Periods are days in each
 * shipment's branch.
 */
@Injectable()
export class ShipmentReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Report 1: shipments created in the period, counted by status, branch, route and mode. */
  async byStatus(
    user: AuthUser,
    q: ShipmentReportQuery,
    limit: number,
  ): Promise<{
    groups: {
      branch: ReportBranchDto;
      status: ShipmentStatus;
      mode: ShippingMode;
      origin: ReportLocationDto;
      destination: ReportLocationDto;
      count: number;
    }[];
    shipments: ShipmentReportRowDto[];
    truncated: boolean;
  }> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return { groups: [], shipments: [], truncated: false };
    const where = Prisma.sql`
      WHERE ${shipmentVisibleIn('s', branchIds)}
        AND ${localDay(Prisma.sql`s."created_at"`)} BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.customerId, (id) => Prisma.sql`s."customer_id" = ${id}::uuid`)}
        ${andIf(q.mode, (mode) => Prisma.sql`s."mode"::text = ${mode}`)}
        ${andIf(q.status, (status) => Prisma.sql`s."status"::text = ${status}`)}`;
    const [groups, rows] = await Promise.all([
      this.prisma.$queryRaw<
        (LocationColumns & {
          branchId: string;
          branchCode: string;
          branchNameEn: string;
          branchNameAr: string;
          status: ShipmentStatus;
          mode: ShippingMode;
          count: number;
        })[]
      >`
        SELECT b."id" AS "branchId", b."code" AS "branchCode", b."name_en" AS "branchNameEn",
               b."name_ar" AS "branchNameAr", s."status"::text AS "status", s."mode"::text AS "mode",
               ${ROUTE_COLUMNS}, count(*)::int AS "count"
        FROM "shipments" s
        JOIN "branches" b ON b."id" = s."branch_id"
        ${ROUTE_JOINS}
        ${where}
        GROUP BY b."id", s."status", s."mode", o."id", d."id"`,
      this.prisma.$queryRaw<
        (ShipmentColumns & { createdOn: Date; etd: Date | null; eta: Date | null })[]
      >`
        SELECT s."id" AS "shipmentId", s."number", b."code" AS "branchCode",
               s."customer_id" AS "customerId", c."name" AS "customerName",
               s."mode"::text AS "mode", s."status"::text AS "status", ${ROUTE_COLUMNS},
               ${localDay(Prisma.sql`s."created_at"`)} AS "createdOn", s."etd", s."eta"
        FROM "shipments" s
        JOIN "branches" b ON b."id" = s."branch_id"
        JOIN "customers" c ON c."id" = s."customer_id"
        ${ROUTE_JOINS}
        ${where}
        ORDER BY s."number"
        LIMIT ${limit + 1}`,
    ]);
    const capped = overLimit(rows, limit);
    return {
      groups: groups.map((g) => ({
        branch: {
          id: g.branchId,
          code: g.branchCode,
          nameEn: g.branchNameEn,
          nameAr: g.branchNameAr,
        },
        status: g.status,
        mode: g.mode,
        ...route(g),
        count: g.count,
      })),
      shipments: capped.rows.map((r) => ({
        ...shipmentRef(r),
        createdOn: fromDbDate(r.createdOn),
        etd: fromDbDateOrNull(r.etd),
        eta: fromDbDateOrNull(r.eta),
      })),
      truncated: capped.truncated,
    };
  }

  /**
   * Report 2: shipments (not cancelled) whose ETA is in the period and that were delivered after
   * it or are still not delivered with the ETA before today (each in its branch's calendar).
   */
  async late(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string; customerId?: string },
    limit: number,
  ): Promise<{
    withEta: number;
    openLate: number;
    deliveredLate: number;
    totalDaysLate: number;
    shipments: LateShipmentRowDto[];
    truncated: boolean;
  }> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) {
      return {
        withEta: 0,
        openLate: 0,
        deliveredLate: 0,
        totalDaysLate: 0,
        shipments: [],
        truncated: false,
      };
    }
    const base = Prisma.sql`
      WITH base AS (
        SELECT s."id" AS "shipmentId", s."number", b."code" AS "branchCode",
               s."customer_id" AS "customerId", c."name" AS "customerName",
               s."mode"::text AS "mode", s."status"::text AS "status", ${ROUTE_COLUMNS},
               s."eta", ${IS_DELIVERED} AS "delivered", ${DELIVERED_ON} AS "deliveredOn",
               (now() AT TIME ZONE b."timezone")::date AS "today"
        FROM "shipments" s
        JOIN "branches" b ON b."id" = s."branch_id"
        JOIN "customers" c ON c."id" = s."customer_id"
        ${ROUTE_JOINS}
        WHERE ${shipmentVisibleIn('s', branchIds)}
          AND s."status" <> 'CANCELLED'
          AND s."eta" BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
          ${andIf(q.customerId, (id) => Prisma.sql`s."customer_id" = ${id}::uuid`)}
      ),
      late AS (
        SELECT *,
               CASE WHEN NOT "delivered" AND "today" > "eta" THEN "today" - "eta"
                    WHEN "deliveredOn" > "eta" THEN "deliveredOn" - "eta"
               END AS "daysLate"
        FROM base
      )`;
    const [totals, rows] = await Promise.all([
      this.prisma.$queryRaw<
        { withEta: number; openLate: number; deliveredLate: number; totalDaysLate: number }[]
      >`
        ${base}
        SELECT count(*)::int AS "withEta",
               count(*) FILTER (WHERE NOT "delivered" AND "daysLate" IS NOT NULL)::int AS "openLate",
               count(*) FILTER (WHERE "delivered" AND "daysLate" IS NOT NULL)::int AS "deliveredLate",
               coalesce(sum("daysLate"), 0)::int AS "totalDaysLate"
        FROM late`,
      this.prisma.$queryRaw<
        (ShipmentColumns & { eta: Date; deliveredOn: Date | null; today: Date })[]
      >`
        ${base}
        SELECT * FROM late
        WHERE "daysLate" IS NOT NULL
        ORDER BY "eta", "number"
        LIMIT ${limit + 1}`,
    ]);
    const capped = overLimit(rows, limit);
    const t = totals[0] ?? { withEta: 0, openLate: 0, deliveredLate: 0, totalDaysLate: 0 };
    return {
      ...t,
      shipments: capped.rows.map((r) => {
        const eta = fromDbDate(r.eta);
        const deliveredOn = fromDbDateOrNull(r.deliveredOn);
        return {
          ...shipmentRef(r),
          eta,
          deliveredOn,
          daysLate: daysLate(eta, deliveredOn, fromDbDate(r.today)) ?? 0,
        };
      }),
      truncated: capped.truncated,
    };
  }

  /**
   * Report 4 (shipment side): per customer, the shipments created in the period (not cancelled)
   * and the volume and weight of their cargo lines.
   */
  async activityByCustomer(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string; customerId?: string },
  ): Promise<
    {
      customerId: string;
      customerName: string;
      shipments: number;
      volumeCbm: Decimal;
      weightKg: Decimal;
    }[]
  > {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        customerId: string;
        customerName: string;
        shipments: number;
        volumeCbm: Decimal | null;
        weightKg: Decimal | null;
      }[]
    >`
      SELECT s."customer_id" AS "customerId", c."name" AS "customerName",
             count(*)::int AS "shipments", sum(i."volume") AS "volumeCbm", sum(i."weight") AS "weightKg"
      FROM "shipments" s
      JOIN "branches" b ON b."id" = s."branch_id"
      JOIN "customers" c ON c."id" = s."customer_id"
      LEFT JOIN (
        SELECT "shipment_id", sum("volume_cbm") AS "volume", sum("weight_kg") AS "weight"
        FROM "shipment_items" GROUP BY "shipment_id"
      ) i ON i."shipment_id" = s."id"
      WHERE ${shipmentVisibleIn('s', branchIds)}
        AND s."status" <> 'CANCELLED'
        AND ${localDay(Prisma.sql`s."created_at"`)} BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.customerId, (id) => Prisma.sql`s."customer_id" = ${id}::uuid`)}
      GROUP BY s."customer_id", c."name"`;
    return rows.map((r) => ({
      ...r,
      volumeCbm: r.volumeCbm === null ? ZERO : dec(r.volumeCbm),
      weightKg: r.weightKg === null ? ZERO : dec(r.weightKg),
    }));
  }

  /** Dashboard: open shipments by status, new and delivered in the period, open and late now. */
  async dashboard(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string },
  ): Promise<DashboardShipmentsDto> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) {
      return { byStatus: [], open: 0, newInPeriod: 0, deliveredInPeriod: 0, late: 0 };
    }
    const from = sqlDate(q.from);
    const to = sqlDate(q.to);
    const scope = Prisma.sql`
      FROM "shipments" s
      JOIN "branches" b ON b."id" = s."branch_id"
      WHERE ${shipmentVisibleIn('s', branchIds)}`;
    const [byStatus, totals] = await Promise.all([
      this.prisma.$queryRaw<{ status: ShipmentStatus; count: number }[]>`
        SELECT s."status"::text AS "status", count(*)::int AS "count"
        ${scope} AND s."status" NOT IN ('DELIVERED', 'CLOSED', 'CANCELLED')
        GROUP BY s."status"`,
      this.prisma.$queryRaw<{ newInPeriod: number; deliveredInPeriod: number; late: number }[]>`
        SELECT
          count(*) FILTER (WHERE s."status" <> 'CANCELLED'
            AND ${localDay(Prisma.sql`s."created_at"`)} BETWEEN ${from} AND ${to})::int AS "newInPeriod",
          count(*) FILTER (WHERE ${DELIVERED_ON} BETWEEN ${from} AND ${to})::int AS "deliveredInPeriod",
          count(*) FILTER (WHERE s."status" NOT IN ('DELIVERED', 'CLOSED', 'CANCELLED')
            AND s."eta" < (now() AT TIME ZONE b."timezone")::date)::int AS "late"
        ${scope}`,
    ]);
    const t = totals[0] ?? { newInPeriod: 0, deliveredInPeriod: 0, late: 0 };
    return {
      byStatus: byStatus.sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
      open: byStatus.reduce((n, s) => n + s.count, 0),
      ...t,
    };
  }

  /** Branch dashboard: the branch's shipments (not cancelled) due in or out on `day`. */
  async dueOn(
    user: AuthUser,
    branchId: string,
    day: string,
    limit: number,
  ): Promise<{ inbound: DashboardShipmentRefDto[]; outbound: DashboardShipmentRefDto[] }> {
    const [only] = reportBranchIds(user, branchId);
    if (!only) return { inbound: [], outbound: [] };
    // Each list has its own limit, so a busy day one way cannot crowd out the other.
    const due = (column: Prisma.Sql) => this.prisma.$queryRaw<ShipmentColumns[]>`
      SELECT s."id" AS "shipmentId", s."number", b."code" AS "branchCode",
             s."customer_id" AS "customerId", c."name" AS "customerName",
             s."mode"::text AS "mode", s."status"::text AS "status", ${ROUTE_COLUMNS}
      FROM "shipments" s
      JOIN "branches" b ON b."id" = s."branch_id"
      JOIN "customers" c ON c."id" = s."customer_id"
      ${ROUTE_JOINS}
      WHERE ${shipmentVisibleIn('s', [only])}
        AND s."status" <> 'CANCELLED'
        AND ${column} = ${sqlDate(day)}
      ORDER BY s."number"
      LIMIT ${limit}`;
    const [inbound, outbound] = await Promise.all([
      due(Prisma.sql`s."eta"`),
      due(Prisma.sql`s."etd"`),
    ]);
    const ref = (r: ShipmentColumns): DashboardShipmentRefDto => ({
      shipmentId: r.shipmentId,
      number: r.number,
      customerName: r.customerName,
      status: r.status,
      ...route(r),
    });
    return { inbound: inbound.map(ref), outbound: outbound.map(ref) };
  }

  /** Audit log: the shipment events recorded in the period (status changes, holds, ...). */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string;
        userId: string | null;
        userName: string | null;
        kind: ShipmentEventKind;
        status: ShipmentStatus;
        reference: string;
        reason: string | null;
        note: string | null;
      }[]
    >`
      SELECT e."created_at" AS "at", b."code" AS "branchCode", e."user_id" AS "userId",
             u."full_name" AS "userName", e."kind"::text AS "kind", e."status"::text AS "status",
             s."number" AS "reference", e."reason", e."note"
      FROM "shipment_events" e
      JOIN "shipments" s ON s."id" = e."shipment_id"
      JOIN "branches" b ON b."id" = s."branch_id"
      LEFT JOIN "users" u ON u."id" = e."user_id"
      WHERE ${shipmentVisibleIn('s', branchIds)}
        AND ${localDay(Prisma.sql`e."created_at"`)} BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.userId, (id) => Prisma.sql`e."user_id" = ${id}::uuid`)}
      ORDER BY e."created_at" DESC, e."id" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map((r) => ({
      at: r.at.toISOString(),
      branchCode: r.branchCode,
      userId: r.userId,
      userName: r.userName,
      entity: 'SHIPMENT',
      action: AUDIT_ACTION[r.kind],
      reference: r.reference,
      status: r.status,
      detail: r.reason ?? r.note,
    }));
  }
}
