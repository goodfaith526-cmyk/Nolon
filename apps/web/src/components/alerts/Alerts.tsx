'use client';

import type { AlertDto, AlertKind, AlertsDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { icons } from '../Icons';
import { can, useMe } from '../StaffShell';

/** The page an alert opens: the shipment, the invoice or the trip it is about. */
export function alertHref(alert: AlertDto): string {
  switch (alert.kind) {
    case 'INVOICE_OVERDUE':
      return `/invoices/${alert.refId}`;
    case 'TRIP_LATE':
      return `/trips/${alert.refId}`;
    default:
      return `/shipments/${alert.refId}`;
  }
}

/** The user's alerts, loaded again on every page change (they are worked out when asked). */
function useAlerts(): { alerts: AlertsDto | null; notice: NoticeState | null } {
  const pathname = usePathname();
  const failure = useFailureText();
  const [alerts, setAlerts] = useState<AlertsDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<AlertsDto>('/alerts')
      .then((data) => {
        if (!cancelled) setAlerts(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, failure]);
  return { alerts, notice };
}

/** The bell in the top bar, with how many alerts wait for the user. */
export function AlertsBell() {
  const t = useTranslations('Alerts');
  const { alerts } = useAlerts();
  const total = alerts?.total ?? 0;
  return (
    <Link
      href="/alerts"
      className="button ghost alerts-bell"
      aria-label={total > 0 ? t('bellCount', { count: total }) : t('title')}
    >
      {icons.bell}
      {total > 0 && <b className="alert-count">{total > 99 ? '99+' : total}</b>}
    </Link>
  );
}

/** All the user's alerts, by kind, longest waiting first. */
export function Alerts() {
  const t = useTranslations('Alerts');
  const tc = useTranslations('Common');
  const me = useMe();
  const { alerts, notice } = useAlerts();

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
        {can(me, 'alert_settings:view') && (
          <Link href="/alerts/settings" className="button">
            {t('settings')}
          </Link>
        )}
      </div>
      <Notice notice={notice} />
      {alerts === null ? (
        !notice && <p className="muted">{tc('loading')}</p>
      ) : alerts.groups.length === 0 ? (
        <p className="empty">{t('noneForRole')}</p>
      ) : (
        alerts.groups.map((g) => (
          <div key={g.kind} className="panel">
            <div className="panel-head">
              <div>
                <h2>
                  {t(`kind_${g.kind}`)} <span className="badge">{g.count}</span>
                </h2>
                <p className="muted">{t(`rule_${g.kind}`, { days: g.thresholdDays })}</p>
              </div>
            </div>
            {g.items.length === 0 ? (
              <p className="empty">{t('none')}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('number')}</th>
                      <th>{t(`detail_${g.kind}`)}</th>
                      <th>{t(`since_${g.kind}`)}</th>
                      <th>{t('days')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((a) => (
                      <tr key={`${a.refId}-${a.detail ?? ''}`}>
                        <td dir="ltr">
                          <Link href={alertHref(a)}>{a.number}</Link>
                          <div className="muted">{a.branchCode}</div>
                        </td>
                        <td>
                          <DetailText kind={g.kind} detail={a.detail} />
                        </td>
                        <td dir="ltr">{a.since}</td>
                        <td>{t('daysN', { count: a.days })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {g.count > g.items.length && (
              <p className="panel-body muted">
                {t('more', { shown: g.items.length, count: g.count })}
              </p>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function DetailText({ kind, detail }: { kind: AlertKind; detail: string | null }) {
  const te = useTranslations('Enums');
  if (detail === null) return <>—</>;
  if (kind === 'CUSTOMS_STALLED') return <>{te(`customs_${detail}`)}</>;
  if (kind === 'STORAGE_EXCEEDED') return <bdi dir="ltr">{detail}</bdi>;
  return <>{detail}</>;
}

/** The dashboard's line of alerts: how many of each wait, linking to the list. */
export function AlertsSummary() {
  const t = useTranslations('Alerts');
  const { alerts } = useAlerts();
  if (alerts === null) return null;
  if (alerts.total === 0) return <p className="muted">{t('allClear')}</p>;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('title')}</h2>
        <Link href="/alerts" className="button">
          {t('open')}
        </Link>
      </div>
      <ul className="plain panel-body">
        {alerts.groups
          .filter((g) => g.count > 0)
          .map((g) => (
            <li key={g.kind}>
              {t(`kind_${g.kind}`)}: <strong>{g.count}</strong>
            </li>
          ))}
      </ul>
    </div>
  );
}
