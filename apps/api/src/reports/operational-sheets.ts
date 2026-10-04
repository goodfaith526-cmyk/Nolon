import type {
  AuditLogDto,
  CustomerActivityDto,
  CustomsFilesDto,
  LateShipmentsDto,
  Locale,
  ReportLocationDto,
  SalesConversionDto,
  SalesConversionFiguresDto,
  ShipmentsReportDto,
  TripGroupDto,
  TripsReportDto,
  WarehouseMovementsDto,
  WarehouseOnHandDto,
} from '@nolon/shared';
import type { CellKind, ColumnSpec, RowSpec, SheetSpec, WorkbookSpec } from './excel.js';
import { type OpsLabelKey, type OpsTranslate, opsTranslator } from './operational-labels.js';
import type { ExportContext } from './report-sheets.js';

const col = (header: string, kind: CellKind, width?: number): ColumnSpec => ({
  header,
  kind,
  width,
});

function place(locale: Locale, l: ReportLocationDto): string {
  return `${l.code} · ${locale === 'ar' ? l.nameAr : l.nameEn}`;
}

/** "2026-03-01T08:30:00.000Z" as "2026-03-01 08:30". */
function utcTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function book(
  ctx: ExportContext,
  title: OpsLabelKey,
  lines: string[],
  sheets: SheetSpec[],
  truncated = false,
): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  return {
    locale: ctx.locale,
    title: t(title),
    subtitle: [
      ...lines,
      `${t('branch')}: ${ctx.branchCode ?? t('allBranches')}`,
      ...(truncated ? [t('truncated')] : []),
    ],
    sheets,
  };
}

const period = (t: OpsTranslate, from: string, to: string) => `${t('period')}: ${from} - ${to}`;

export function shipmentsSheets(ctx: ExportContext, r: ShipmentsReportDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const section = (label: OpsLabelKey, rows: [string, number][]): RowSpec[] => [
    { cells: [t(label)], bold: true },
    ...rows.map(([value, count]): RowSpec => ({ cells: [null, value, count] })),
  ];
  const summary: RowSpec[] = [
    ...section(
      'byStatus',
      r.byStatus.map((s) => [t.value('shipmentStatus', s.status), s.count]),
    ),
    ...section(
      'byBranch',
      r.byBranch.map((b) => [b.code, b.count]),
    ),
    ...section(
      'byMode',
      r.byMode.map((m) => [t.value('mode', m.mode), m.count]),
    ),
    ...section(
      'byRoute',
      r.byRoute.map((x) => [
        `${place(ctx.locale, x.origin)} → ${place(ctx.locale, x.destination)}`,
        x.count,
      ]),
    ),
    { cells: [t('total'), null, r.total], bold: true },
  ];
  const list: RowSpec[] = r.shipments.map((s) => ({
    cells: [
      s.number,
      s.branchCode,
      s.customerName,
      place(ctx.locale, s.origin),
      place(ctx.locale, s.destination),
      t.value('mode', s.mode),
      t.value('shipmentStatus', s.status),
      s.createdOn,
      s.etd,
      s.eta,
    ],
  }));
  return book(
    ctx,
    'shipmentsReport',
    [period(t, r.from, r.to)],
    [
      {
        name: t('summary'),
        columns: [
          col(t('group'), 'text', 18),
          col(t('value'), 'text', 44),
          col(t('count'), 'integer'),
        ],
        rows: summary,
      },
      {
        name: t('shipments'),
        columns: [
          col(t('number'), 'text', 22),
          col(t('branch'), 'text', 8),
          col(t('customer'), 'text'),
          col(t('origin'), 'text'),
          col(t('destination'), 'text'),
          col(t('mode'), 'text', 10),
          col(t('status'), 'text', 24),
          col(t('createdOn'), 'date'),
          col(t('etd'), 'date'),
          col(t('eta'), 'date'),
        ],
        rows: list,
      },
    ],
    r.truncated,
  );
}

