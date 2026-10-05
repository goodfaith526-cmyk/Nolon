'use client';

import type {
  CreateReceiptRequest,
  CustomerInvoiceSummaryDto,
  CustomerSummaryDto,
  Page,
  ReceiptDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN, todayString } from '@/lib/money';
import { CustomerPicker } from '../commercial/CustomerPicker';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { InvoiceNumber } from './Invoices';
import { Money, useAccounts } from './common';

/** New receipt with its allocations to the customer's open invoices. The API checks the sums. */
export function ReceiptForm() {
  const t = useTranslations('Receipts');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();
  const { accounts, status: accountsStatus } = useAccounts();
  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [cashAccountId, setCashAccountId] = useState('');
  const [openInvoices, setOpenInvoices] = useState<CustomerInvoiceSummaryDto[] | null>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const customerId = customer?.id;
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    api<Page<CustomerInvoiceSummaryDto>>(
      `/customer-invoices?customerId=${customerId}&status=APPROVED&openOnly=true&pageSize=100`,
    )
      .then((page) => {
        if (!cancelled) setOpenInvoices(page.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, failure]);

  if (!can(me, 'receipts:create')) return <p className="error">{tc('noAccess')}</p>;

  // Dropdown narrowing only: the API checks the account again (cash, branch, currency).
  const cashAccounts = (accounts ?? []).filter(
    (a) =>
      a.isCash &&
      a.isActive &&
      a.isPostable &&
      a.currency === currency &&
      (a.branchId === null || a.branchId === customer?.branchId),
  );
  const selectedCash = cashAccounts.some((a) => a.id === cashAccountId) ? cashAccountId : '';

  function pickCustomer(c: CustomerSummaryDto | null) {
    setCustomer(c);
    setOpenInvoices(null);
    setAllocations({});
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!customer) return;
    const form = new FormData(e.currentTarget);
    const fxRate = field(form, 'fxRate').trim();
    const body: CreateReceiptRequest = {
      customerId: customer.id,
      receiptDate: field(form, 'receiptDate'),
      currency,
      fxRate: currency === 'USD' || fxRate === '' ? null : fxRate,
      amount: field(form, 'amount').trim(),
      cashAccountId: selectedCash,
      reference: field(form, 'reference').trim() || null,
      notes: field(form, 'notes').trim() || null,
      allocations: (openInvoices ?? [])
        .filter((i) => i.currency === currency && (allocations[i.id] ?? '').trim() !== '')
        .map((i) => ({ invoiceId: i.id, amount: (allocations[i.id] ?? '').trim() })),
    };
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<ReceiptDto>('/receipts', { method: 'POST', body });
      router.push(`/receipts/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;

  return (
    <form className="stack form-page" onSubmit={(e) => void submit(e)}>
      <h1>{t('add')}</h1>
      <Notice notice={notice} />
      <section className="form-section">
        <header>
          <h2>{t('customer')}</h2>
          <p>{t('sectionCustomerHint')}</p>
        </header>
        <div className="form-section-body">
          <CustomerPicker value={customer} onChange={pickCustomer} />
        </div>
      </section>
      <section className="form-section">
        <header>
          <h2>{t('sectionPayment')}</h2>
          <p>{t('fxRateHint', { currency })}</p>
        </header>
        <div className="form-section-body stack">
          <div className="form-grid">
            <label className="field">
              {t('receiptDate')}
              <input name="receiptDate" type="date" required defaultValue={todayString()} />
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
              {t('amount')}
              <input
                name="amount"
                required
                inputMode="decimal"
                dir="ltr"
                pattern={AMOUNT_PATTERN}
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
          {accountsStatus === 403 ? (
            <p className="error">{t('cashAccountsNoAccess')}</p>
          ) : accountsStatus !== null ? (
            <p className="error">{tc('failed')}</p>
          ) : (
            accounts !== null &&
            cashAccounts.length === 0 && (
              <p className="muted">{t('noCashAccounts', { currency })}</p>
            )
          )}
        </div>
      </section>

      <section className="form-section wide">
        <header>
          <h2>{t('allocations')}</h2>
          <p>{t('allocationsHint')}</p>
        </header>
        <fieldset className="form-section-body stack bare">
          <legend className="visually-hidden">{t('allocations')}</legend>
          {!customer ? (
            <p className="muted">{t('pickCustomerFirst')}</p>
          ) : openInvoices === null ? (
            <p className="muted">{tc('loading')}</p>
          ) : openInvoices.length === 0 ? (
            <p className="muted">{t('noOpenInvoices')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('invoice')}</th>
                    <th>{t('invoiceDate')}</th>
                    <th>{t('dueDate')}</th>
                    <th>{t('invoiceTotal')}</th>
                    <th>{t('invoiceBalance')}</th>
                    <th>{t('allocate', { currency })}</th>
                  </tr>
                </thead>
                <tbody>
                  {openInvoices.map((i) => {
                    const sameCurrency = i.currency === currency;
                    return (
                      <tr key={i.id} className={sameCurrency ? '' : 'inactive'}>
                        <td className="nowrap">
                          <Link href={`/invoices/${i.id}`}>
                            <InvoiceNumber number={i.number} />
                          </Link>
                          <div className="muted" dir="ltr">
                            {i.shipmentNumber}
                          </div>
                        </td>
                        <td dir="ltr">{i.invoiceDate}</td>
                        <td dir="ltr">{i.dueDate}</td>
                        <td dir="ltr">
                          <Money value={i.total} currency={i.currency} />
                        </td>
                        <td dir="ltr">
                          <Money value={i.balance} currency={i.currency} />
                        </td>
                        <td>
                          {sameCurrency ? (
                            <input
                              className="amount-input"
                              inputMode="decimal"
                              dir="ltr"
                              pattern={AMOUNT_PATTERN}
                              aria-label={t('allocate', { currency })}
                              value={allocations[i.id] ?? ''}
                              onChange={(e) =>
                                setAllocations((all) => ({ ...all, [i.id]: e.target.value }))
                              }
                            />
                          ) : (
                            <span className="muted">
                              {t('otherCurrency', { currency: i.currency })}
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
      </section>

      <section className="form-section">
        <header>
          <h2>{tc('notes')}</h2>
        </header>
        <div className="form-section-body">
          <label className="field">
            <span className="visually-hidden">{tc('notes')}</span>
            <textarea name="notes" rows={3} maxLength={2000} />
          </label>
        </div>
      </section>

      <div className="actions form-footer">
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={busy || customer === null || selectedCash === ''}
        >
          {t('save')}
        </button>
      </div>
    </form>
  );
}
