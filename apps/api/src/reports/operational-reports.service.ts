import { Injectable } from '@nestjs/common';
import {
  BOOKING_STATUSES,
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  OPERATIONAL_REPORT_ROW_LIMIT,
  type AuditEntity,
  type AuditLogDto,
  type AuditLogEntryDto,
  type BookingStatus,
  type CustomerActivityDto,
  type CustomsFilesDto,
  type CustomsStatus,
  type LateShipmentsDto,
  type QuotationStatus,
  type ReportBranchDto,
  type ReportLocationDto,
  type SalesConversionDto,
  type SalesConversionFiguresDto,
  type ShipmentStatus,
  type ShipmentsReportDto,
  type ShippingMode,
  type TripGroupDto,
  type TripKind,
  type TripsReportDto,
  type WarehouseMovementKind,
  type WarehouseMovementsDto,
  type WarehouseOnHandDto,
} from '@nolon/shared';
import { LedgerReportsService } from '../accounting/ledger-reports.service.js';
import { sum } from '../accounting/report-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { BillingReportsService } from '../billing/billing-reports.service.js';
import { BookingReportsService } from '../bookings/booking-reports.service.js';
import { todayIn } from '../common/dates.js';
import { type Decimal, ZERO } from '../common/money.js';
import type { AuditQuery, ShipmentAuditEntry } from '../common/report-sql.js';
import { CustomsReportsService } from '../customs/customs-reports.service.js';
import { DocumentReportsService } from '../documents/document-reports.service.js';
import { ExpenseReportsService } from '../expenses/expense-reports.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PayablesReportsService } from '../payables/payables-reports.service.js';
import { QuotationReportsService } from '../quotations/quotation-reports.service.js';
import { ShipmentReportsService } from '../shipments/shipment-reports.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { TripReportsService } from '../transport/trip-reports.service.js';
import { WarehouseReportsService } from '../warehouse/warehouse-reports.service.js';
import { type WorkbookSpec, buildWorkbook } from './excel.js';
import { averageDays, conversionRate } from './operational-math.js';
import {
  auditLogSheets,
  customerActivitySheets,
  customsFilesSheets,
  lateShipmentsSheets,
  salesConversionSheets,
  shipmentsSheets,
  tripsSheets,
  warehouseMovementsSheets,
  warehouseOnHandSheets,
} from './operational-sheets.js';
import type { ExportContext } from './report-sheets.js';
import type { ReportFile } from './reports.service.js';

export interface OpsPeriod {
  from: string;
  to: string;
  branchId?: string;
}

export type ShipmentsQuery = OpsPeriod & {
  customerId?: string;
  mode?: ShippingMode;
  status?: ShipmentStatus;
};
export type CustomerPeriod = OpsPeriod & { customerId?: string };
export type OnHandQuery = { branchId?: string; warehouseId?: string };
export type MovementsQuery = OpsPeriod & { warehouseId?: string; kind?: WarehouseMovementKind };
export type CustomsQuery = OpsPeriod & { status?: CustomsStatus };
export type TripsQuery = OpsPeriod & {
  kind?: TripKind;
  vehicleId?: string;
  driverId?: string;
  carrierId?: string;
};
export type AuditLogQuery = OpsPeriod & { userId?: string; entity?: AuditEntity };

export type OperationalReportRequest =
  | { report: 'shipments'; query: ShipmentsQuery }
  | { report: 'late-shipments'; query: CustomerPeriod }
  | { report: 'sales-conversion'; query: CustomerPeriod }
  | { report: 'customer-activity'; query: CustomerPeriod }
  | { report: 'warehouse-on-hand'; query: OnHandQuery }
  | { report: 'warehouse-movements'; query: MovementsQuery }
  | { report: 'customs-files'; query: CustomsQuery }
  | { report: 'trips'; query: TripsQuery }
  | { report: 'audit-log'; query: AuditLogQuery };

const LIMIT = OPERATIONAL_REPORT_ROW_LIMIT;

