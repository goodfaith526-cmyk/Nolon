'use client';

import type { DashboardDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/money';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { icons } from './Icons';
import { MoreMenu } from './MoreMenu';
import { can, useMe } from './StaffShell';
import { StatusBadge } from './StatusBadge';

function Stat({
  href,
  icon,
  label,
  value,
  hint,
}: {
  /** The page the figure opens; none when the user has no page listing it. */
  href?: string;
  icon: ReactNode;
  label: string;
  value: number;
  hint?: string;
}) {
  const body = (
    <>
      <span className="stat-icon">{icon}</span>
      <span className="stat-body">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
        {hint && <span className="stat-hint">{hint}</span>}
      </span>
    </>
  );
  return href ? (
    <Link href={href} className="stat">
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function Dashboard() {
  const t = useTranslations('Dashboard');
  const tc = useTranslations('Common');
  const tRoles = useTranslations('Roles');
  const te = useTranslations('Enums');
  const tAlerts = useTranslations('Alerts');
  const locale = useLocale();
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const [data, setData] = useState<DashboardDto | null>(null);
  const [failed, setFailed] = useState(false);
  const list = new Intl.ListFormat(locale);

  useEffect(() => {
    let cancelled = false;
    api<DashboardDto>('/dashboard')
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const quick = [
    { href: '/customers?new=1', label: t('newCustomer'), show: can(me, 'customers:create') },
    { href: '/quotations/new', label: t('newQuotation'), show: can(me, 'quotations:create') },
    { href: '/bookings/new', label: t('newBooking'), show: can(me, 'bookings:create') },
  ].filter((q) => q.show);

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('welcome', { name: me.fullName })}</h1>
          <p className="muted">
            {list.format(me.roles.map((role) => tRoles(role)))} ·{' '}
            {me.allBranches
              ? t('allBranches')
              : list.format(me.branches.map((b) => (locale === 'ar' ? b.nameAr : b.nameEn)))}
          </p>
        </div>
        {quick.length > 0 && (
          <div className="actions">
            <MoreMenu primary label={tc('new')}>
              {quick.map((q) => (
                <Link key={q.href} href={q.href}>
                  {icons.plus}
                  <span>{q.label}</span>
                </Link>
              ))}
            </MoreMenu>
          </div>
        )}
      </div>

      {failed && <p className="error">{t('loadFailed')}</p>}
      {!data && !failed && <p className="muted">{tc('loading')}</p>}

      {data && (
        <>
          <div className="stats">
            {data.customers && (
              <Stat
                href="/customers"
                icon={icons.customers}
                label={t('customers')}
                value={data.customers.total}
              />
            )}
            {data.rates && (
              <Stat
                href="/rates"
                icon={icons.rates}
                label={t('approvedRates')}
                value={data.rates.approved}
                hint={t('draftCount', { count: data.rates.draft })}
              />
            )}
            {data.quotations && (
              <Stat
                href="/quotations"
                icon={icons.quotations}
                label={t('openQuotations')}
                value={data.quotations.draft + data.quotations.sent}
                hint={t('approvedAwaiting', { count: data.quotations.approved })}
              />
            )}
            {data.bookings && (
              <Stat
                href="/bookings"
                icon={icons.bookings}
                label={t('confirmedBookings')}
                value={data.bookings.confirmed}
                hint={t('draftCount', { count: data.bookings.draft })}
              />
            )}
          </div>

          {(data.warehouse || data.customs || data.trips || data.drafts || data.alerts) && (
            <div className="stats" role="group" aria-label={t('myWork')}>
              {data.drafts && (
                <Stat
                  href="/drafts"
                  icon={icons.assistant}
                  label={t('draftsAwaitingReview')}
                  value={data.drafts.awaitingReview}
                />
              )}
              {data.alerts && (
                <Stat
                  href="/alerts"
                  icon={icons.bell}
                  label={t('alerts')}
                  value={data.alerts.total}
                  hint={data.alerts.byKind
                    .filter((a) => a.count > 0)
                    .map((a) => `${tAlerts(`kind_${a.kind}`)}: ${a.count}`)
                    .join(' · ')}
                />
              )}
              {data.warehouse && (
                <Stat
                  href="/warehouses"
                  icon={icons.warehouse}
                  label={t('warehouseShipments')}
                  value={data.warehouse.shipments}
                  hint={t('warehouseToday', {
                    received: data.warehouse.receivedToday,
                    released: data.warehouse.releasedToday,
                  })}
                />
              )}
              {data.customs && (
                <Stat
                  href={
                    can(me, 'operational_reports:view')
                      ? '/operational-reports/customs-files'
                      : undefined
                  }
                  icon={icons.report}
                  label={t('openCustomsFiles')}
                  value={data.customs.open}
                  hint={data.customs.byStatus
                    .map((c) => `${te(`customs_${c.status}`)}: ${c.count}`)
                    .join(' · ')}
                />
              )}
              {data.trips && (
                <Stat
                  href="/trips"
                  icon={data.trips.ownOnly ? icons.driver : icons.truck}
                  label={data.trips.ownOnly ? t('myTripsOnTheRoad') : t('tripsOnTheRoad')}
                  value={data.trips.onTheRoad}
                  hint={t('plannedTrips', { count: data.trips.planned })}
                />
              )}
            </div>
          )}

          <div className="panels">
            {data.quotations && (
              <div className="panel">
                <div className="panel-head">
                  <h2>{t('recentQuotations')}</h2>
                  <Link href="/quotations">{t('viewAll')}</Link>
                </div>
                {data.quotations.recent.length === 0 ? (
                  <p className="empty">{t('noQuotations')}</p>
                ) : (
                  <ul className="recent">
                    {data.quotations.recent.map((x) => (
                      <li key={x.id}>
                        <Link href={`/quotations/${x.id}`} className="recent-item">
                          <span className="recent-main">
                            <span className="recent-number" dir="ltr">
                              {x.number}
                            </span>
                            <span className="recent-sub">{x.customerName}</span>
                          </span>
                          <span className="recent-side">
                            <span className="money" dir="ltr">
                              {formatAmount(x.total)} {x.currency}
                            </span>
                            <StatusBadge kind="quotation" status={x.status} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {data.bookings && (
              <div className="panel">
                <div className="panel-head">
                  <h2>{t('recentBookings')}</h2>
                  <Link href="/bookings">{t('viewAll')}</Link>
                </div>
                {data.bookings.recent.length === 0 ? (
                  <p className="empty">{t('noBookings')}</p>
                ) : (
                  <ul className="recent">
                    {data.bookings.recent.map((b) => (
                      <li key={b.id}>
                        <Link href={`/bookings/${b.id}`} className="recent-item">
                          <span className="recent-main">
                            <span className="recent-number" dir="ltr">
                              {b.number}
                            </span>
                            <span className="recent-sub">
                              {b.customerName} ·{' '}
                              {tc('route', {
                                from: locationName(b.originLocationId),
                                to: locationName(b.destinationLocationId),
                              })}
                            </span>
                          </span>
                          <span className="recent-side">
                            <StatusBadge kind="booking" status={b.status} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
