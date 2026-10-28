'use client';

import {
  COMMISSION_BASES,
  RATE_UNITS,
  type CommissionBasis,
  type PartnerContractDto,
  type PartnerContractInput,
  type PartnerDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

/**
 * A partner's commission contracts (business model plan 3.4): settings only. They show the
 * expected commission inside a rate card's expected margin; nothing accrues, posts or settles.
 * The API decides who may see, add, approve or cancel them.
 */
export function PartnerContracts({ partner }: { partner: PartnerDto }) {
  const t = useTranslations('PartnerContracts');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const name = useLocalName();
  const failure = useFailureText();
  const [contracts, setContracts] = useState<PartnerContractDto[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [basis, setBasis] = useState<CommissionBasis>('PERCENT_OF_PRICE');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<PartnerContractDto[]>(`/partners/${partner.id}/contracts`)
      .then(setContracts)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [partner.id, failure]);

  useEffect(load, [load]);

  const categoryName = (code: string | null) => {
    if (!code) return t('everyCategory');
    const category = master?.priceCategories.find((c) => c.code === code);
    return category ? name(category) : code;
  };

  async function run(path: string, body: unknown, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      await api(path, { method: 'POST', body });
      setNotice({ ok: true, text: success });
      setAdding(false);
      load();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fixed = basis === 'FIXED_PER_UNIT';
    const body: PartnerContractInput = {
      priceCategoryCode: field(form, 'priceCategoryCode') || null,
      basis,
      value: field(form, 'value'),
      unit: fixed ? (field(form, 'unit') as PartnerContractInput['unit']) : null,
      currency: fixed ? field(form, 'currency') : null,
      validFrom: field(form, 'validFrom'),
      validTo: field(form, 'validTo') || null,
      notes: field(form, 'notes') || null,
    };
    void run(`/partners/${partner.id}/contracts`, body, t('created'));
  }

  return (
    <section className="stack">
      <div className="row">
        <h2>{t('title')}</h2>
        {!adding && can(me, 'partner_contracts:create') && (
          <button type="button" onClick={() => setAdding(true)}>
            {t('add')}
          </button>
        )}
      </div>
      <p className="muted">{t('settingsOnly')}</p>
      <Notice notice={notice} />
      {adding && (
        <form className="card stack" autoComplete="off" onSubmit={add}>
          <div className="grid">
            <label className="field">
              {t('category')}
              <select name="priceCategoryCode" defaultValue="">
                <option value="">{t('everyCategory')}</option>
                {master?.priceCategories
                  .filter((c) => c.isActive)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {name(c)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              {t('basis')}
              <select
                name="basis"
                value={basis}
                onChange={(e) => setBasis(e.target.value as CommissionBasis)}
              >
                {COMMISSION_BASES.map((b) => (
                  <option key={b} value={b}>
                    {t(`basis_${b}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {basis === 'PERCENT_OF_PRICE' ? t('percent') : t('amount')}
              <input name="value" required inputMode="decimal" dir="ltr" />
            </label>
            {basis === 'FIXED_PER_UNIT' && (
              <>
                <label className="field">
                  {t('unit')}
                  <select name="unit" required defaultValue="">
                    <option value="" disabled>
                      {t('chooseUnit')}
                    </option>
                    {RATE_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {te(`unit_${u}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  {t('currency')}
                  <select name="currency" required defaultValue={partner.currency}>
                    {master?.currencies
                      .filter((c) => c.isActive)
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            <label className="field">
              {t('validFrom')}
              <input name="validFrom" type="date" required />
            </label>
            <label className="field">
              {t('validTo')}
              <input name="validTo" type="date" />
            </label>
          </div>
          <label className="field">
            {tc('notes')}
            <textarea name="notes" maxLength={2000} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      {contracts === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : contracts.length === 0 ? (
        <p className="muted">{t('none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('category')}</th>
                <th>{t('commission')}</th>
                <th>{t('validity')}</th>
                <th>{tc('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id} className={c.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td>{categoryName(c.priceCategoryCode)}</td>
                  <td dir="ltr">
                    {c.basis === 'PERCENT_OF_PRICE' ? (
                      `${c.value}%`
                    ) : (
                      <>
                        <Money value={c.value} currency={c.currency ?? undefined} />
                        {c.unit ? ` / ${te(`unit_${c.unit}`)}` : ''}
                      </>
                    )}
                  </td>
                  <td dir="ltr">
                    {c.validFrom} → {c.validTo ?? '∞'}
                  </td>
                  <td>
                    <StatusBadge kind="rate" status={c.status} />
                  </td>
                  <td>
                    <div className="actions">
                      {c.actions.canApprove && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(`/partner-contracts/${c.id}/approve`, undefined, t('approved'))
                          }
                        >
                          {t('approve')}
                        </button>
                      )}
                      {c.actions.canCancel && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(`/partner-contracts/${c.id}/cancel`, undefined, t('cancelled'))
                          }
                        >
                          {t('cancel')}
                        </button>
                      )}
                    </div>
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