export function lateShipmentsSheets(ctx: ExportContext, r: LateShipmentsDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const rows: RowSpec[] = r.shipments.map((s) => ({
    cells: [
      s.number,
      s.branchCode,
      s.customerName,
      place(ctx.locale, s.origin),
      place(ctx.locale, s.destination),
      t.value('mode', s.mode),
      t.value('shipmentStatus', s.status),
      s.eta,
      s.deliveredOn,
      s.daysLate,
    ],
  }));
  return book(
    ctx,
    'lateShipments',
    [`${t('etaPeriod')}: ${r.from} - ${r.to}`],
    [
      {
        name: t('summary'),
        columns: [
          col(t('value'), 'text', 40),
          col(t('count'), 'integer', 12),
          col(t('averageDaysLate'), 'percent', 16),
        ],
        rows: [
          { cells: [t('withEta'), r.withEta] },
          { cells: [t('late'), r.late, r.averageDaysLate], bold: true },
          { cells: [t('openLate'), r.openLate] },
          { cells: [t('deliveredLate'), r.deliveredLate] },
        ],
      },
      {
        name: t('shipments'),
        columns: [
          col(t('number'), 'text', 22),
          col(t('branch'), 'text', 8),
          col(t('customer'), 'text'),
          col(t('origin'), 'text'),
          col(t('destination'), 'text'),
          col(t('mode'), 'text', 10),
          col(t('status'), 'text', 24),
          col(t('eta'), 'date'),
          col(t('deliveredOn'), 'date'),
          col(t('daysLate'), 'integer'),
        ],
        rows,
      },
    ],
    r.truncated,
  );
}

export function salesConversionSheets(ctx: ExportContext, r: SalesConversionDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const cells = (f: SalesConversionFiguresDto) => [
    f.quotationsSent,
    f.quotations.SENT,
    f.quotations.APPROVED,
    f.quotations.REJECTED,
    f.quotations.EXPIRED,
    f.quotationsBooked,
    f.approvalRate,
    f.conversionRate,
    f.bookingsCreated,
    f.bookings.DRAFT,
    f.bookings.CONFIRMED,
    f.bookings.COMPLETED,
    f.bookings.CANCELLED,
    f.bookingsFromQuotation,
    f.confirmationRate,
  ];
  const n = (key: OpsLabelKey) => col(t(key), 'integer', 12);
  const pct = (key: OpsLabelKey) => col(t(key), 'percent', 14);
  return book(
    ctx,
    'salesConversion',
    [period(t, r.from, r.to)],
    [
      {
        name: t('salesConversion'),
        columns: [
          col(t('branch'), 'text', 10),
          n('quotationsSent'),
          n('quotationsOpen'),
          n('quotationsApproved'),
          n('quotationsRejected'),
          n('quotationsExpired'),
          n('quotationsBooked'),
          pct('approvalRate'),
          pct('conversionRate'),
          n('bookingsCreated'),
          n('bookingsDraft'),
          n('bookingsConfirmed'),
          n('bookingsCompleted'),
          n('bookingsCancelled'),
          n('bookingsFromQuotation'),
          pct('confirmationRate'),
        ],
        rows: [
          ...r.branches.map((b): RowSpec => ({ cells: [b.code, ...cells(b)] })),
          { cells: [t('total'), ...cells(r.totals)], bold: true },
        ],
      },
    ],
  );
}

export function customerActivitySheets(ctx: ExportContext, r: CustomerActivityDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  // Invoices and revenue only for users who may see them (r.revenueShown).
  const money = (invoices: number | null, revenue: string | null) =>
    r.revenueShown ? [invoices ?? 0, revenue ?? '0'] : [];
  const rows: RowSpec[] = r.customers.map((c) => ({
    cells: [
      c.customerName,
      c.shipments,
      c.volumeCbm,
      c.weightKg,
      ...money(c.invoices, c.revenueUsd),
    ],
  }));
  rows.push({
    cells: [
      t('total'),
      r.totals.shipments,
      r.totals.volumeCbm,
      r.totals.weightKg,
      ...money(r.totals.invoices, r.totals.revenueUsd),
    ],
    bold: true,
  });
  return book(
    ctx,
    'customerActivity',
    r.revenueShown ? [period(t, r.from, r.to), t('revenueNote')] : [period(t, r.from, r.to)],
    [
      {
        name: t('customerActivity'),
        columns: [
          col(t('customer'), 'text', 36),
          col(t('shipmentCount'), 'integer', 12),
          col(t('volumeCbm'), 'amount'),
          col(t('weightKg'), 'amount'),
          ...(r.revenueShown
            ? [col(t('invoices'), 'integer', 12), col(t('revenueUsd'), 'amount')]
            : []),
        ],
        rows,
      },
    ],
  );
}

