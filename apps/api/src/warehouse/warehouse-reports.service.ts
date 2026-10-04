import { Injectable } from '@nestjs/common';
import type {
  AuditLogEntryDto,
  GoodsCondition,
  MovementTotalsDto,
  WarehouseMovementKind,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { fromDbDate } from '../common/dates.js';
import { type Decimal, ZERO, dec } from '../common/money.js';
import { type AuditQuery, andIf, overLimit, sqlDate, uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { daysHeld } from './warehouse-rules.js';

/** Goods a warehouse holds for a shipment now (the shipment's number comes from its module). */
export interface OnHandRow {
  shipmentId: string;
  branchCode: string;
  warehouseId: string;
  warehouseCode: string;
  packages: number;
  weightKg: Decimal;
  heldSince: string;
  daysHeld: number;
}

export interface MovementRow {
  movementId: string;
  number: string;
  kind: WarehouseMovementKind;
  occurredAt: string;
  shipmentId: string;
  branchCode: string;
  warehouseCode: string;
  packages: number;
  weightKg: string | null;
  condition: GoodsCondition | null;
  partyName: string | null;
  createdByName: string;
}

/** Packages and weight with the sign of the movement: + received, - released. */
const SIGNED_PACKAGES = Prisma.sql`CASE WHEN m."kind" = 'RECEIPT' THEN m."packages" ELSE -m."packages" END`;
const SIGNED_WEIGHT = Prisma.sql`CASE WHEN m."kind" = 'RECEIPT' THEN m."weight_kg" ELSE -m."weight_kg" END`;

/**
 * Warehouse figures of the operational reports and the branch dashboard (annex D sections 2 and
 * 3). A movement belongs to its shipment's branch (warehouse_movements.branch_id), so the report's
 * branches (the requested one, checked, or all of the user's) filter on it. What is held is
 * receipts minus releases in log order (occurred_at, then created_at), as the warehouse rules
 * keep it; the holding started with the first receipt after the last time nothing was held.
 */
@Injectable()
export class WarehouseReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The holdings query: one row per shipment and warehouse with goods in it now. */
  private holdings(branchIds: readonly string[], warehouseId?: string): Prisma.Sql {
    return Prisma.sql`
      WITH m AS (
        SELECT m."shipment_id", m."warehouse_id", m."branch_id", m."kind", m."occurred_at",
               ${SIGNED_PACKAGES} AS "packages_signed",
               coalesce(${SIGNED_WEIGHT}, 0) AS "weight_signed",
               row_number() OVER w AS "rn",
               sum(${SIGNED_PACKAGES}) OVER w AS "running"
        FROM "warehouse_movements" m
        WHERE m."branch_id" IN ${uuidList(branchIds)}
          ${andIf(warehouseId, (id) => Prisma.sql`m."warehouse_id" = ${id}::uuid`)}
        WINDOW w AS (PARTITION BY m."shipment_id", m."warehouse_id"
                     ORDER BY m."occurred_at", m."created_at", m."id" ROWS UNBOUNDED PRECEDING)
      ),
      h AS (
        SELECT "shipment_id", "warehouse_id", "branch_id",
               sum("packages_signed")::int AS "packages", sum("weight_signed") AS "weight",
               coalesce(max("rn") FILTER (WHERE "running" <= 0), 0) AS "last_empty"
        FROM m
        GROUP BY 1, 2, 3
        HAVING sum("packages_signed") > 0
      ),
      held AS (
        SELECT h.*, b."code" AS "branchCode", w."code" AS "warehouseCode",
               ((SELECT min(r."occurred_at") FROM m r
                 WHERE r."shipment_id" = h."shipment_id" AND r."warehouse_id" = h."warehouse_id"
                   AND r."kind" = 'RECEIPT' AND r."rn" > h."last_empty")
                AT TIME ZONE b."timezone")::date AS "heldSince",
               (now() AT TIME ZONE b."timezone")::date AS "today"
        FROM h
        JOIN "warehouses" w ON w."id" = h."warehouse_id"
        JOIN "branches" b ON b."id" = h."branch_id"
      )`;
  }

  /** Report 6: goods on hand now, longest held first, with the totals of all of them. */
  async onHand(
    user: AuthUser,
    q: { branchId?: string; warehouseId?: string },
    limit: number,
  ): Promise<{
    rows: OnHandRow[];
    totals: { shipments: number; packages: number; weightKg: Decimal };
    truncated: boolean;
  }> {
    const branchIds = reportBranchIds(user, q.branchId);
    const none = {
      rows: [],
      totals: { shipments: 0, packages: 0, weightKg: ZERO },
      truncated: false,
    };
    if (branchIds.length === 0) return none;
    const rows = await this.prisma.$queryRaw<
      {
        shipment_id: string;
        warehouse_id: string;
        branchCode: string;
        warehouseCode: string;
        packages: number;
        weight: Decimal;
        heldSince: Date;
        today: Date;
        totalShipments: number;
        totalPackages: number;
        totalWeight: Decimal;
      }[]
    >`
      ${this.holdings(branchIds, q.warehouseId)}
      SELECT held.*, count(*) OVER ()::int AS "totalShipments",
             (sum("packages") OVER ())::int AS "totalPackages", sum("weight") OVER () AS "totalWeight"
      FROM held
      ORDER BY "heldSince", "warehouseCode", "shipment_id"
      LIMIT ${limit + 1}`;
    const first = rows[0];
    if (!first) return none;
    const capped = overLimit(rows, limit);
    return {
      rows: capped.rows.map((r) => {
        const heldSince = fromDbDate(r.heldSince);
        return {
          shipmentId: r.shipment_id,
          branchCode: r.branchCode,
          warehouseId: r.warehouse_id,
          warehouseCode: r.warehouseCode,
          packages: r.packages,
          weightKg: dec(r.weight),
          heldSince,
          daysHeld: daysHeld(heldSince, fromDbDate(r.today)),
        };
      }),
      totals: {
        shipments: first.totalShipments,
        packages: first.totalPackages,
        weightKg: dec(first.totalWeight),
      },
      truncated: capped.truncated,
    };
  }

  /** Report 7: receipts and releases that happened in the period, with totals per kind. */
  async movements(
    user: AuthUser,
    q: {
      from: string;
      to: string;
      branchId?: string;
      warehouseId?: string;
      kind?: WarehouseMovementKind;
    },
    limit: number,
  ): Promise<{
    receipts: MovementTotalsDto;
    releases: MovementTotalsDto;
    movements: MovementRow[];
    truncated: boolean;
  }> {
    const branchIds = reportBranchIds(user, q.branchId);
    const zero: MovementTotalsDto = { movements: 0, packages: 0, weightKg: '0' };
    if (branchIds.length === 0) {
      return { receipts: zero, releases: zero, movements: [], truncated: false };
    }
    const where = Prisma.sql`
      FROM "warehouse_movements" m
      JOIN "branches" b ON b."id" = m."branch_id"
      JOIN "warehouses" w ON w."id" = m."warehouse_id"
      JOIN "users" u ON u."id" = m."created_by_id"
      WHERE m."branch_id" IN ${uuidList(branchIds)}
        AND (m."occurred_at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.warehouseId, (id) => Prisma.sql`m."warehouse_id" = ${id}::uuid`)}
        ${andIf(q.kind, (kind) => Prisma.sql`m."kind"::text = ${kind}`)}`;
    const [totals, rows] = await Promise.all([
      this.prisma.$queryRaw<
        {
          kind: WarehouseMovementKind;
          movements: number;
          packages: number;
          weight: Decimal | null;
        }[]
      >`
        SELECT m."kind"::text AS "kind", count(*)::int AS "movements",
               sum(m."packages")::int AS "packages", sum(m."weight_kg") AS "weight"
        ${where}
        GROUP BY m."kind"`,
      this.prisma.$queryRaw<
        {
          movementId: string;
          number: string;
          kind: WarehouseMovementKind;
          occurredAt: Date;
          shipmentId: string;
          branchCode: string;
          warehouseCode: string;
          packages: number;
          weightKg: Decimal | null;
          condition: GoodsCondition | null;
          partyName: string | null;
          createdByName: string;
        }[]
      >`
        SELECT m."id" AS "movementId", m."number", m."kind"::text AS "kind",
               m."occurred_at" AS "occurredAt", m."shipment_id" AS "shipmentId",
               b."code" AS "branchCode", w."code" AS "warehouseCode", m."packages",
               m."weight_kg" AS "weightKg", m."condition"::text AS "condition",
               m."party_name" AS "partyName", u."full_name" AS "createdByName"
        ${where}
        ORDER BY m."occurred_at", m."created_at", m."id"
        LIMIT ${limit + 1}`,
    ]);
    const kindTotals = (kind: WarehouseMovementKind): MovementTotalsDto => {
      const t = totals.find((x) => x.kind === kind);
      return t
        ? {
            movements: t.movements,
            packages: t.packages,
            weightKg: (t.weight === null ? ZERO : dec(t.weight)).toFixed(),
          }
        : zero;
    };
    const capped = overLimit(rows, limit);
    return {
      receipts: kindTotals('RECEIPT'),
      releases: kindTotals('RELEASE'),
      movements: capped.rows.map((r) => ({
        ...r,
        occurredAt: r.occurredAt.toISOString(),
        weightKg: r.weightKg === null ? null : dec(r.weightKg).toFixed(),
      })),
      truncated: capped.truncated,
    };
  }

  /** Branch dashboard: what the branch's shipments have in warehouses, and today's movements. */
  async dashboard(
    user: AuthUser,
    branchId: string,
    today: string,
  ): Promise<{
    shipments: number;
    packages: number;
    weightKg: Decimal;
    receivedToday: number;
    releasedToday: number;
  }> {
    const branchIds = reportBranchIds(user, branchId);
    const [held, moved] = await Promise.all([
      this.prisma.$queryRaw<{ shipments: number; packages: number; weight: Decimal | null }[]>`
        ${this.holdings(branchIds)}
        SELECT count(*)::int AS "shipments", coalesce(sum("packages"), 0)::int AS "packages",
               sum("weight") AS "weight"
        FROM held`,
      this.prisma.$queryRaw<{ received: number; released: number }[]>`
        SELECT count(*) FILTER (WHERE m."kind" = 'RECEIPT')::int AS "received",
               count(*) FILTER (WHERE m."kind" = 'RELEASE')::int AS "released"
        FROM "warehouse_movements" m
        JOIN "branches" b ON b."id" = m."branch_id"
        WHERE m."branch_id" IN ${uuidList(branchIds)}
          AND (m."occurred_at" AT TIME ZONE b."timezone")::date = ${sqlDate(today)}`,
    ]);
    const h = held[0];
    return {
      shipments: h?.shipments ?? 0,
      packages: h?.packages ?? 0,
      weightKg: h?.weight ? dec(h.weight) : ZERO,
      receivedToday: moved[0]?.received ?? 0,
      releasedToday: moved[0]?.released ?? 0,
    };
  }

  /** Audit log: receipts and releases recorded in the period. */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string;
        userId: string;
        userName: string;
        kind: WarehouseMovementKind;
        reference: string;
        detail: string | null;
      }[]
    >`
      SELECT m."created_at" AS "at", b."code" AS "branchCode", m."created_by_id" AS "userId",
             u."full_name" AS "userName", m."kind"::text AS "kind", m."number" AS "reference",
             m."note" AS "detail"
      FROM "warehouse_movements" m
      JOIN "branches" b ON b."id" = m."branch_id"
      JOIN "users" u ON u."id" = m."created_by_id"
      WHERE m."branch_id" IN ${uuidList(branchIds)}
        AND (m."created_at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.userId, (id) => Prisma.sql`m."created_by_id" = ${id}::uuid`)}
      ORDER BY m."created_at" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map(({ kind, ...r }) => ({
      ...r,
      at: r.at.toISOString(),
      entity: 'WAREHOUSE_MOVEMENT',
      action: kind === 'RECEIPT' ? 'RECEIVED' : 'RELEASED',
      status: null,
    }));
  }
}
