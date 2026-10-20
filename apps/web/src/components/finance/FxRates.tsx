'use client';

import type { FxRateDto, FxRateInput } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { commonToday } from '@/lib/branches';
import { field } from '@/lib/form';
import { useMasterData } from '@/lib/master-data';
import { FX_RATE_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';

/** Exchange rates: units of a currency per 1 USD, one per currency and day. */
export function FxRates() {
  const t = useTranslations('FxRates');
  const tc = useTranslations('Common');
  const me = useMe();
  const master = useMasterData();
  const failure = useFailureText();
  const [query, setQuery] = useState('');
  const [rates, setRates] = useState<FxRateDto[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [currencyChoice, setCurrency] = useState<string | null>(null);
  const [dateChoice, setDate] = useState<string | null>(null);

  const load = useCallback(() => {
    api<FxRateDto[]>(`/accounting/fx-rates${query}`)
      .then(setRates)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [query, failure]);

  useEffect(load, [load]);

  if (!can(me, 'fx_rates:view')) return <p className="error">{tc('noAccess')}</p>;

  function onFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const params = new URLSearchParams();
    for (const key of ['currency', 'from', 'to']) {
      const value = field(form, key);
      if (value) params.set(key, value);
    }
    const text = params.toString();
    setNotice(null);
    setQuery(text ? `?${text}` : '');
  }

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: FxRateInput = {
      currency,
      rateDate,
      rate: field(form, 'rate').trim(),
    };
    setBusy(true);
    setNotice(null);
    try {
      await api<FxRateDto>('/accounting/fx-rates', { method: 'PUT', body });
      setNotice({ ok: true, text: t('savedNotice') });
      load();
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  const currencies = (master?.currencies ?? []).filter((c) => c.code !== 'USD');
  const active = currencies.filter((c) => c.isActive);
  const currency = currencyChoice ?? active[0]?.code ?? '';
  // A rate belongs to no branch (functional review C9). Its date starts as today in the user's
  // branches that work in the currency (else all their branches) when they agree on the day, from
  // /auth/me, not the browser's clock; when they do not, the person types it. It follows the
  // currency until a date is typed (null until then), which is kept.
  const inCurrency = me.branches.filter((b) => b.defaultCurrency === currency);
  const rateDate = dateChoice ?? commonToday(inCurrency.length > 0 ? inCurrency : me.branches);

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
      </div>
      <p className="muted">{t('hint')}</p>
      <Notice notice={notice} />
      {can(me, 'fx_rates:create') && (
        <form className="card stack" onSubmit={(e) => void onSave(e)}>
          <h2>{t('add')}</h2>
          <div className="grid">
            <label className="field">
              {t('currency')}
              <select
                name="currency"
                required
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {active.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t('rateDate')}
              <input
                type="date"
                name="rateDate"
                required
                value={rateDate}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className="field">
              {t('rateLabel')}
              <input name="rate" required inputMode="decimal" dir="ltr" pattern={FX_RATE_PATTERN} />
            </label>
          </div>
          <p className="muted">{t('upsertHint')}</p>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
          </div>
        </form>
      )}
      <form className="row" onSubmit={onFilter}>
        <select name="currency" defaultValue="" aria-label={t('currency')}>
          <option value="">{t('allCurrencies')}</option>
          {currencies.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}
            </option>
          ))}
        </select>
        <label className="field inline">
          {t('from')}
          <input type="date" name="from" />
        </label>
        <label className="field inline">
          {t('to')}
          <input type="date" name="to" />
        </label>
        <button type="submit">{tc('search')}</button>
      </form>
      {rates === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : rates.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('rateDate')}</th>
                <th>{t('currency')}</th>
                <th>{t('rate')}</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td dir="ltr">{r.rateDate}</td>
                  <td dir="ltr">{r.currency}</td>
                  <td dir="ltr">{t('rateValue', { rate: r.rate, currency: r.currency })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
