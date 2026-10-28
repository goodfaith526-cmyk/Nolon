'use client';

import type { AlertKind, DashboardDto, Permission } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/money';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { icons } from './Icons';
import { MoreMenu } from './MoreMenu';
import { can, useMe } from './StaffShell';
import { StatusBadge } from './StatusBadge';

/**
 * The sections the home page opens in one tap, most used first. Each shows only to a user who may
 * view it (the API enforces the permission on its own).
 */
const SHORTCUTS: readonly {
  href: string;
  label: string;
  icon: keyof typeof icons;
  permission: Permission;
}[] = [
  { href: '/shipments', label: 'shipments', icon: 'ship', permission: 'shipments:view' },
  { href: '/bookings', label: 'bookings', icon: 'bookings', permission: 'bookings:view' },
  { href: '/quotations', label: 'quotations', icon: 'quotations', permission: 'quotations:view' },
  { href: '/customers', label: 'customers', icon: 'customers', permission: 'customers:view' },
  { href: '/trips', label: 'trips', icon: 'truck', permission: 'transport_trips:view' },
  { href: '/warehouses', label: 'warehouses', icon: 'warehouse', permission: 'warehouse:view' },
  {
    href: '/invoices',
    label: 'invoices',
    icon: 'invoice',
    permission: 'customer_invoices:view',
  },
  { href: '/receipts', label: 'receipts', icon: 'receipt', permission: 'receipts:view' },
  { href: '/rates', label: 'rates', icon: 'rates', permission: 'rates:view' },
  {
    href: '/operational-reports',
    label: 'operationalReports',
    icon: 'report',
    permission: 'operational_reports:view',
  },
];

/** Something waiting for the user: how urgent it is, what it is, how many, and where to act. */
interface ActionItem {
  key: string;
  tone: 'bad' | 'warn' | 'info';
  label: string;
  count: number;
  href: string;
}

/** How pressing each alert is: overdue money and late goods first, arrivals ahead last. */
const ALERT_TONE: Record<AlertKind, ActionItem['tone']> = {
  INVOICE_OVERDUE: 'bad',
  SHIPMENT_PAST_ETA: 'bad',
  TRIP_LATE: 'bad',
  CUSTOMS_STALLED: 'warn',
  STORAGE_EXCEEDED: 'warn',
  SHIPMENT_ARRIVING_SOON: 'info',
};
const TONE_ORDER: Record<ActionItem['tone'], number> = { bad: 0, warn: 1, info: 2 };

export function Dashboard() {
  const t = useTranslations('Dashboard');
  const tc = useTranslations('Common');
  const tShell = useTranslations('Shell');
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

  const shortcuts = SHORTCUTS.filter((l) => can(me, l.permission));

  const today = new Intl.DateTimeFormat(`${locale}-u-nu-latn`, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
  const scope = me.allBranches
    ? t('allBranches')
    : list.format(me.branches.map((b) => (locale === 'ar' ? b.nameAr : b.nameEn)));

  // What waits for the user, most pressing first. A source the API sent as null is one the user
  // has no permission for; a source with nothing waiting adds no row.
  const actions: ActionItem[] = [];
  const hasActionSource =
    !!data && !!(data.alerts || data.drafts || data.quotations || data.bookings || data.rates);
  if (data) {
    for (const a of data.alerts?.byKind ?? []) {
      actions.push({
        key: a.kind,
        tone: ALERT_TONE[a.kind],
        label: tAlerts(`kind_${a.kind}`),
        count: a.count,
        href: '/alerts',
      });
    }
    actions.push(
      {
        key: 'drafts',
        tone: 'warn',
        label: t('draftsAwaitingReview'),
        count: data.drafts?.awaitingReview ?? 0,
        href: '/drafts',
      },
      {
        key: 'quotations',
        tone: 'info',
        label: t('approvedToBook'),
        count: data.quotations?.approved ?? 0,
        href: '/quotations',
      },
      {
        key: 'bookings',
        tone: 'info',
        label: t('draftBookings'),
        count: data.bookings?.draft ?? 0,
        href: '/bookings',
      },
      {
        key: 'rates',
        tone: 'info',
        label: t('draftRates'),
        count: data.rates?.draft ?? 0,
        href: '/rates',
      },
    );
  }
  const waiting = actions
    .filter((a) => a.count > 0)
    .sort((x, y) => TONE_ORDER[x.tone] - TONE_ORDER[y.tone]);

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('welcome', { name: me.fullName })}</h1>
          <p className="muted">
            {today} · {scope}
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

      {shortcuts.length > 0 && (
        <nav className="launcher" aria-label={t('shortcuts')}>
          {shortcuts.map((l) => (
            <Link key={l.href} href={l.href} className="launcher-item">
              <span className="launcher-icon">{icons[l.icon]}</span>
              <span className="launcher-label">{tShell(l.label)}</span>
            </Link>
          ))}
        </nav>
      )}

      {failed && <p className="error">{t('loadFailed')}</p>}
      {!data && !failed && <p className="muted">{tc('loading')}</p>}

      {data && (
        <>
          <div className="home-grid">
            {hasActionSource && (
              <div className="panel attention">
                <div className="panel-head">
                  <h2>{t('needsAction')}</h2>
                </div>
                {waiting.length === 0 ? (
                  <p className="attention-clear">
                    <span className="attention-clear-icon">{icons.check}</span>
                    {t('allClear')}
                  </p>
                ) : (
                  <ul className="attention-list" aria-label={t('needsAction')}>
                    {waiting.map((a) => (
                      <li key={a.key}>
                        <Link href={a.href} className={`attention-item tone-${a.tone}`}>
                          <span className="attention-dot" aria-hidden="true" />
                          <span className="attention-label">{a.label}</span>
                          <span className="attention-count" dir="ltr">
                            {a.count}
                          </span>
                          <span className="attention-go" aria-hidden="true">
                            {icons.chevron}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="home-main">
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
          </div>
        </>
      )}
    </section>
  );
}