export function warehouseOnHandSheets(ctx: ExportContext, r: WarehouseOnHandDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const rows: RowSpec[] = r.rows.map((x) => ({
    cells: [
      x.warehouseCode,
      x.shipmentNumber,
      x.branchCode,
      x.customerName,
      x.packages,
      x.weightKg,
      x.heldSince,
      x.daysHeld,
    ],
  }));
  rows.push({
    cells: [t('total'), r.totals.shipments, null, null, r.totals.packages, r.totals.weightKg],
    bold: true,
  });
  return book(
    ctx,
    'warehouseOnHand',
    [`${t('asOf')}: ${r.asOf}`],
    [
      {
        name: t('warehouseOnHand'),
        columns: [
          col(t('warehouse'), 'text', 16),
          col(t('shipment'), 'text', 22),
          col(t('branch'), 'text', 8),
          col(t('customer'), 'text'),
          col(t('packages'), 'integer', 12),
          col(t('weightKg'), 'amount'),
          col(t('heldSince'), 'date'),
          col(t('daysHeld'), 'integer', 12),
        ],
        rows,
      },
    ],
    r.truncated,
  );
}

export function warehouseMovementsSheets(
  ctx: ExportContext,
  r: WarehouseMovementsDto,
): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const rows: RowSpec[] = r.movements.map((m) => ({
    cells: [
      m.number,
      t.value('movementKind', m.kind),
      utcTime(m.occurredAt),
      m.warehouseCode,
      m.shipmentNumber,
      m.branchCode,
      m.customerName,
      m.packages,
      m.weightKg,
      t.value('condition', m.condition),
      m.partyName,
      m.createdByName,
    ],
  }));
  const totals = (label: OpsLabelKey, x: WarehouseMovementsDto['receipts']): RowSpec => ({
    cells: [t(label), String(x.movements), null, null, null, null, null, x.packages, x.weightKg],
    bold: true,
  });
  rows.push(totals('receipts', r.receipts), totals('releases', r.releases));
  return book(
    ctx,
    'warehouseMovements',
    [period(t, r.from, r.to)],
    [
      {
        name: t('movements'),
        columns: [
          col(t('number'), 'text', 22),
          col(t('kind'), 'text', 16),
          col(t('occurredAt'), 'text', 18),
          col(t('warehouse'), 'text', 14),
          col(t('shipment'), 'text', 22),
          col(t('branch'), 'text', 8),
          col(t('customer'), 'text'),
          col(t('packages'), 'integer', 12),
          col(t('weightKg'), 'amount'),
          col(t('condition'), 'text', 12),
          col(t('party'), 'text', 24),
          col(t('recordedBy'), 'text', 24),
        ],
        rows,
      },
    ],
    r.truncated,
  );
}

export function customsFilesSheets(ctx: ExportContext, r: CustomsFilesDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const files: RowSpec[] = r.files.map((f) => ({
    cells: [
      f.shipmentNumber,
      f.branchCode,
      f.customerName,
      t.value('customsStatus', f.status),
      f.declarationNumber,
      f.brokerName,
      f.openedOn,
      f.submittedOn,
      f.clearedOn,
      f.clearanceDays,
      f.daysOpen,
    ],
  }));
  return book(
    ctx,
    'customsFiles',
    [period(t, r.from, r.to)],
    [
      {
        name: t('summary'),
        columns: [
          col(t('status'), 'text', 30),
          col(t('count'), 'integer', 12),
          col(t('averageClearanceDays'), 'percent', 18),
        ],
        rows: [
          ...r.byStatus.map((s): RowSpec => ({
            cells: [t.value('customsStatus', s.status), s.count],
          })),
          { cells: [t('total'), r.total, r.averageClearanceDays], bold: true },
        ],
      },
      {
        name: t('files'),
        columns: [
          col(t('shipment'), 'text', 22),
          col(t('branch'), 'text', 8),
          col(t('customer'), 'text'),
          col(t('status'), 'text', 20),
          col(t('declaration'), 'text', 18),
          col(t('broker'), 'text', 22),
          col(t('openedOn'), 'date'),
          col(t('submittedOn'), 'date'),
          col(t('clearedOn'), 'date'),
          col(t('clearanceDays'), 'integer', 12),
          col(t('daysOpen'), 'integer', 12),
        ],
        rows: files,
      },
    ],
    r.truncated,
  );
}

