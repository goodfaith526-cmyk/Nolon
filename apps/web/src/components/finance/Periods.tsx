'use client';

import type { FiscalPeriodDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { useRecord } from './common';

/** Fiscal periods by month. Closing one stops postings dated in it, and cannot be undone. */
export function Periods() {
  const t = useTranslations('Periods');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const failure = useFailureText();
  const { record: loaded, notice: loadNotice } =
    useRecord<FiscalPeriodDto[]>('/accounting/periods');
  const [periods, setPeriods] = useState<FiscalPeriodDto[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!can(me, 'chart_of_accounts:view')) return <p className="error">{tc('noAccess')}</p>;
  const list = periods ?? loaded;

  async function close(id: string) {
    setBusy(true);
    setNotice(null);
    try {
      const closed = await api<FiscalPeriodDto>(`/accounting/periods/${id}/close`, {
        method: 'POST',
      });
      setPeriods((list ?? []).map((p) => (p.id === closed.id ? closed : p)));
      setConfirming(null);
      setNotice({ ok: true, text: t('closedNotice') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const month = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const canClose = can(me, 'chart_of_accounts:approve');
  const sorted = [...(list ?? [])].sort((a, b) => b.year - a.year || b.month - a.month);

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
      </div>
      <p className="muted">{t('hint')}</p>
      <Notice notice={notice ?? loadNotice} />
      {list === null ? (
        !loadNotice && <p className="muted">{tc('loading')}</p>
      ) : list.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('period')}</th>
                <th>{t('dates')}</th>
                <th>{tc('status')}</th>
                <th>{t('closedAt')}</th>
                {canClose && <th />}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.id}>
                  <td>
                    {month.format(new Date(Date.UTC(p.year, p.month - 1, 1)))}{' '}
                    <span className="muted" dir="ltr">
                      ({p.year}-{String(p.month).padStart(2, '0')})
                    </span>
                  </td>
                  <td dir="ltr">
                    {p.startDate} → {p.endDate}
                  </td>
                  <td>
                    <StatusBadge kind="period" status={p.status} />
                  </td>
                  <td>{p.closedAt ? <bdi>{dateTime.format(new Date(p.closedAt))}</bdi> : '—'}</td>
                  {canClose && (
                    <td>
                      {p.status === 'OPEN' &&
                        (confirming === p.id ? (
                          <span className="actions">
                            <button
                              type="button"
                              className="primary"
                              disabled={busy}
                              onClick={() => void close(p.id)}
                            >
                              {t('confirmClose')}
                            </button>
                            <button type="button" onClick={() => setConfirming(null)}>
                              {tc('back')}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setNotice({ ok: false, text: t('closeWarning') });
                              setConfirming(p.id);
                            }}
                          >
                            {t('close')}
                          </button>
                        ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