/** Adds a count to a keyed tally, keeping the first value seen for the key. */
function tally<K, V extends { count: number }>(map: Map<K, V>, key: K, make: () => V, n: number) {
  const entry = map.get(key) ?? make();
  entry.count += n;
  map.set(key, entry);
}

function routeKey(origin: ReportLocationDto, destination: ReportLocationDto): string {
  return `${origin.code}>${destination.code}`;
}

/**
 * The operational reports (annex D section 3). Each figure comes from the module that owns it,
 * through its exported report service, scoped there to the user's branches (the requested one,
 * checked, or all of theirs); shipment numbers and customers of warehouse and customs rows come
 * through the shipments module, which shows only shipments the user may see. Totals are added in
 * SQL by the owning module; this service puts them together.
 *
 * Report 5 (consolidated containers and their contents) is not here: consolidation is not built.
 */
@Injectable()
export class OperationalReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipmentReports: ShipmentReportsService,
    private readonly shipments: ShipmentsService,
    private readonly quotationReports: QuotationReportsService,
    private readonly bookingReports: BookingReportsService,
    private readonly billing: BillingReportsService,
    private readonly warehouse: WarehouseReportsService,
    private readonly customs: CustomsReportsService,
    private readonly trips: TripReportsService,
    private readonly ledger: LedgerReportsService,
    private readonly documents: DocumentReportsService,
    private readonly payables: PayablesReportsService,
    private readonly expenses: ExpenseReportsService,
  ) {}

  /** Report 1. */
  async shipmentsByStatus(user: AuthUser, q: ShipmentsQuery): Promise<ShipmentsReportDto> {
    const result = await this.shipmentReports.byStatus(user, q, LIMIT);
    const byStatus = new Map<ShipmentStatus, { status: ShipmentStatus; count: number }>();
    const byBranch = new Map<string, ReportBranchDto & { count: number }>();
    const byRoute = new Map<
      string,
      { origin: ReportLocationDto; destination: ReportLocationDto; count: number }
    >();
    const byMode = new Map<ShippingMode, { mode: ShippingMode; count: number }>();
    for (const g of result.groups) {
      tally(byStatus, g.status, () => ({ status: g.status, count: 0 }), g.count);
      tally(byBranch, g.branch.id, () => ({ ...g.branch, count: 0 }), g.count);
      tally(
        byRoute,
        routeKey(g.origin, g.destination),
        () => ({ origin: g.origin, destination: g.destination, count: 0 }),
        g.count,
      );
      tally(byMode, g.mode, () => ({ mode: g.mode, count: 0 }), g.count);
    }
    const most = (a: { count: number }, b: { count: number }) => b.count - a.count;
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      customerId: q.customerId ?? null,
      mode: q.mode ?? null,
      status: q.status ?? null,
      total: result.groups.reduce((n, g) => n + g.count, 0),
      byStatus: [...byStatus.values()].sort(
        (a, b) => most(a, b) || a.status.localeCompare(b.status),
      ),
      byBranch: [...byBranch.values()].sort((a, b) => a.code.localeCompare(b.code)),
      byRoute: [...byRoute.values()].sort(
        (a, b) =>
          most(a, b) ||
          routeKey(a.origin, a.destination).localeCompare(routeKey(b.origin, b.destination)),
      ),
      byMode: [...byMode.values()].sort((a, b) => most(a, b) || a.mode.localeCompare(b.mode)),
      shipments: result.shipments,
      truncated: result.truncated,
    };
  }

  /** Report 2. */
  async lateShipments(user: AuthUser, q: CustomerPeriod): Promise<LateShipmentsDto> {
    const r = await this.shipmentReports.late(user, q, LIMIT);
    const late = r.openLate + r.deliveredLate;
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      customerId: q.customerId ?? null,
      withEta: r.withEta,
      late,
      openLate: r.openLate,
      deliveredLate: r.deliveredLate,
      averageDaysLate: averageDays(r.totalDaysLate, late),
      shipments: r.shipments,
      truncated: r.truncated,
    };
  }

  /** Report 3: quotations sent and bookings created in the period, with their rates. */
  async salesConversion(user: AuthUser, q: CustomerPeriod): Promise<SalesConversionDto> {
    const branchIds = reportBranchIds(user, q.branchId);
    const [quotations, bookings, branches] = await Promise.all([
      this.quotationReports.sentInPeriod(user, q),
      this.bookingReports.createdInPeriod(user, q),
      this.branches(branchIds),
    ]);
    const booked = await this.bookingReports.bookedQuotationIds(
      user,
      quotations.approved.map((x) => x.id),
      q.branchId,
    );
    const figures = (branchId: string | null): SalesConversionFiguresDto => {
      const mine = <T extends { branchId: string }>(rows: T[]) =>
        rows.filter((r) => branchId === null || r.branchId === branchId);
      const quotationCount = (status: QuotationStatus) =>
        mine(quotations.counts)
          .filter((c) => c.status === status)
          .reduce((n, c) => n + c.count, 0);
      const bookingRows = mine(bookings);
      const bookingCount = (status: BookingStatus) =>
        bookingRows.filter((b) => b.status === status).reduce((n, b) => n + b.count, 0);
      const quotationsSent = mine(quotations.counts).reduce((n, c) => n + c.count, 0);
      const quotationsBooked = mine(quotations.approved).filter((x) => booked.has(x.id)).length;
      const bookingsCreated = bookingRows.reduce((n, b) => n + b.count, 0);
      const byStatus = Object.fromEntries(
        BOOKING_STATUSES.map((s) => [s, bookingCount(s)]),
      ) as Record<BookingStatus, number>;
      const sentStatuses = {
        SENT: quotationCount('SENT'),
        APPROVED: quotationCount('APPROVED'),
        REJECTED: quotationCount('REJECTED'),
        EXPIRED: quotationCount('EXPIRED'),
      };
      return {
        quotationsSent,
        quotations: sentStatuses,
        quotationsBooked,
        bookingsCreated,
        bookings: byStatus,
        bookingsFromQuotation: bookingRows
          .filter((b) => b.fromQuotation)
          .reduce((n, b) => n + b.count, 0),
        approvalRate: conversionRate(sentStatuses.APPROVED, quotationsSent),
        conversionRate: conversionRate(quotationsBooked, quotationsSent),
        confirmationRate: conversionRate(byStatus.CONFIRMED + byStatus.COMPLETED, bookingsCreated),
      };
    };
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      customerId: q.customerId ?? null,
      branches: branches.map((b) => ({
        id: b.id,
        code: b.code,
        nameEn: b.nameEn,
        nameAr: b.nameAr,
        ...figures(b.id),
      })),
      totals: figures(null),
    };
  }

  /**
   * Report 4: shipments and cargo (shipments module) per customer, with their revenue (billing)
   * only for users who may see financial reports, as on the dashboards.
   */
  async customerActivity(user: AuthUser, q: CustomerPeriod): Promise<CustomerActivityDto> {
    const revenueShown = user.permissions.has('financial_reports:view');
    const [activity, revenue] = await Promise.all([
      this.shipmentReports.activityByCustomer(user, q),
      revenueShown ? this.billing.revenueByCustomer(user, q) : Promise.resolve([]),
    ]);
    const rows = new Map<
      string,
      {
        customerId: string;
        customerName: string;
        shipments: number;
        volumeCbm: Decimal;
        weightKg: Decimal;
        invoices: number;
        revenueUsd: Decimal;
      }
    >();
    const row = (customerId: string, customerName: string) =>
      rows.get(customerId) ?? {
        customerId,
        customerName,
        shipments: 0,
        volumeCbm: ZERO,
        weightKg: ZERO,
        invoices: 0,
        revenueUsd: ZERO,
      };
    for (const a of activity) {
      rows.set(a.customerId, { ...row(a.customerId, a.customerName), ...a });
    }
    for (const r of revenue) {
      const current = row(r.customerId, r.customerName);
      rows.set(r.customerId, { ...current, invoices: r.invoices, revenueUsd: r.revenueUsd });
    }
    const list = [...rows.values()].sort(
      (a, b) =>
        b.revenueUsd.comparedTo(a.revenueUsd) ||
        b.shipments - a.shipments ||
        a.customerName.localeCompare(b.customerName),
    );
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      customerId: q.customerId ?? null,
      revenueShown,
      customers: list.map((r) => ({
        ...r,
        volumeCbm: r.volumeCbm.toFixed(),
        weightKg: r.weightKg.toFixed(),
        invoices: revenueShown ? r.invoices : null,
        revenueUsd: revenueShown ? r.revenueUsd.toFixed() : null,
      })),
      totals: {
        shipments: list.reduce((n, r) => n + r.shipments, 0),
        volumeCbm: sum(list.map((r) => r.volumeCbm)).toFixed(),
        weightKg: sum(list.map((r) => r.weightKg)).toFixed(),
        invoices: revenueShown ? list.reduce((n, r) => n + r.invoices, 0) : null,
        revenueUsd: revenueShown ? sum(list.map((r) => r.revenueUsd)).toFixed() : null,
      },
    };
  }

  /** Report 6. */
  async warehouseOnHand(user: AuthUser, q: OnHandQuery): Promise<WarehouseOnHandDto> {
    const branchIds = reportBranchIds(user, q.branchId);
    const [held, branches] = await Promise.all([
      this.warehouse.onHand(user, q, LIMIT),
      this.branches(branchIds),
    ]);
    const shipments = await this.shipmentInfo(
      user,
      held.rows.map((r) => r.shipmentId),
    );
    const first = branches[0];
    return {
      asOf: todayIn(first?.timezone ?? 'UTC'),
      branchId: q.branchId ?? null,
      warehouseId: q.warehouseId ?? null,
      rows: held.rows.flatMap((r) => {
        const s = shipments.get(r.shipmentId);
        return s
          ? [
              {
                ...r,
                shipmentNumber: s.number,
                customerId: s.customerId,
                customerName: s.customerName,
                weightKg: r.weightKg.toFixed(),
              },
            ]
          : [];
      }),
      totals: { ...held.totals, weightKg: held.totals.weightKg.toFixed() },
      truncated: held.truncated,
    };
  }

  /** Report 7. */
  async warehouseMovements(user: AuthUser, q: MovementsQuery): Promise<WarehouseMovementsDto> {
    const r = await this.warehouse.movements(user, q, LIMIT);
    const shipments = await this.shipmentInfo(
      user,
      r.movements.map((m) => m.shipmentId),
    );
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      warehouseId: q.warehouseId ?? null,
      kind: q.kind ?? null,
      receipts: r.receipts,
      releases: r.releases,
      movements: r.movements.flatMap((m) => {
        const s = shipments.get(m.shipmentId);
        return s
          ? [
              {
                ...m,
                shipmentNumber: s.number,
                customerId: s.customerId,
                customerName: s.customerName,
              },
            ]
          : [];
      }),
      truncated: r.truncated,
    };
  }

  /** Report 8. */
  async customsFiles(user: AuthUser, q: CustomsQuery): Promise<CustomsFilesDto> {
    const r = await this.customs.files(user, q, LIMIT);
    const shipments = await this.shipmentInfo(
      user,
      r.files.map((f) => f.shipmentId),
    );
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      status: q.status ?? null,
      byStatus: r.byStatus.sort((a, b) => a.status.localeCompare(b.status)),
      total: r.byStatus.reduce((n, s) => n + s.count, 0),
      averageClearanceDays: averageDays(r.cleared.totalDays, r.cleared.files),
      files: r.files.flatMap((f) => {
        const s = shipments.get(f.shipmentId);
        return s
          ? [
              {
                ...f,
                shipmentNumber: s.number,
                customerId: s.customerId,
                customerName: s.customerName,
              },
            ]
          : [];
      }),
      truncated: r.truncated,
    };
  }

  /**
   * Report 9: trips (transport) with their cost from the posted entries (accounting). Own
   * vehicles and drivers are grouped by record; hired ones show on the trip as written.
   */
  async tripsReport(user: AuthUser, q: TripsQuery, limit = LIMIT): Promise<TripsReportDto> {
    const r = await this.trips.trips(user, q, limit);
    // Totals and groups cover every matching trip; only the listed rows are cut at the limit.
    const costs = await this.ledger.entryCostsUsd(
      user,
      r.all.flatMap((t) => t.costEntryIds),
      q.branchId,
    );
    const costOf = (entryIds: readonly string[]) =>
      sum(entryIds.map((id) => costs.get(id) ?? ZERO));
    const all = r.all.map((t) => ({ ...t, cost: costOf(t.costEntryIds) }));
    const group = (key: (t: (typeof all)[number]) => { id: string; name: string } | null) => {
      const groups = new Map<string, { id: string; name: string; trips: number; cost: Decimal }>();
      for (const t of all) {
        const k = key(t);
        if (!k) continue;
        const g = groups.get(k.id) ?? { ...k, trips: 0, cost: ZERO };
        g.trips += 1;
        g.cost = g.cost.plus(t.cost);
        groups.set(k.id, g);
      }
      return [...groups.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((g): TripGroupDto => ({
          id: g.id,
          name: g.name,
          trips: g.trips,
          costUsd: g.cost.toFixed(),
        }));
    };
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      kind: q.kind ?? null,
      vehicleId: q.vehicleId ?? null,
      driverId: q.driverId ?? null,
      carrierId: q.carrierId ?? null,
      trips: r.trips.map(({ costEntryIds, ...t }) => ({
        ...t,
        costUsd: costOf(costEntryIds).toFixed(),
      })),
      byVehicle: group((t) =>
        t.vehicleId && t.vehicle ? { id: t.vehicleId, name: t.vehicle } : null,
      ),
      byDriver: group((t) => (t.driverId && t.driver ? { id: t.driverId, name: t.driver } : null)),
      byCarrier: group((t) =>
        t.carrierId && t.carrierName ? { id: t.carrierId, name: t.carrierName } : null,
      ),
      totals: { trips: all.length, costUsd: sum(all.map((t) => t.cost)).toFixed() },
      truncated: r.truncated,
    };
  }

  /**
   * Report 10: who changed what and when, newest first, from the records that keep it (see
   * AUDIT_ENTITIES). Each source returns its newest rows of the wanted kind (filtered in its SQL,
   * before its limit); the merged list is cut at the limit.
   */
  async auditLog(user: AuthUser, q: AuditLogQuery): Promise<AuditLogDto> {
    reportBranchIds(user, q.branchId);
    const aq: AuditQuery = {
      from: q.from,
      to: q.to,
      branchId: q.branchId,
      userId: q.userId,
      entity: q.entity,
      limit: LIMIT,
    };
    const wants = (...entities: AuditEntity[]) => !q.entity || entities.includes(q.entity);
    const none = Promise.resolve([]);
    const sources = await Promise.all([
      wants('SHIPMENT') ? this.shipmentReports.auditEntries(user, aq) : none,
      wants('WAREHOUSE_MOVEMENT') ? this.warehouse.auditEntries(user, aq) : none,
      wants('CUSTOMS')
        ? this.customs.auditEntries(user, aq).then((rows) => this.withShipmentNumbers(user, rows))
        : none,
      wants('JOURNAL_ENTRY') ? this.ledger.auditEntries(user, aq) : none,
      wants('INVOICE', 'RECEIPT', 'CREDIT_NOTE') ? this.billing.auditEntries(user, aq) : none,
      wants('SUPPLIER_BILL', 'SUPPLIER_PAYMENT') ? this.payables.auditEntries(user, aq) : none,
      wants('EXPENSE') ? this.expenses.auditEntries(user, aq) : none,
      wants('TRIP', 'TRIP_EXPENSE', 'POD') ? this.trips.auditEntries(user, aq) : none,
      wants('DOCUMENT') ? this.documents.auditEntries(user, aq) : none,
    ]);
    const merged = sources.flat().sort((a, b) => b.at.localeCompare(a.at));
    const users = new Map<string, string>();
    const entries = merged.slice(0, LIMIT);
    for (const e of entries) if (e.userId && e.userName) users.set(e.userId, e.userName);
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      userId: q.userId ?? null,
      entity: q.entity ?? null,
      entries,
      users: [...users]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      truncated: merged.length > LIMIT,
    };
  }

  /** The report as an Excel workbook, with headers in `locale` (else the user's language). */
  async export(
    user: AuthUser,
    request: OperationalReportRequest,
    locale?: Locale,
  ): Promise<ReportFile> {
    const { branchId } = request.query;
    const [branch] = await this.branches(reportBranchIds(user, branchId));
    const ctx: ExportContext = {
      locale: locale ?? (isLocale(user.preferredLocale) ? user.preferredLocale : DEFAULT_LOCALE),
      branchCode: branchId ? (branch?.code ?? null) : null,
    };
    const spec = await this.workbookSpec(user, request, ctx);
    const q = request.query;
    const dates = 'from' in q ? `${q.from}_${q.to}` : todayIn(branch?.timezone ?? 'UTC');
    return { fileName: `${request.report}-${dates}.xlsx`, data: await buildWorkbook(spec) };
  }

  private async workbookSpec(
    user: AuthUser,
    request: OperationalReportRequest,
    ctx: ExportContext,
  ): Promise<WorkbookSpec> {
    switch (request.report) {
      case 'shipments':
        return shipmentsSheets(ctx, await this.shipmentsByStatus(user, request.query));
      case 'late-shipments':
        return lateShipmentsSheets(ctx, await this.lateShipments(user, request.query));
      case 'sales-conversion':
        return salesConversionSheets(ctx, await this.salesConversion(user, request.query));
      case 'customer-activity':
        return customerActivitySheets(ctx, await this.customerActivity(user, request.query));
      case 'warehouse-on-hand':
        return warehouseOnHandSheets(ctx, await this.warehouseOnHand(user, request.query));
      case 'warehouse-movements':
        return warehouseMovementsSheets(ctx, await this.warehouseMovements(user, request.query));
      case 'customs-files':
        return customsFilesSheets(ctx, await this.customsFiles(user, request.query));
      case 'trips':
        return tripsSheets(ctx, await this.tripsReport(user, request.query));
      case 'audit-log':
        return auditLogSheets(ctx, await this.auditLog(user, request.query));
    }
  }

  /** The report's branches, by code, with their time zones. */
  private async branches(
    branchIds: readonly string[],
  ): Promise<(ReportBranchDto & { timezone: string })[]> {
    if (branchIds.length === 0) return [];
    return this.prisma.branch.findMany({
      where: { id: { in: [...branchIds] } },
      select: { id: true, code: true, nameEn: true, nameAr: true, timezone: true },
      orderBy: { code: 'asc' },
    });
  }

  /** Number and customer of the shipments among `ids` the user may see (shipments module). */
  private async shipmentInfo(
    user: AuthUser,
    ids: readonly string[],
  ): Promise<Map<string, { number: string; customerId: string; customerName: string }>> {
    const unique = [...new Set(ids)];
    const summaries = await this.shipments.reportSummaries(user, unique);
    return new Map(summaries.map((s) => [s.id, s]));
  }

  private async withShipmentNumbers(
    user: AuthUser,
    entries: ShipmentAuditEntry[],
  ): Promise<AuditLogEntryDto[]> {
    const shipments = await this.shipmentInfo(
      user,
      entries.map((e) => e.shipmentId),
    );
    return entries.flatMap(({ shipmentId, ...e }) => {
      const s = shipments.get(shipmentId);
      return s ? [{ ...e, reference: s.number }] : [];
    });
  }
}