export function tripsSheets(ctx: ExportContext, r: TripsReportDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const trips: RowSpec[] = r.trips.map((x) => ({
    cells: [
      x.number,
      x.branchCode,
      x.tripDate,
      t.value('tripKind', x.kind),
      t.value('tripStatus', x.status),
      place(ctx.locale, x.origin),
      place(ctx.locale, x.destination),
      x.vehicle,
      x.driver,
      x.carrierName,
      x.shipments,
      x.costUsd,
    ],
  }));
  trips.push({
    cells: [
      t('total'),
      String(r.totals.trips),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      r.totals.costUsd,
    ],
    bold: true,
  });
  const groupSheet = (label: OpsLabelKey, groups: TripGroupDto[]): SheetSpec => ({
    name: t(label),
    columns: [
      col(t('name'), 'text', 30),
      col(t('tripCount'), 'integer', 12),
      col(t('costUsd'), 'amount'),
    ],
    rows: groups.map((g) => ({ cells: [g.name, g.trips, g.costUsd] })),
  });
  return book(
    ctx,
    'tripsReport',
    [period(t, r.from, r.to), t('costNote')],
    [
      {
        name: t('trips'),
        columns: [
          col(t('number'), 'text', 22),
          col(t('branch'), 'text', 8),
          col(t('tripDate'), 'date'),
          col(t('kind'), 'text', 16),
          col(t('status'), 'text', 12),
          col(t('origin'), 'text'),
          col(t('destination'), 'text'),
          col(t('vehicle'), 'text', 16),
          col(t('driver'), 'text', 22),
          col(t('carrier'), 'text', 22),
          col(t('shipmentCount'), 'integer', 12),
          col(t('costUsd'), 'amount'),
        ],
        rows: trips,
      },
      groupSheet('byVehicle', r.byVehicle),
      groupSheet('byDriver', r.byDriver),
      groupSheet('byCarrier', r.byCarrier),
    ],
    r.truncated,
  );
}

export function auditLogSheets(ctx: ExportContext, r: AuditLogDto): WorkbookSpec {
  const t = opsTranslator(ctx.locale);
  const statusKind = {
    SHIPMENT: 'shipmentStatus',
    CUSTOMS: 'customsStatus',
    TRIP: 'tripStatus',
  } as const;
  const rows: RowSpec[] = r.entries.map((e) => {
    const kind = e.entity in statusKind ? statusKind[e.entity as keyof typeof statusKind] : null;
    return {
      cells: [
        utcTime(e.at),
        e.branchCode,
        e.userName ?? t('system'),
        t.value('auditEntity', e.entity),
        t.value('auditAction', e.action),
        e.reference,
        kind ? t.value(kind, e.status) : null,
        e.detail,
      ],
    };
  });
  return book(
    ctx,
    'auditLog',
    [period(t, r.from, r.to), t('auditNote')],
    [
      {
        name: t('entries'),
        columns: [
          col(t('at'), 'text', 18),
          col(t('branch'), 'text', 8),
          col(t('user'), 'text', 24),
          col(t('entity'), 'text', 18),
          col(t('action'), 'text', 18),
          col(t('reference'), 'text', 24),
          col(t('status'), 'text', 20),
          col(t('detail'), 'text', 40),
        ],
        rows,
      },
    ],
    r.truncated,
  );
}
