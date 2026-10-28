'use client';

import {
  CS_REVIEW_FILTERS,
  type CsBookingRequestSummaryDto,
  type CsRejectReasonDto,
  type CsReviewFilter,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';

/** The shipping bot's booking requests for the staff member's branches (plan 04a section 3). */
export function BotRequests() {
  const t = useTranslations('BotRequests');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const failure = useFailureText();
  const master = useMasterData();
  const localName = useLocalName();
  const locationName = useLocationName(master);
  const [state, setState] = useState<CsReviewFilter>('open');
  const [rows, setRows] = useState<CsBookingRequestSummaryDto[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<CsBookingRequestSummaryDto[]>(`/cs-booking-requests?state=${state}`)
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

  const place = (id: string | null) => (id ? locationName(id) : t('unmatched'));
  const branch = (id: string | null) => {
    const b = id ? me.branches.find((x) => x.id === id) : undefined;
    return b ? localName(b) : t('noBranch');
  };

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
            setState(e.target.value as CsReviewFilter);
          }}
        >
          {CS_REVIEW_FILTERS.map((s) => (
            <option key={s} value={s}>
              {t(`filter_${s}`)}
            </option>
          ))}
        </select>
      </div>
      {rows === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('reference')}</th>
                <th>{t('createdAt')}</th>
                <th>{t('route')}</th>
                <th>{t('category')}</th>
                <th>{t('quantity')}</th>
                <th>{t('sender')}</th>
                <th>{t('branch')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td dir="ltr">
                    <Link href={`/cs-booking-requests/${r.id}`}>{r.reference}</Link>
                  </td>
                  <td>{new Date(r.createdAt).toLocaleString(locale)}</td>
                  <td>{t('routeOf', { from: place(r.originId), to: place(r.destinationId) })}</td>
                  <td dir="ltr">{r.category ?? t('unmatched')}</td>
                  <td dir="ltr">{r.quantity}</td>
                  <td>
                    {r.senderName}
                    {r.channel && <span className="muted"> · {t(`channel_${r.channel}`)}</span>}
                  </td>
                  <td>{branch(r.branchId)}</td>
                  <td>
                    <span className={`badge badge-${r.status.toUpperCase()}`}>
                      {t(`state_${r.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RejectReasons editable={can(me, 'master_data:update')} />
    </section>
  );
}

/** The reasons staff reject a request for, as the customer reads them; the Administrator edits. */
function RejectReasons({ editable }: { editable: boolean }) {
  const t = useTranslations('BotRequests');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [reasons, setReasons] = useState<CsRejectReasonDto[] | null>(null);
  const [editing, setEditing] = useState<CsRejectReasonDto | 'new' | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<CsRejectReasonDto[]>('/cs-booking-requests/reject-reasons')
      .then(setReasons)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);
  useEffect(load, [load]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const code = editing === 'new' ? field(form, 'code').trim().toUpperCase() : editing?.code;
    if (!code) return;
    setBusy(true);
    setNotice(null);
    try {
      await api<CsRejectReasonDto>(`/cs-reject-reasons/${encodeURIComponent(code)}`, {
        method: 'PUT',
        body: {
          textAr: field(form, 'textAr').trim(),
          textEn: field(form, 'textEn').trim(),
          isActive: form.get('isActive') === 'on',
        },
      });
      setEditing(null);
      setNotice({ ok: true, text: tc('saved') });
      load();
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div className="row">
        <h2>{t('reasons')}</h2>
        {editable && editing === null && (
          <button type="button" onClick={() => setEditing('new')}>
            {t('addReason')}
          </button>
        )}
      </div>
      <p className="muted">{t('reasonsHint')}</p>
      <Notice notice={notice} />
      {editing !== null && (
        <form className="stack" autoComplete="off" onSubmit={(e) => void save(e)}>
          <div className="grid">
            {editing === 'new' && (
              <label className="field">
                {t('reasonCode')}
                <input name="code" required pattern="[A-Za-z][A-Za-z0-9_]{1,19}" dir="ltr" />
              </label>
            )}
            <label className="field">
              {t('textAr')}
              <input
                name="textAr"
                required
                maxLength={300}
                dir="rtl"
                defaultValue={editing === 'new' ? '' : editing.textAr}
              />
            </label>
            <label className="field">
              {t('textEn')}
              <input
                name="textEn"
                required
                maxLength={300}
                dir="ltr"
                defaultValue={editing === 'new' ? '' : editing.textEn}
              />
            </label>
            <div className="checks">
              <label>
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing === 'new' ? true : editing.isActive}
                />
                {tc('active')}
              </label>
            </div>
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      {reasons === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('reasonCode')}</th>
                <th>{t('textAr')}</th>
                <th>{t('textEn')}</th>
                <th>{tc('status')}</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {reasons.map((r) => (
                <tr key={r.code} className={r.isActive ? '' : 'inactive'}>
                  <td dir="ltr">{r.code}</td>
                  <td dir="rtl">{r.textAr}</td>
                  <td dir="ltr">{r.textEn}</td>
                  <td>{r.isActive ? tc('active') : tc('inactive')}</td>
                  {editable && (
                    <td>
                      <button type="button" onClick={() => setEditing(r)}>
                        {tc('edit')}
                      </button>
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
