import { Injectable } from '@nestjs/common';
import type {
  AuditLogEntryDto,
  ConsolidationStatus,
  ConsolidationsReportDto,
  ContainerReportRowDto,
  ConsolidationBasis,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { fromDbDate, fromDbDateOrNull } from '../common/dates.js';
import { ZERO, toDecimalString } from '../common/money.js';
import {
  type AuditQuery,
  andIf,
  auditEntityFilter,
  overLimit,
  sqlDate,
  uuidList,
} from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { containerContents } from './container-contents.js';

export interface ConsolidationReportQuery {
  from: string;
  to: string;
  branchId?: string;
  status?: ConsolidationStatus;
}

interface ContainerSqlRow {
  id: string;
  number: string;
  branchCode: string;
  status: ConsolidationStatus;
  containerTypeCode: string;
  containerNumber: string | null;
  carrierName: string | null;
  vesselName: string | null;
  voyageNumber: string | null;
  day: Date;
  etd: Date | null;
  eta: Date | null;
  basis: ConsolidationBasis;
  oId: string;
  oCode: string;
  oNameEn: string;
  oNameAr: string;
  dId: string;
  dCode: string;
  dNameEn: string;
  dNameAr: string;
}

/**
 * Report 5 (annex D section 3): consolidated containers and what is in them. A container belongs
 * to the period by its ETD, else by the day it was opened in its branch, so an open container
 * without a sailing date is still listed. Containers come from the user's branches (the requested
 * one, checked, or all of theirs); their shipments through the shipments module, which shows only
 * the ones the user may see. Cancelled containers only when the status filter asks for them.
 */
@Injectable()
export class ConsolidationReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  async containers(
    user: AuthUser,
    q: ConsolidationReportQuery,
    limit: number,
  ): Promise<Omit<ConsolidationsReportDto, 'from' | 'to' | 'branchId' | 'status'>> {
    const empty = {
      byStatus: [],
      totals: {
        containers: 0,
        shipments: 0,
        customers: 0,
        packages: 0,
        weightKg: '0',
        volumeCbm: '0',
      },
      containers: [],
      truncated: false,
    };
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return empty;
    const day = Prisma.sql`coalesce(c."etd", (c."created_at" AT TIME ZONE b."timezone")::date)`;
    const where = Prisma.sql`
      WHERE c."branch_id" IN ${uuidList(branchIds)}
        AND ${day} BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${q.status ? Prisma.sql`AND c."status"::text = ${q.status}` : Prisma.sql`AND c."status" <> 'CANCELLED'`}`;
    const [byStatus, found] = await Promise.all([
      this.prisma.$queryRaw<{ status: ConsolidationStatus; count: number }[]>`
        SELECT c."status"::text AS "status", count(*)::int AS "count"
        FROM "consolidations" c
        JOIN "branches" b ON b."id" = c."branch_id"
        ${where}
        GROUP BY c."status"
        ORDER BY c."status"`,
      this.prisma.$queryRaw<ContainerSqlRow[]>`
        SELECT c."id", c."number", b."code" AS "branchCode", c."status"::text AS "status",
               c."container_type_code" AS "containerTypeCode",
               c."container_number" AS "containerNumber", c."carrier_name" AS "carrierName",
               c."vessel_name" AS "vesselName", c."voyage_number" AS "voyageNumber",
               ${day} AS "day", c."etd", c."eta", c."basis"::text AS "basis",
               o."id" AS "oId", o."code" AS "oCode", o."name_en" AS "oNameEn", o."name_ar" AS "oNameAr",
               d."id" AS "dId", d."code" AS "dCode", d."name_en" AS "dNameEn", d."name_ar" AS "dNameAr"
        FROM "consolidations" c
        JOIN "branches" b ON b."id" = c."branch_id"
        JOIN "locations" o ON o."id" = c."origin_location_id"
        JOIN "locations" d ON d."id" = c."destination_location_id"
        ${where}
        ORDER BY ${day}, c."number"
        LIMIT ${limit + 1}`,
    ]);
    const { rows, truncated } = overLimit(found, limit);
    if (rows.length === 0) return { ...empty, byStatus, truncated };

    const links = await this.prisma.consolidationShipment.findMany({
      where: { consolidationId: { in: rows.map((r) => r.id) } },
      select: { consolidationId: true, shipmentId: true },
      // By shipment number: shipments put in together share no meaningful order.
      orderBy: { shipment: { number: 'asc' } },
    });
    const visible = new Map(
      (
        await this.shipments.tripSummaries(
          user,
          links.map((l) => l.shipmentId),
        )
      ).map((s) => [s.id, s]),
    );
    const idsOf = new Map<string, string[]>();
    for (const l of links) {
      idsOf.set(l.consolidationId, [...(idsOf.get(l.consolidationId) ?? []), l.shipmentId]);
    }

    const customers = new Set<string>();
    let shipments = 0;
    let packages = 0;
    let weightKg = ZERO;
    let volumeCbm = ZERO;
    const containers = rows.map((r): ContainerReportRowDto => {
      const c = containerContents(idsOf.get(r.id) ?? [], visible);
      for (const id of c.customerIds) customers.add(id);
      shipments += c.shipments;
      packages += c.packages;
      weightKg = weightKg.plus(c.weightKg);
      volumeCbm = volumeCbm.plus(c.volumeCbm);
      return {
        consolidationId: r.id,
        number: r.number,
        branchCode: r.branchCode,
        status: r.status,
        containerTypeCode: r.containerTypeCode,
        containerNumber: r.containerNumber,
        origin: { id: r.oId, code: r.oCode, nameEn: r.oNameEn, nameAr: r.oNameAr },
        destination: { id: r.dId, code: r.dCode, nameEn: r.dNameEn, nameAr: r.dNameAr },
        carrierName: r.carrierName,
        vesselName: r.vesselName,
        voyageNumber: r.voyageNumber,
        day: fromDbDate(r.day),
        etd: fromDbDateOrNull(r.etd),
        eta: fromDbDateOrNull(r.eta),
        basis: r.basis,
        shipments: c.shipments,
        customers: c.customerIds.size,
        packages: c.packages,
        weightKg: toDecimalString(c.weightKg),
        volumeCbm: toDecimalString(c.volumeCbm),
        contents: c.contents,
      };
    });
    return {
      byStatus,
      totals: {
        containers: containers.length,
        shipments,
        customers: customers.size,
        packages,
        weightKg: toDecimalString(weightKg),
        volumeCbm: toDecimalString(volumeCbm),
      },
      containers,
      truncated,
    };
  }

  /** Audit log: closed containers opened again (B3-5), with who did it and why. */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string;
        userId: string;
        userName: string;
        entity: 'CONTAINER';
        action: 'REVERT';
        reference: string;
        status: ConsolidationStatus;
        detail: string;
      }[]
    >`
      SELECT x."at", b."code" AS "branchCode", x."user_id" AS "userId", u."full_name" AS "userName",
             x."entity", x."action", x."reference", x."status", x."detail"
      FROM (
        SELECT r."branch_id", r."reopened_at" AS "at", r."reopened_by_id" AS "user_id",
               'CONTAINER' AS "entity", 'REVERT' AS "action", c."number" AS "reference",
               'OPEN' AS "status", r."reason" AS "detail"
        FROM "consolidation_reopenings" r
        JOIN "consolidations" c ON c."id" = r."consolidation_id"
      ) x
      JOIN "branches" b ON b."id" = x."branch_id"
      JOIN "users" u ON u."id" = x."user_id"
      WHERE x."branch_id" IN ${uuidList(branchIds)}
        AND (x."at" AT TIME ZONE b."timezone")::date BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.userId, (id) => Prisma.sql`x."user_id" = ${id}::uuid`)}
        ${auditEntityFilter(q)}
      ORDER BY x."at" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  }
}
