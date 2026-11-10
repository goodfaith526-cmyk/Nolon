'use client';

import type { ReferrerPortalDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { formatAmount } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

/**
 * Plan 18, 8: the referral broker's own screen. His customer link, adding a customer by name and
 * phone, the customers he registered, and his commissions and statements. The API decides all.
 */
export function ReferrerPortal() {
  const t = useTranslations('ReferrerPortal');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [data, setData] = useState<ReferrerPortalDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ReferrerPortalDto>('/referrer-portal').then(setData, (e: unknown) =>
      setNotice({ ok: false, text: failure(e) }),
    );
  }, [failure]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setNotice(null);
    try {
      setData(
        await api<ReferrerPortalDto>('/referrer-portal/customers', {
          method: 'POST',
          body: { name: field(form, 'name').trim(), phone: field(form, 'phone').trim() },
        }),
      );
      formEl.reset();
      setNotice({ ok: true, text: t('added') });
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>;
  }
  if (!data.broker) return <p className="muted">{t('noBroker')}</p>;
  const date = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <section className="stack">
      <h1>{t('title', { name: data.broker.name })}</h1>
      <div className="card stack">
        <p>{t('linkHint')}</p>
        <code dir="ltr" className="pre">
          {data.broker.customerLink ?? data.broker.referralCode ?? '—'}
        </code>
      </div>

      <form className="card stack" autoComplete="off" onSubmit={(e) => void add(e)}>
        <h2>{t('addTitle')}</h2>
        <div className="grid">
          <label className="field">
            <span>{t('name')}</span>
            <input name="name" required minLength={2} maxLength={200} />
          </label>
          <label className="field">
            <span>{t('phone')}</span>
            <input name="phone" required dir="ltr" placeholder="+249..." inputMode="tel" />
          </label>
        </div>
        <Notice notice={notice} />
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {t('add')}
          </button>
        </div>
      </form>

      <h2>{t('customers')}</h2>
      {data.customers.length === 0 ? (
        <p className="muted">{t('noCustomers')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('phoneEnd')}</th>
              <th>{t('registered')}</th>
              <th>{t('shipments')}</th>
            </tr>
          </thead>
          <tbody>
            {data.customers.map((c, i) => (
              <tr key={i}>
                <td>{c.name}</td>
                <td dir="ltr">{c.phoneEnd ? `…${c.phoneEnd}` : '—'}</td>
                <td>{date(c.referredAt)}</td>
                <td>{c.shipments}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{t('commissions')}</h2>
      {data.pending.length > 0 && (
        <p>
          {t('pending')}{' '}
          {data.pending.map((p) => (
            <span key={p.currency} dir="ltr">
              {formatAmount(p.amount)} {p.currency}{' '}
            </span>
          ))}
        </p>
      )}
      {data.commissions.length === 0 ? (
        <p className="muted">{t('noCommissions')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('date')}</th>
              <th>{t('customer')}</th>
              <th>{t('reason')}</th>
              <th>{t('amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.commissions.map((c, i) => (
              <tr key={i}>
                <td>{date(c.date)}</td>
                <td>{c.customerName}</td>
                <td>{c.reason ? t(`reason_${c.reason}`) : '—'}</td>
                <td dir="ltr">
                  {formatAmount(c.amount)} {c.currency}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{t('statements')}</h2>
      {data.statements.length === 0 ? (
        <p className="muted">{t('noStatements')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('statement')}</th>
              <th>{t('periodTo')}</th>
              <th>{t('amount')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {data.statements.map((s) => (
              <tr key={s.number}>
                <td dir="ltr">{s.number}</td>
                <td>{s.periodTo}</td>
                <td dir="ltr">
                  {formatAmount(s.total)} {s.currency}
                </td>
                <td>{t(`status_${s.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
