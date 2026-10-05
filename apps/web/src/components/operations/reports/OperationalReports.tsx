'use client';

import {
  AUDIT_ENTITIES,
  CUSTOMS_STATUSES,
  SHIPMENT_STATUSES,
  SHIPPING_MODES,
  TRIP_KINDS,
  WAREHOUSE_MOVEMENT_KINDS,
  type AuditLogDto,
  type AuditLogEntryDto,
  type CarrierDto,
  type CustomerActivityDto,
  type CustomsFilesDto,
  type DriverDto,
  type LateShipmentsDto,
  type Permission,
  type ReportLocationDto,
  type SalesConversionDto,
  type SalesConversionFiguresDto,
  type ShipmentsReportDto,
  type TripGroupDto,
  type TripsReportDto,
  type VehicleDto,
  type WarehouseDto,
  type WarehouseMovementsDto,
  type WarehouseOnHandDto,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { useLocalName } from '@/lib/master-data';
import { can, useMe } from '../../StaffShell';
import { StatusBadge } from '../../StatusBadge';
import {
  AmountCell,
  EmptyRow,
  type ExtraFilter,
  type FilterSet,
  type ReportId,
  ReportTable,
  ReportView,
  useApiList,
} from '../../finance/reports/ReportKit';

const BACK = '/operational-reports';

type OpsTitle =
  | 'shipments'
  | 'late'
  | 'conversion'
  | 'activity'
  | 'onHand'
  | 'movements'
  | 'customs'
  | 'trips'
  | 'audit';

/**
 * What each report needs, as the API checks it: operational_reports:view and the view permission
 * of the module that owns the records (the audit log: audit_log:view).
 */
const REPORT_PERMISSIONS: Record<OpsTitle, readonly Permission[]> = {
  shipments: ['operational_reports:view', 'shipments:view'],
  late: ['operational_reports:view', 'shipments:view'],
  conversion: ['operational_reports:view', 'quotations:view', 'bookings:view'],
  activity: ['operational_reports:view', 'shipments:view', 'customers:view'],
  onHand: ['operational_reports:view', 'warehouse:view'],
  movements: ['operational_reports:view', 'warehouse:view'],
  customs: ['operational_reports:view', 'customs:view'],
  trips: ['operational_reports:view', 'transport_trips:view'],
  audit: ['audit_log:view'],
};

/** The report page frame for an operational report: same filters and export as the others. */
function OpsReport<T>({
  id,
  title,
  filters,
  children,
}: {
  id: ReportId;
  title: OpsTitle;
  filters: FilterSet;
  children: (report: T) => ReactNode;
}) {
  const t = useTranslations('OpsReports');
  return (
    <ReportView<T>
      id={id}
      permission={REPORT_PERMISSIONS[title]}
      title={t(title)}
      hint={t(`${title}Hint`)}
      filters={filters}
      back={{ href: BACK, label: t('allReports') }}
    >
      {(r) => children(r)}
    </ReportView>
  );
}

function usePlace(): (l: ReportLocationDto) => string {
  const name = useLocalName();
  return (l) => `${l.code} · ${name(l)}`;
}

/** Figures shown as a row of small cards above a report's tables. */
function Figures({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="figures">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd dir="ltr">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Truncated({ shown }: { shown: boolean }) {
  const t = useTranslations('OpsReports');
  return shown ? <p className="muted">{t('truncated')}</p> : null;
}

const dash = (value: string | number | null) => (value === null ? '—' : value);

function ShipmentLink({ id, number }: { id: string; number: string }) {
  return (
    <td dir="ltr">
      <Link href={`/shipments/${id}`}>{number}</Link>
    </td>
  );
}

/** Report 1. */
export function ShipmentsReport() {
  const t = useTranslations('OpsReports');
  const tc = useTranslations('Common');
  const tr = useTranslations('Reports');
  const te = useTranslations('Enums');
  const name = useLocalName();
  const place = usePlace();
  const extras: ExtraFilter[] = [
    {
      name: 'status',
      label: tr('status'),
      all: t('allStatuses'),
      options: SHIPMENT_STATUSES.map((s) => ({ value: s, label: te(`shipment_${s}`) })),
    },
    {
      name: 'mode',
      label: t('mode'),
      all: t('allModes'),
      options: SHIPPING_MODES.map((m) => ({ value: m, label: te(`mode_${m}`) })),
    },
  ];
  return (
    <OpsReport<ShipmentsReportDto>
      id="shipments"
      title="shipments"
      filters={{ dates: 'period', customer: true, extras }}
    >
      {(r) => (
        <div className="stack">
          <Figures items={[{ label: t('total'), value: r.total }]} />
          <div className="panels">
            <ReportTable title={t('byStatus')}>
              <tbody>
                {r.byStatus.length === 0 && <EmptyRow columns={2} text={t('none')} />}
                {r.byStatus.map((x) => (
                  <tr key={x.status}>
                    <td>
                      <StatusBadge kind="shipment" status={x.status} />
                    </td>
                    <td dir="ltr">{x.count}</td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
            <ReportTable title={t('byBranch')}>
              <tbody>
                {r.byBranch.length === 0 && <EmptyRow columns={2} text={t('none')} />}
                {r.byBranch.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.code} · {name(b)}
                    </td>
                    <td dir="ltr">{b.count}</td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
            <ReportTable title={t('byMode')}>
              <tbody>
                {r.byMode.length === 0 && <EmptyRow columns={2} text={t('none')} />}
                {r.byMode.map((m) => (
                  <tr key={m.mode}>
                    <td>{te(`mode_${m.mode}`)}</td>
                    <td dir="ltr">{m.count}</td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
            <ReportTable title={t('byRoute')}>
              <tbody>
                {r.byRoute.length === 0 && <EmptyRow columns={2} text={t('none')} />}
                {r.byRoute.map((x) => (
                  <tr key={`${x.origin.id}-${x.destination.id}`}>
                    <td>{tc('route', { from: place(x.origin), to: place(x.destination) })}</td>
                    <td dir="ltr">{x.count}</td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          </div>
          <Truncated shown={r.truncated} />
          <ReportTable title={tr('shipments')}>
            <thead>
              <tr>
                <th>{tr('number')}</th>
                <th>{tr('branch')}</th>
                <th>{tr('customer')}</th>
                <th>{tr('route')}</th>
                <th>{t('mode')}</th>
                <th>{tr('status')}</th>
                <th>{t('createdOn')}</th>
                <th>{t('eta')}</th>
              </tr>
            </thead>
            <tbody>
              {r.shipments.length === 0 && <EmptyRow columns={8} text={t('none')} />}
              {r.shipments.map((x) => (
                <tr key={x.shipmentId}>
                  <ShipmentLink id={x.shipmentId} number={x.number} />
                  <td dir="ltr">{x.branchCode}</td>
                  <td>{x.customerName}</td>
                  <td dir="ltr">
                    {x.origin.code} → {x.destination.code}
                  </td>
                  <td>{te(`mode_${x.mode}`)}</td>
                  <td>
                    <StatusBadge kind="shipment" status={x.status} />
                  </td>
                  <td dir="ltr">{x.createdOn}</td>
                  <td dir="ltr">{dash(x.eta)}</td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      )}
    </OpsReport>
  );
}

/** Report 2. */
export function LateShipmentsReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  return (
    <OpsReport<LateShipmentsDto>
      id="late-shipments"
      title="late"
      filters={{ dates: 'period', customer: true }}
    >
      {(r) => (
        <div className="stack">
          <Figures
            items={[
              { label: t('withEta'), value: r.withEta },
              { label: t('lateCount'), value: r.late },
              { label: t('openLate'), value: r.openLate },
              { label: t('deliveredLate'), value: r.deliveredLate },
              { label: t('averageDaysLate'), value: dash(r.averageDaysLate) },
            ]}
          />
          <Truncated shown={r.truncated} />
          <ReportTable>
            <thead>
              <tr>
                <th>{tr('number')}</th>
                <th>{tr('customer')}</th>
                <th>{tr('route')}</th>
                <th>{tr('status')}</th>
                <th>{t('eta')}</th>
                <th>{t('deliveredOn')}</th>
                <th>{t('daysLate')}</th>
              </tr>
            </thead>
            <tbody>
              {r.shipments.length === 0 && <EmptyRow columns={7} text={t('noneLate')} />}
              {r.shipments.map((x) => (
                <tr key={x.shipmentId}>
                  <ShipmentLink id={x.shipmentId} number={x.number} />
                  <td>{x.customerName}</td>
                  <td dir="ltr">
                    {x.origin.code} → {x.destination.code}
                  </td>
                  <td>
                    <StatusBadge kind="shipment" status={x.status} />
                  </td>
                  <td dir="ltr">{x.eta}</td>
                  <td dir="ltr">{dash(x.deliveredOn)}</td>
                  <td dir="ltr">
                    <strong>{x.daysLate}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      )}
    </OpsReport>
  );
}

/** Report 3. */
export function SalesConversionReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  const pct = (v: string | null) => (v === null ? '—' : `${v}%`);
  const quotationCells = (f: SalesConversionFiguresDto) => (
    <>
      <td dir="ltr">{f.quotationsSent}</td>
      <td dir="ltr">{f.quotations.SENT}</td>
      <td dir="ltr">{f.quotations.APPROVED}</td>
      <td dir="ltr">{f.quotations.REJECTED}</td>
      <td dir="ltr">{f.quotations.EXPIRED}</td>
      <td dir="ltr">{f.quotationsBooked}</td>
      <td dir="ltr">{pct(f.approvalRate)}</td>
      <td dir="ltr">{pct(f.conversionRate)}</td>
    </>
  );
  const bookingCells = (f: SalesConversionFiguresDto) => (
    <>
      <td dir="ltr">{f.bookingsCreated}</td>
      <td dir="ltr">{f.bookings.DRAFT}</td>
      <td dir="ltr">{f.bookings.CONFIRMED}</td>
      <td dir="ltr">{f.bookings.COMPLETED}</td>
      <td dir="ltr">{f.bookings.CANCELLED}</td>
      <td dir="ltr">{f.bookingsFromQuotation}</td>
      <td dir="ltr">{pct(f.confirmationRate)}</td>
    </>
  );
  return (
    <OpsReport<SalesConversionDto>
      id="sales-conversion"
      title="conversion"
      filters={{ dates: 'period', customer: true }}
    >
      {(r) => (
        <div className="stack">
          <Figures
            items={[
              { label: t('quotationsSent'), value: r.totals.quotationsSent },
              { label: t('conversionRate'), value: pct(r.totals.conversionRate) },
              { label: t('bookingsCreated'), value: r.totals.bookingsCreated },
              { label: t('confirmationRate'), value: pct(r.totals.confirmationRate) },
            ]}
          />
          <ReportTable title={t('quotations')}>
            <thead>
              <tr>
                <th>{tr('branch')}</th>
                <th>{t('quotationsSent')}</th>
                <th>{t('awaiting')}</th>
                <th>{t('approved')}</th>
                <th>{t('rejected')}</th>
                <th>{t('expired')}</th>
                <th>{t('booked')}</th>
                <th>{t('approvalRate')}</th>
                <th>{t('conversionRate')}</th>
              </tr>
            </thead>
            <tbody>
              {r.branches.map((b) => (
                <tr key={b.id}>
                  <td dir="ltr">{b.code}</td>
                  {quotationCells(b)}
                </tr>
              ))}
              <tr className="subtotal">
                <td>{tr('total')}</td>
                {quotationCells(r.totals)}
              </tr>
            </tbody>
          </ReportTable>
          <ReportTable title={t('bookings')}>
            <thead>
              <tr>
                <th>{tr('branch')}</th>
                <th>{t('bookingsCreated')}</th>
                <th>{t('draft')}</th>
                <th>{t('confirmed')}</th>
                <th>{t('completed')}</th>
                <th>{t('cancelled')}</th>
                <th>{t('fromQuotation')}</th>
                <th>{t('confirmationRate')}</th>
              </tr>
            </thead>
            <tbody>
              {r.branches.map((b) => (
                <tr key={b.id}>
                  <td dir="ltr">{b.code}</td>
                  {bookingCells(b)}
                </tr>
              ))}
              <tr className="subtotal">
                <td>{tr('total')}</td>
                {bookingCells(r.totals)}
              </tr>
            </tbody>
          </ReportTable>
          <p className="muted">{t('conversionNote')}</p>
        </div>
      )}
    </OpsReport>
  );
}

/** Report 4. */
export function CustomerActivityReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  return (
    <OpsReport<CustomerActivityDto>
      id="customer-activity"
      title="activity"
      filters={{ dates: 'period', customer: true }}
    >
      {(r) => (
        <div className="stack">
          <ReportTable>
            <thead>
              <tr>
                <th>{tr('customer')}</th>
                <th>{tr('shipmentCount')}</th>
                <th>{t('volumeCbm')}</th>
                <th>{t('weightKg')}</th>
                {r.revenueShown && (
                  <>
                    <th>{tr('invoices')}</th>
                    <th>{tr('revenueUsd')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {r.customers.length === 0 && (
                <EmptyRow columns={r.revenueShown ? 6 : 4} text={t('none')} />
              )}
              {r.customers.map((c) => (
                <tr key={c.customerId}>
                  <td>
                    <Link href={`/customers/${c.customerId}`}>{c.customerName}</Link>
                  </td>
                  <td dir="ltr">{c.shipments}</td>
                  <AmountCell value={c.volumeCbm} />
                  <AmountCell value={c.weightKg} />
                  {r.revenueShown && (
                    <>
                      <td dir="ltr">{dash(c.invoices)}</td>
                      <AmountCell value={c.revenueUsd} />
                    </>
                  )}
                </tr>
              ))}
              <tr className="subtotal">
                <td>{tr('total')}</td>
                <td dir="ltr">{r.totals.shipments}</td>
                <AmountCell value={r.totals.volumeCbm} strong />
                <AmountCell value={r.totals.weightKg} strong />
                {r.revenueShown && (
                  <>
                    <td dir="ltr">{dash(r.totals.invoices)}</td>
                    <AmountCell value={r.totals.revenueUsd} strong />
                  </>
                )}
              </tr>
            </tbody>
          </ReportTable>
          {r.revenueShown && <p className="muted">{t('revenueNote')}</p>}
        </div>
      )}
    </OpsReport>
  );
}

/** The warehouse filter, from the warehouses the user may see. */
function useWarehouseFilter(): ExtraFilter {
  const t = useTranslations('OpsReports');
  const me = useMe();
  const name = useLocalName();
  const warehouses = useApiList<WarehouseDto>('/warehouses', can(me, 'warehouse:view'));
  return {
    name: 'warehouseId',
    label: t('warehouse'),
    all: t('allWarehouses'),
    options: (warehouses ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${name(w)}` })),
  };
}

/** Report 6. */
export function WarehouseOnHandReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  const warehouse = useWarehouseFilter();
  return (
    <OpsReport<WarehouseOnHandDto>
      id="warehouse-on-hand"
      title="onHand"
      filters={{ dates: 'none', extras: [warehouse] }}
    >
      {(r) => (
        <div className="stack">
          <Figures
            items={[
              { label: t('asOf'), value: r.asOf },
              { label: tr('shipments'), value: r.totals.shipments },
              { label: t('packages'), value: r.totals.packages },
              { label: t('weightKg'), value: r.totals.weightKg },
            ]}
          />
          <p className="muted">{t('warehouseScope')}</p>
          <Truncated shown={r.truncated} />
          <ReportTable>
            <thead>
              <tr>
                <th>{t('warehouse')}</th>
                <th>{tr('shipment')}</th>
                <th>{tr('customer')}</th>
                <th>{t('packages')}</th>
                <th>{t('weightKg')}</th>
                <th>{t('heldSince')}</th>
                <th>{t('daysHeld')}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.length === 0 && <EmptyRow columns={7} text={t('nothingHeld')} />}
              {r.rows.map((x) => (
                <tr key={`${x.warehouseId}-${x.shipmentId}`}>
                  <td dir="ltr">{x.warehouseCode}</td>
                  <ShipmentLink id={x.shipmentId} number={x.shipmentNumber} />
                  <td>{x.customerName}</td>
                  <td dir="ltr">{x.packages}</td>
                  <AmountCell value={x.weightKg} />
                  <td dir="ltr">{x.heldSince}</td>
                  <td dir="ltr">
                    <strong>{x.daysHeld}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      )}
    </OpsReport>
  );
}

/** Report 7. */
export function WarehouseMovementsReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const warehouse = useWarehouseFilter();
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const kind: ExtraFilter = {
    name: 'kind',
    label: t('kind'),
    all: t('allKinds'),
    options: WAREHOUSE_MOVEMENT_KINDS.map((k) => ({ value: k, label: te(`movement_${k}`) })),
  };
  return (
    <OpsReport<WarehouseMovementsDto>
      id="warehouse-movements"
      title="movements"
      filters={{ dates: 'period', extras: [warehouse, kind] }}
    >
      {(r) => (
        <div className="stack">
          <Figures
            items={[
              { label: t('receipts'), value: r.receipts.movements },
              { label: t('receivedPackages'), value: r.receipts.packages },
              { label: t('releases'), value: r.releases.movements },
              { label: t('releasedPackages'), value: r.releases.packages },
            ]}
          />
          <p className="muted">{t('warehouseScope')}</p>
          <Truncated shown={r.truncated} />
          <ReportTable>
            <thead>
              <tr>
                <th>{tr('shipment')}</th>
                <th>{tr('customer')}</th>
                <th>{t('kind')}</th>
                <th>{t('occurredAt')}</th>
                <th>{tr('number')}</th>
                <th>{t('warehouse')}</th>
                <th>{t('packages')}</th>
                <th>{t('weightKg')}</th>
                <th>{t('recordedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {r.movements.length === 0 && <EmptyRow columns={9} text={t('none')} />}
              {r.movements.map((m) => (
                <tr key={m.movementId}>
                  <ShipmentLink id={m.shipmentId} number={m.shipmentNumber} />
                  <td>{m.customerName}</td>
                  <td>
                    <span className={`badge badge-movement badge-${m.kind}`}>
                      {te(`movement_${m.kind}`)}
                    </span>
                  </td>
                  <td>{time.format(new Date(m.occurredAt))}</td>
                  <td dir="ltr">{m.number}</td>
                  <td dir="ltr">{m.warehouseCode}</td>
                  <td dir="ltr">{m.packages}</td>
                  <AmountCell value={m.weightKg} />
                  <td>{m.createdByName}</td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      )}
    </OpsReport>
  );
}

/** Report 8. */
export function CustomsFilesReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  const te = useTranslations('Enums');
  const status: ExtraFilter = {
    name: 'status',
    label: tr('status'),
    all: t('allStatuses'),
    options: CUSTOMS_STATUSES.map((s) => ({ value: s, label: te(`customs_${s}`) })),
  };
  return (
    <OpsReport<CustomsFilesDto>
      id="customs-files"
      title="customs"
      filters={{ dates: 'period', extras: [status] }}
    >
      {(r) => (
        <div className="stack">
          <Figures
            items={[
              { label: t('files'), value: r.total },
              ...r.byStatus.map((s) => ({ label: te(`customs_${s.status}`), value: s.count })),
              { label: t('averageClearanceDays'), value: dash(r.averageClearanceDays) },
            ]}
          />
          <Truncated shown={r.truncated} />
          <ReportTable>
            <thead>
              <tr>
                <th>{tr('shipment')}</th>
                <th>{tr('customer')}</th>
                <th>{tr('status')}</th>
                <th>{t('declaration')}</th>
                <th>{t('submittedOn')}</th>
                <th>{t('clearedOn')}</th>
                <th>{t('clearanceDays')}</th>
                <th>{t('daysOpen')}</th>
              </tr>
            </thead>
            <tbody>
              {r.files.length === 0 && <EmptyRow columns={8} text={t('none')} />}
              {r.files.map((f) => (
                <tr key={f.clearanceId}>
                  <ShipmentLink id={f.shipmentId} number={f.shipmentNumber} />
                  <td>{f.customerName}</td>
                  <td>
                    <StatusBadge kind="customs" status={f.status} />
                  </td>
                  <td dir="ltr">{dash(f.declarationNumber)}</td>
                  <td dir="ltr">{dash(f.submittedOn)}</td>
                  <td dir="ltr">{dash(f.clearedOn)}</td>
                  <td dir="ltr">{dash(f.clearanceDays)}</td>
                  <td dir="ltr">{dash(f.daysOpen)}</td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
          <p className="muted">{t('customsNote')}</p>
        </div>
      )}
    </OpsReport>
  );
}

function GroupTable({
  title,
  groups,
  showsCost,
}: {
  title: string;
  groups: TripGroupDto[];
  showsCost: boolean;
}) {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  return (
    <ReportTable title={title}>
      <thead>
        <tr>
          <th>{t('name')}</th>
          <th>{tr('trips')}</th>
          {showsCost && <th>{tr('costUsd')}</th>}
        </tr>
      </thead>
      <tbody>
        {groups.length === 0 && <EmptyRow columns={showsCost ? 3 : 2} text={t('none')} />}
        {groups.map((g) => (
          <tr key={g.id}>
            <td>{g.name}</td>
            <td dir="ltr">{g.trips}</td>
            {showsCost && <AmountCell value={g.costUsd} />}
          </tr>
        ))}
      </tbody>
    </ReportTable>
  );
}

/** Report 9. */
export function TripsReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  const te = useTranslations('Enums');
  const me = useMe();
  const fleet = can(me, 'transport_fleet:view');
  const vehicles = useApiList<VehicleDto>('/transport/vehicles', fleet);
  const drivers = useApiList<DriverDto>('/transport/drivers', fleet);
  const carriers = useApiList<CarrierDto>('/transport/carriers', fleet);
  const extras: ExtraFilter[] = [
    {
      name: 'kind',
      label: t('kind'),
      all: t('allKinds'),
      options: TRIP_KINDS.map((k) => ({ value: k, label: te(`tripKind_${k}`) })),
    },
    {
      name: 'vehicleId',
      label: t('vehicle'),
      all: t('allVehicles'),
      options: (vehicles ?? []).map((v) => ({ value: v.id, label: v.plateNumber })),
    },
    {
      name: 'driverId',
      label: t('driver'),
      all: t('allDrivers'),
      options: (drivers ?? []).map((d) => ({ value: d.id, label: d.name })),
    },
    {
      name: 'carrierId',
      label: tr('carrier'),
      all: t('allCarriers'),
      options: (carriers ?? []).map((c) => ({ value: c.id, label: c.name })),
    },
  ];
  return (
    <OpsReport<TripsReportDto> id="trips" title="trips" filters={{ dates: 'period', extras }}>
      {(r) => (
        <div className="stack">
          <Figures
            items={[
              { label: tr('trips'), value: r.totals.trips },
              ...(r.showsCost && r.totals.costUsd !== null
                ? [{ label: tr('costUsd'), value: r.totals.costUsd }]
                : []),
            ]}
          />
          <Truncated shown={r.truncated} />
          <ReportTable title={tr('trips')}>
            <thead>
              <tr>
                <th>{tr('trip')}</th>
                <th>{t('tripDate')}</th>
                <th>{t('kind')}</th>
                <th>{tr('status')}</th>
                <th>{tr('route')}</th>
                <th>{t('vehicle')}</th>
                <th>{t('driver')}</th>
                <th>{tr('carrier')}</th>
                <th>{tr('shipmentCount')}</th>
                {r.showsCost && <th>{tr('costUsd')}</th>}
              </tr>
            </thead>
            <tbody>
              {r.trips.length === 0 && <EmptyRow columns={r.showsCost ? 10 : 9} text={t('none')} />}
              {r.trips.map((x) => (
                <tr key={x.tripId}>
                  <td dir="ltr">
                    <Link href={`/trips/${x.tripId}`}>{x.number}</Link>
                  </td>
                  <td dir="ltr">{x.tripDate}</td>
                  <td>{te(`tripKind_${x.kind}`)}</td>
                  <td>
                    <StatusBadge kind="trip" status={x.status} />
                  </td>
                  <td dir="ltr">
                    {x.origin.code} → {x.destination.code}
                  </td>
                  <td>{dash(x.vehicle)}</td>
                  <td>{dash(x.driver)}</td>
                  <td>{dash(x.carrierName)}</td>
                  <td dir="ltr">{x.shipments}</td>
                  {r.showsCost && <AmountCell value={x.costUsd} />}
                </tr>
              ))}
              {r.showsCost && (
                <tr className="subtotal">
                  <td>{tr('total')}</td>
                  <td colSpan={8} />
                  <AmountCell value={r.totals.costUsd} strong />
                </tr>
              )}
            </tbody>
          </ReportTable>
          <div className="panels">
            <GroupTable title={t('byVehicle')} groups={r.byVehicle} showsCost={r.showsCost} />
            <GroupTable title={t('byDriver')} groups={r.byDriver} showsCost={r.showsCost} />
            <GroupTable title={t('byCarrier')} groups={r.byCarrier} showsCost={r.showsCost} />
          </div>
          <p className="muted">{t('tripCostNote')}</p>
        </div>
      )}
    </OpsReport>
  );
}

const STATUS_KINDS = {
  SHIPMENT: 'shipment',
  CUSTOMS: 'customs',
  TRIP: 'trip',
  CREDIT_NOTE: 'creditNote',
  SUPPLIER_BILL: 'supplierBill',
  SUPPLIER_PAYMENT: 'supplierPayment',
  EXPENSE: 'expense',
} as const;

function AuditStatus({ entry }: { entry: AuditLogEntryDto }) {
  if (!entry.status) return null;
  const kind = STATUS_KINDS[entry.entity as keyof typeof STATUS_KINDS] as
    (typeof STATUS_KINDS)[keyof typeof STATUS_KINDS] | undefined;
  return kind ? <StatusBadge kind={kind} status={entry.status} /> : null;
}

/** What an audit entry changed, field by field (a field without a label shows its code). */
function AuditChanges({ entry }: { entry: AuditLogEntryDto }) {
  const t = useTranslations('OpsReports');
  if (!entry.changes?.length) return null;
  const name = (field: string) => (t.has(`field_${field}`) ? t(`field_${field}`) : field);
  // A contact's or party's field comes as `contact.phone`: shown as "Contact · Phone".
  const label = (field: string) => field.split('.').map(name).join(' · ');
  return (
    <ul className="audit-changes">
      {entry.changes.map((c) => (
        <li key={c.field}>
          {label(c.field)}: <bdi>{c.before ?? '—'}</bdi> → <bdi>{c.after ?? '—'}</bdi>
        </li>
      ))}
    </ul>
  );
}

/** Report 10. */
export function AuditLogReport() {
  const t = useTranslations('OpsReports');
  const tr = useTranslations('Reports');
  const locale = useLocale();
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const entity: ExtraFilter = {
    name: 'entity',
    label: t('entity'),
    all: t('allEntities'),
    options: AUDIT_ENTITIES.map((e) => ({ value: e, label: t(`entity_${e}`) })),
  };
  return (
    <OpsReport<AuditLogDto>
      id="audit-log"
      title="audit"
      filters={{ dates: 'period', extras: [entity] }}
    >
      {(r) => (
        <div className="stack">
          <p className="muted">{t('auditNote')}</p>
          <Truncated shown={r.truncated} />
          <ReportTable>
            <thead>
              <tr>
                <th>{t('when')}</th>
                <th>{tr('branch')}</th>
                <th>{t('user')}</th>
                <th>{t('entity')}</th>
                <th>{t('action')}</th>
                <th>{t('reference')}</th>
                <th>{tr('status')}</th>
                <th>{t('changes')}</th>
                <th>{t('detail')}</th>
                <th>{t('source')}</th>
              </tr>
            </thead>
            <tbody>
              {r.entries.length === 0 && <EmptyRow columns={10} text={t('none')} />}
              {r.entries.map((e, i) => (
                <tr key={`${e.at}-${e.entity}-${e.reference}-${i}`}>
                  <td>{time.format(new Date(e.at))}</td>
                  <td dir="ltr">{e.branchCode}</td>
                  <td>{e.userName ?? t('notRecorded')}</td>
                  <td>{t(`entity_${e.entity}`)}</td>
                  <td>{t(`action_${e.action}`)}</td>
                  <td dir="ltr">{e.reference}</td>
                  <td>
                    <AuditStatus entry={e} />
                  </td>
                  <td className="wrap">
                    <AuditChanges entry={e} />
                  </td>
                  <td className="wrap">{e.detail ?? ''}</td>
                  <td>{e.source ? t(`source_${e.source}`) : ''}</td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      )}
    </OpsReport>
  );
}

const REPORTS: readonly { href: string; title: OpsTitle }[] = [
  { href: '/shipments', title: 'shipments' },
  { href: '/late-shipments', title: 'late' },
  { href: '/sales-conversion', title: 'conversion' },
  { href: '/customer-activity', title: 'activity' },
  { href: '/warehouse-on-hand', title: 'onHand' },
  { href: '/warehouse-movements', title: 'movements' },
  { href: '/customs-files', title: 'customs' },
  { href: '/trips', title: 'trips' },
  { href: '/audit-log', title: 'audit' },
];

/** The operational reports the user may open. */
export function OperationalReportsIndex() {
  const t = useTranslations('OpsReports');
  const tc = useTranslations('Common');
  const me = useMe();
  const reports = REPORTS.filter((r) => REPORT_PERMISSIONS[r.title].every((p) => can(me, p)));
  if (reports.length === 0) return <p className="error">{tc('noAccess')}</p>;
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('intro')}</p>
        </div>
      </div>
      <div className="grid report-cards">
        {reports.map((r) => (
          <Link key={r.href} href={`${BACK}${r.href}`} className="report-card">
            <strong>{t(r.title)}</strong>
            <span className="muted">{t(`${r.title}Hint`)}</span>
          </Link>
        ))}
      </div>
      <p className="muted">{t('notBuilt')}</p>
    </section>
  );
}
