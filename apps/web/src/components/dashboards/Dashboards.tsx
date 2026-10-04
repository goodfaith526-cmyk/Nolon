'use client';

import type {
  BranchDashboardDto,
  DashboardShipmentRefDto,
  ManagementDashboardDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { AmountCell, EmptyRow, ReportTable } from '../finance/reports/ReportKit';
import { Money } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

interface Query {
  from: string;
  to: string;
  branchId: string;
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-body">
        <span className="stat-label">{label}</span>
        <span className="stat-value" dir="ltr">
          {value}
        </span>
        {hint && <span className="stat-hint">{hint}</span>}
      </span>
    </div>
  );
}

/**
 * A dashboard page: period and branch filters, and the figures `children` draws once loaded. The
 * API checks the permission and the branch; this only hides what the user cannot use.
 */
function DashboardView<T>({
  path,
  title,
  hint,
  allBranches,
  children,
}: {
  path: '/dashboard/management' | '/dashboard/branch';
  title: string;
  hint: string;
  /** Whether "all my branches" is a choice (management) or one branch is (branch dashboard). */
  allBranches: boolean;
  children: (data: T) => ReactNode;
}) {
  const t = useTranslations('Dashboards');
  const tr = useTranslations('Reports');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  const [query, setQuery] = useState<Query>(() => {
    const today = todayString();
    return {
      from: `${today.slice(0, 8)}01`,
      to: today,
      branchId: allBranches && me.allBranches ? '' : (me.branches[0]?.id ?? ''),
    };
  });
  const [data, setData] = useState<{ key: string; value: T } | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const allowed = can(me, 'dashboards:view');
  const params = new URLSearchParams({ from: query.from, to: query.to });
  if (query.branchId) params.set('branchId', query.branchId);
  const key = params.toString();

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    api<T>(`${path}?${key}`)
      .then((value) => {
        if (!cancelled) setData({ key, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, path, key, failure]);

  if (!allowed) return <p className="error">{tc('noAccess')}</p>;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setNotice(null);
    setQuery({
      from: field(form, 'from') || query.from,
      to: field(form, 'to') || query.to,
      branchId: field(form, 'branchId'),
    });
  }

  const shown = data?.key === key ? data.value : null;
  return (
    <section className="stack report dashboard">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{hint}</p>
        </div>
        <Link href={allBranches ? '/dashboard/branch' : '/dashboard/management'} className="button">
          {allBranches ? t('branchTitle') : t('managementTitle')}
        </Link>
      </div>
      <Notice notice={notice} />
      <form className="row report-filters" onSubmit={onSubmit}>
        <label className="field">
          <span>{tr('from')}</span>
          <input type="date" name="from" required defaultValue={query.from} />
        </label>
        <label className="field">
          <span>{tr('to')}</span>
          <input type="date" name="to" required defaultValue={query.to} />
        </label>
        <label className="field">
          <span>{tr('branch')}</span>
          <select name="branchId" defaultValue={query.branchId}>
            {allBranches && me.allBranches && <option value="">{tr('allBranches')}</option>}
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          {tr('show')}
        </button>
      </form>
      {shown === null
        ? notice === null && <p className="muted">{tc('loading')}</p>
        : children(shown)}
    </section>
  );
}

/** The sections both dashboards share: shipments, finance per branch, top customers. */
function CommonFigures({ data }: { data: ManagementDashboardDto }) {
  const t = useTranslations('Dashboards');
  const tr = useTranslations('Reports');
  return (
    <>
      {data.shipments && (
        <>
          <div className="stats">
            <Stat label={t('openShipments')} value={data.shipments.open} />
            <Stat label={t('newInPeriod')} value={data.shipments.newInPeriod} />
            <Stat label={t('deliveredInPeriod')} value={data.shipments.deliveredInPeriod} />
            <Stat label={t('late')} value={data.shipments.late} hint={t('lateHint')} />
          </div>
          <ReportTable title={t('byStatus')}>
            <tbody>
              {data.shipments.byStatus.length === 0 && (
                <EmptyRow columns={2} text={t('noOpenShipments')} />
              )}
              {data.shipments.byStatus.map((s) => (
                <tr key={s.status}>
                  <td>
                    <StatusBadge kind="shipment" status={s.status} />
                  </td>
                  <td dir="ltr">{s.count}</td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </>
      )}
      {data.finance && (
        <>
          <div className="stats">
            <Stat
              label={tr('revenueUsd')}
              value={<Money value={data.finance.totals.revenueUsd} />}
            />
            <Stat label={tr('costUsd')} value={<Money value={data.finance.totals.costUsd} />} />
            <Stat label={t('profitUsd')} value={<Money value={data.finance.totals.profitUsd} />} />
            <Stat
              label={t('overdueUsd')}
              value={<Money value={data.finance.overdueReceivablesUsd} />}
              hint={t.rich('overdueHint', {
                date: () => (
                  <span className="nowrap" dir="ltr">
                    {data.to}
                  </span>
                ),
              })}
            />
          </div>
          <ReportTable title={t('byBranch')}>
            <thead>
              <tr>
                <th>{tr('branch')}</th>
                <th>{tr('revenueUsd')}</th>
                <th>{tr('costUsd')}</th>
                <th>{t('profitUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {data.finance.branches.map((b) => (
                <tr key={b.id}>
                  <td dir="ltr">{b.code}</td>
                  <AmountCell value={b.revenueUsd} />
                  <AmountCell value={b.costUsd} />
                  <AmountCell value={b.profitUsd} />
                </tr>
              ))}
              <tr className="subtotal">
                <td>{tr('total')}</td>
                <AmountCell value={data.finance.totals.revenueUsd} strong />
                <AmountCell value={data.finance.totals.costUsd} strong />
                <AmountCell value={data.finance.totals.profitUsd} strong />
              </tr>
            </tbody>
          </ReportTable>
        </>
      )}
      {data.topCustomers && (
        <ReportTable title={t('topCustomers')}>
          <thead>
            <tr>
              <th>{tr('customer')}</th>
              <th>{tr('invoices')}</th>
              <th>{tr('revenueUsd')}</th>
            </tr>
          </thead>
          <tbody>
            {data.topCustomers.length === 0 && <EmptyRow columns={3} text={t('noRevenue')} />}
            {data.topCustomers.map((c) => (
              <tr key={c.customerId}>
                <td>
                  <Link href={`/customers/${c.customerId}`}>{c.customerName}</Link>
                </td>
                <td dir="ltr">{c.invoices}</td>
                <AmountCell value={c.revenueUsd} />
              </tr>
            ))}
          </tbody>
        </ReportTable>
      )}
      <p className="muted">{t('noAlerts')}</p>
    </>
  );
}

export function ManagementDashboard() {
  const t = useTranslations('Dashboards');
  return (
    <DashboardView<ManagementDashboardDto>
      path="/dashboard/management"
      title={t('managementTitle')}
      hint={t('managementHint')}
      allBranches
    >
      {(data) => <CommonFigures data={data} />}
    </DashboardView>
  );
}

function ShipmentList({ title, rows }: { title: string; rows: DashboardShipmentRefDto[] }) {
  const t = useTranslations('Dashboards');
  const tr = useTranslations('Reports');
  return (
    <ReportTable title={title}>
      <tbody>
        {rows.length === 0 && <EmptyRow columns={4} text={t('noneToday')} />}
        {rows.map((s) => (
          <tr key={s.shipmentId}>
            <td dir="ltr">
              <Link href={`/shipments/${s.shipmentId}`}>{s.number}</Link>
            </td>
            <td>{s.customerName}</td>
            <td dir="ltr" title={tr('route')}>
              {s.origin.code} → {s.destination.code}
            </td>
            <td>
              <StatusBadge kind="shipment" status={s.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </ReportTable>
  );
}

export function BranchDashboard() {
  const t = useTranslations('Dashboards');
  const name = useLocalName();
  return (
    <DashboardView<BranchDashboardDto>
      path="/dashboard/branch"
      title={t('branchTitle')}
      hint={t('branchHint')}
      allBranches={false}
    >
      {(data) => (
        <>
          <h2 className="section-title">
            {data.branch.code} · {name(data.branch)} —{' '}
            {t.rich('today', {
              date: () => (
                <span className="nowrap" dir="ltr">
                  {data.today}
                </span>
              ),
            })}
          </h2>
          {data.todayShipments && (
            <>
              <ShipmentList title={t('inbound')} rows={data.todayShipments.inbound} />
              <ShipmentList title={t('outbound')} rows={data.todayShipments.outbound} />
            </>
          )}
          {data.warehouse && (
            <div className="stats">
              <Stat label={t('warehouseShipments')} value={data.warehouse.shipments} />
              <Stat
                label={t('warehousePackages')}
                value={data.warehouse.packages}
                hint={t('weightHint', { weight: data.warehouse.weightKg })}
              />
              <Stat label={t('receivedToday')} value={data.warehouse.receivedToday} />
              <Stat label={t('releasedToday')} value={data.warehouse.releasedToday} />
            </div>
          )}
          {data.trips && (
            <ReportTable title={t('activeTrips', { planned: data.trips.planned })}>
              <tbody>
                {data.trips.active.length === 0 && <EmptyRow columns={4} text={t('noTrips')} />}
                {data.trips.active.map((trip) => (
                  <tr key={trip.tripId}>
                    <td dir="ltr">
                      <Link href={`/trips/${trip.tripId}`}>{trip.number}</Link>
                    </td>
                    <td>
                      <StatusBadge kind="trip" status={trip.status} />
                    </td>
                    <td dir="ltr">
                      {trip.origin.code} → {trip.destination.code}
                    </td>
                    <td>{[trip.vehicle, trip.driver].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          )}
          <CommonFigures data={data} />
        </>
      )}
    </DashboardView>
  );
}
