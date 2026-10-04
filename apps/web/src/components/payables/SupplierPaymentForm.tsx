'use client';

import type {
  CreateSupplierPaymentRequest,
  Page,
  SupplierBillSummaryDto,
  SupplierPaymentDto,
  SupplierSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN, todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money, cashAccountsFor, useAccounts } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { BillNumber } from './SupplierBills';

/**
 * A payment to a supplier, allocated to its approved open bills of one branch and currency. The
 * amount is the sum of the allocations; the API checks every amount and the cash account.
 */
export function SupplierPaymentForm({ supplierId: initialSupplier }: { supplierId?: string }) {
  const t = useTranslations('SupplierPayments');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();
  const { accounts, status: accountsStatus } = useAccounts();
  const [suppliers, setSuppliers] = useState<SupplierSummaryDto[] | null>(null);
  const [supplierId, setSupplierId] = useState(initialSupplier ?? '');
  const [branchId, setBranchId] = useState(me.branches[0]?.id ?? '');
  const [currency, setCurrency] = useState('USD');
  const [cashAccountId, setCashAccountId] = useState('');
  const [bills, setBills] = useState<SupplierBillSummaryDto[] | null>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    api<Page<SupplierSummaryDto>>('/suppliers?pageSize=100')
      .then((page) => setSuppliers(page.items))
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    api<Page<SupplierBillSummaryDto>>(
      `/supplier-bills?supplierId=${supplierId}&openOnly=true&pageSize=100`,
    )
      .then((page) => {
        if (!cancelled) setBills(page.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId, failure]);

  if (!can(me, 'supplier_payments:create')) return <p className="error">{tc('noAccess')}</p>;
  if (!master) return <p className="muted">{tc('loading')}</p>;

  const cashAccounts = cashAccountsFor(accounts, branchId, currency);
  const selectedCash = cashAccounts.some((a) => a.id === cashAccountId) ? cashAccountId : '';
  const payable = (bills ?? []).filter((b) => b.branchId === branchId);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fxRate = field(form, 'fxRate').trim();
    const body: CreateSupplierPaymentRequest = {
      requestId,
      supplierId,
      branchId,
      paymentDate: field(form, 'paymentDate'),
      currency,
      fxRate: currency === 'USD' || fxRate === '' ? null : fxRate,
      cashAccountId: selectedCash,
      reference: field(form, 'reference').trim() || null,
      notes: field(form, 'notes').trim() || null,
      allocations: payable
        .filter((b) => b.currency === currency && (allocations[b.id] ?? '').trim() !== '')
        .map((b) => ({ billId: b.id, amount: (allocations[b.id] ?? '').trim() })),
    };
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<SupplierPaymentDto>('/supplier-payments', { method: 'POST', body });
      router.push(`/supplier-payments/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <h1>{t('add')}</h1>
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          {t('supplier')}
          <select
            value={supplierId}
            required
            onChange={(e) => {
              setSupplierId(e.target.value);
              setBills(null);
              setAllocations({});
            }}
          >
            <option value="">{t('chooseSupplier')}</option>
            {(suppliers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('branch')}
          <select value={branchId} required onChange={(e) => setBranchId(e.target.value)}>
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('paymentDate')}
          <input name="paymentDate" type="date" required defaultValue={todayString()} />
        </label>
        <label className="field">
          {t('currency')}
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {master.currencies
              .filter((c) => c.isActive)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {name(c)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('fxRateOptional')}
          <input
            name="fxRate"
            inputMode="decimal"
            dir="ltr"
            pattern={FX_RATE_PATTERN}
            disabled={currency === 'USD'}
          />
        </label>
        <label className="field">
          {t('cashAccount')}
          <select
            value={selectedCash}
            required
            disabled={accounts === null}
            onChange={(e) => setCashAccountId(e.target.value)}
          >
            <option value="">{t('chooseCashAccount')}</option>
            {cashAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {name(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('reference')}
          <input name="reference" maxLength={100} dir="ltr" />
        </label>
      </div>
      <p className="muted">{t('fxRateHint', { currency })}</p>
      {accountsStatus === 403 && <p className="error">{t('cashAccountsNoAccess')}</p>}

      <fieldset className="stack">
        <legend>{t('allocations')}</legend>
        <p className="muted">{t('allocationsHint')}</p>
        {!supplierId ? (
          <p className="muted">{t('pickSupplierFirst')}</p>
        ) : bills === null ? (
          <p className="muted">{tc('loading')}</p>
        ) : payable.length === 0 ? (
          <p className="muted">{t('noOpenBills')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('bill')}</th>
                  <th>{t('dueDate')}</th>
                  <th>{t('billTotal')}</th>
                  <th>{t('billBalance')}</th>
                  <th>{t('allocate', { currency })}</th>
                </tr>
              </thead>
              <tbody>
                {payable.map((b) => {
                  const sameCurrency = b.currency === currency;
                  return (
                    <tr key={b.id} className={sameCurrency ? '' : 'inactive'}>
                      <td className="nowrap">
                        <Link href={`/supplier-bills/${b.id}`}>
                          <BillNumber number={b.number} />
                        </Link>
                        <div className="muted" dir="ltr">
                          {b.supplierReference}
                        </div>
                      </td>
                      <td dir="ltr">{b.dueDate}</td>
                      <td dir="ltr">
                        <Money value={b.total} currency={b.currency} />
                      </td>
                      <td dir="ltr">
                        <Money value={b.balance} currency={b.currency} />
                      </td>
                      <td>
                        {sameCurrency ? (
                          <input
                            className="amount-input"
                            inputMode="decimal"
                            dir="ltr"
                            pattern={AMOUNT_PATTERN}
                            aria-label={t('allocate', { currency })}
                            value={allocations[b.id] ?? ''}
                            onChange={(e) =>
                              setAllocations((all) => ({ ...all, [b.id]: e.target.value }))
                            }
                          />
                        ) : (
                          <span className="muted">
                            {t('otherCurrency', { currency: b.currency })}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>

      <label className="field">
        {tc('notes')}
        <textarea name="notes" maxLength={2000} />
      </label>
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={busy || supplierId === '' || selectedCash === ''}
        >
          {t('save')}
        </button>
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
