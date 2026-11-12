'use client';

import type { CsHandoffRequestDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';

type Filter = 'open' | 'all';

/** «طلبات التواصل»: customers who asked the bot for a person, in the staff member's branches. */
export function HandoffRequests() {
  const t = useTranslations('HandoffRequests');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const localName = useLocalName();
  const failure = useFailureText();
  const [state, setState] = useState<Filter>('open');
  const [rows, setRows] = useState<CsHandoffRequestDto[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mayMark = can(me, 'cs_booking_requests:update');

  useEffect(() => {
    let cancelled = false;
    api<CsHandoffRequestDto[]>(`/cs-handoff-requests?state=${state}`)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [state, failure]);

  const branch = (id: string | null) => {
    if (id === null) return t('allBranches');
    const b = me.branches.find((x) => x.id === id);
    return b ? localName(b) : '—';
  };

  async function markContacted(id: string) {
    setBusy(id);
    try {
      const done = await api<CsHandoffRequestDto>(`/cs-handoff-requests/${id}/contacted`, {
        method: 'POST',
      });
      setRows((current) =>
        (current ?? [])
          .map((r) => (r.id === id ? done : r))
          .filter((r) => state === 'all' || r.status === 'open'),
      );
      setNotice({ ok: true, text: t('done') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <Notice notice={notice} />
      <div className="row">
        <select
          value={state}
          aria-label={tc('status')}
          onChange={(e) => {
            setRows(null);
            setState(e.target.value as Filter);
          }}
        >
          <option value="open">{t('open')}</option>
          <option value="all">{t('all')}</option>
        </select>
      </div>
      {rows === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : rows.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('time')}</th>
                <th>{t('customer')}</th>
                <th>{t('phone')}</th>
                <th>{t('reason')}</th>
                <th>{t('channel')}</th>
                <th>{t('branch')}</th>
                <th>{t('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td dir="ltr">{r.number}</td>
                  <td>{new Date(r.createdAt).toLocaleString(locale)}</td>
                  <td>{r.customerName ?? '—'}</td>
                  <td>{r.customerPhone ? <bdi dir="ltr">{r.customerPhone}</bdi> : '—'}</td>
                  <td>
                    {r.reason}
                    {r.bookingRequestRef && (
                      <span className="muted">
                        {' '}
                        · {t('bookingRequest')}: <bdi dir="ltr">{r.bookingRequestRef}</bdi>
                      </span>
                    )}
                  </td>
                  <td>
                    {t(`channel_${r.channel}`)}
                    {r.channel !== 'web' && (
                      <span className="muted">
                        {' '}
                        · <bdi dir="ltr">{r.senderId}</bdi>
                      </span>
                    )}
                  </td>
                  <td>
                    {branch(r.branchId)}
                    {r.branchHint && <span className="muted"> · {r.branchHint}</span>}
                  </td>
                  <td>
                    {t(`status_${r.status}`)}
                    {r.contactedByName && (
                      <span className="muted">
                        {' '}
                        · {t('contactedBy', { name: r.contactedByName })}
                      </span>
                    )}
                  </td>
                  <td>
                    {mayMark && r.status === 'open' && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void markContacted(r.id)}
                      >
                        {t('contacted')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
