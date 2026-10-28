'use client';

import type {
  CreateReceiptRequest,
  CustomerInvoiceSummaryDto,
  CustomerSummaryDto,
  Page,
  ReceiptAllocationSuggestionDto,
  ReceiptDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { branchToday } from '@/lib/branches';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN } from '@/lib/money';
import { CustomerPicker } from '../commercial/CustomerPicker';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { InvoiceNumber } from './Invoices';
import { Money, chosenCashAccount, useAccounts } from './common';

/**
 * Every approved open invoice of the customer, page by page: the API's split may give a share to
 * any of them, and the currency is suggested only from the whole set (Codex F94-1).
 */
async function openInvoicesOf(customerId: string): Promise<CustomerInvoiceSummaryDto[]> {
  const items: CustomerInvoiceSummaryDto[] = [];
  for (let page = 1; ; page++) {
    const next = await api<Page<CustomerInvoiceSummaryDto>>(
      `/customer-invoices?customerId=${customerId}&status=APPROVED&openOnly=true&pageSize=100&page=${page}`,
    );
    items.push(...next.items);
    if (next.items.length === 0 || items.length >= next.total) return items;
  }
}

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
  // The currency the person picked (null until then), which is kept; see `currency` below.
  const [currencyChoice, setCurrency] = useState<string | null>(null);
  const [cashAccountId, setCashAccountId] = useState('');
  const [openInvoices, setOpenInvoices] = useState<CustomerInvoiceSummaryDto[] | null>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState('');
  // The date the person typed (null until then), which is kept; see `receiptDate` below.
  const [dateChoice, setDate] = useState<string | null>(null);
  /** What the last "allocate the amount" left over (held as an advance), shown until changed. */
  const [rest, setRest] = useState<string | null>(null);
  // One id per form: a resend after a lost response returns the receipt already posted (B1-3).
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const customerId = customer?.id;
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    openInvoicesOf(customerId)
      .then((items) => {
        if (!cancelled) setOpenInvoices(items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, failure]);

  if (!can(me, 'receipts:create')) return <p className="error">{tc('noAccess')}</p>;

  // Functional review C3. The currency is suggested from the customer's open invoices when they
  // are all in one currency, once they are loaded; invoices in several currencies (or none)
  // suggest nothing and the person picks. Another customer reloads the invoices and suggests
  // again; a currency the person picked is kept.
  const invoiceCurrencies = new Set((openInvoices ?? []).map((i) => i.currency));
  const inferredCurrency = invoiceCurrencies.size === 1 ? (openInvoices?.[0]?.currency ?? '') : '';
  const currency = currencyChoice ?? inferredCurrency;
  // Dated today in the customer's branch, the receipt's branch (C9); a typed date is kept.
  const receiptDate = dateChoice ?? (customer ? branchToday(me, customer.branchId) : '');

  // Dropdown narrowing only: the API checks the account again (cash, branch, currency).
  const cashAccounts = (accounts ?? []).filter(
    (a) =>
      a.isCash &&
      a.isActive &&
      a.isPostable &&
      a.currency === currency &&
      (a.branchId === null || a.branchId === customer?.branchId),
  );
  // The only matching account is taken; another customer branch or currency drops one that no
  // longer matches (C3, C4).
  const selectedCash = chosenCashAccount(cashAccounts, cashAccountId);

  function pickCustomer(c: CustomerSummaryDto | null) {
    setCustomer(c);
    setOpenInvoices(null);
    setAllocations({});
    setRest(null);
  }

  /**
   * Fills the shares from the API's split of the amount, oldest invoice first (C3): asked for
   * only when the person presses the button; the API computes it, and every share stays editable.
   */
  async function distribute() {
    if (!customer || !currency || amount.trim() === '') return;
    setBusy(true);
    setNotice(null);
    try {
      const query = new URLSearchParams({
        customerId: customer.id,
        currency,
        amount: amount.trim(),
      });
      const split = await api<ReceiptAllocationSuggestionDto>(
        `/receipts/allocation-suggestion?${query.toString()}`,
      );
      // Every share is shown and sent: one for an invoice this form has not listed (issued since
      // it loaded) is not dropped silently, the person reloads instead (Codex F94-1).
      const listed = new Set((openInvoices ?? []).map((i) => i.id));
      if (split.allocations.some((a) => !listed.has(a.invoiceId))) {
        setNotice({ ok: false, text: t('invoicesChanged') });
        return;
      }
      setAllocations(Object.fromEntries(split.allocations.map((a) => [a.invoiceId, a.amount])));
      setRest(split.unallocated === '0' ? null : split.unallocated);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!customer) return;
    const form = new FormData(e.currentTarget);
    const fxRate = field(form, 'fxRate').trim();
    const body: CreateReceiptRequest = {
      requestId,
      customerId: customer.id,
      receiptDate,
      currency,
      fxRate: currency === 'USD' || fxRate === '' ? null : fxRate,
      amount: amount.trim(),
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
              <input
                name="receiptDate"
                type="date"
                required
                value={receiptDate}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className="field">
              {t('currency')}
              <select
                value={currency}
                required
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setRest(null);
                }}
              >
                <option value="">{t('chooseCurrency')}</option>
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
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setRest(null);
                  // An amount entered is in the currency shown then: it never follows a later
                  // suggestion, e.g. from another customer's invoices (Codex F94-2).
                  if (currencyChoice === null) setCurrency(currency);
                }}
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
          {currencyChoice === null && inferredCurrency !== '' && (
            <p className="muted">{t('currencyFromInvoices', { currency: inferredCurrency })}</p>
          )}
          {currencyChoice !== null && inferredCurrency !== '' && inferredCurrency !== currency && (
            <p className="muted">
              {t('currencySuggestionNotApplied', { currency: inferredCurrency })}
            </p>
          )}
          {currencyChoice === null && invoiceCurrencies.size > 1 && (
            <p className="muted">{t('mixedCurrencies')}</p>
          )}
          {accountsStatus === 403 ? (
            <p className="error">{t('cashAccountsNoAccess')}</p>
          ) : accountsStatus !== null ? (
            <p className="error">{tc('failed')}</p>
          ) : (
            accounts !== null &&
            currency !== '' &&
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
            <div className="stack">
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || currency === '' || amount.trim() === ''}
                  onClick={() => void distribute()}
                >
                  {t('distribute')}
                </button>
              </div>
              {rest !== null && (
                <p className="muted">{t('distributedRest', { amount: rest, currency })}</p>
              )}
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
                              <div className="row">
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
                                {/* The balance as the API returned it, only when pressed (C3). */}
                                <button
                                  type="button"
                                  className="ghost"
                                  onClick={() =>
                                    setAllocations((all) => ({ ...all, [i.id]: i.balance }))
                                  }
                                >
                                  {t('payBalance')}
                                </button>
                              </div>
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
