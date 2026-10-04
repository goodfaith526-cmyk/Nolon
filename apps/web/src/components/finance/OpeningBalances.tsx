'use client';

import {
  CONTROL_ROLES,
  type AccountingSettingsDto,
  type CustomerInvoiceDto,
  type CustomerSummaryDto,
  type JournalEntryDto,
  type ManualJournalLineInput,
  type OpeningAccountsRequest,
  type OpeningCustomerItemRequest,
  type OpeningSupplierItemRequest,
  type Page,
  type SupplierBillDto,
  type SupplierSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN, todayString } from '@/lib/money';
import { CustomerPicker } from '../commercial/CustomerPicker';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { useAccounts, useRecord } from './common';

interface LineDraft {
  key: number;
  accountId: string;
  currency: string;
  fxRate: string;
  debit: string;
  credit: string;
}

let nextKey = 1;
const emptyLine = (): LineDraft => ({
  key: nextKey++,
  accountId: '',
  currency: 'USD',
  fxRate: '',
  debit: '',
  credit: '',
});

/**
 * Opening balances at go-live (annex C rule 15): ledger accounts in one entry, then each customer's
 * and supplier's open items. Everything posts against opening equity; the API checks it all.
 */
export function OpeningBalances() {
  const t = useTranslations('OpeningBalances');
  const tc = useTranslations('Common');
  const me = useMe();
  if (!can(me, 'manual_journals:create') || !can(me, 'manual_journals:approve')) {
    return <p className="error">{tc('noAccess')}</p>;
  }
  return (
    <section className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <AccountsForm />
      {can(me, 'customer_invoices:view') && <CustomerItemForm />}
      {can(me, 'suppliers:view') && <SupplierItemForm />}
    </section>
  );
}

/** A panel with a form that keeps one request id until it succeeds, so a retry posts once. */
function OpeningPanel({
  title,
  hint,
  children,
  onSubmit,
}: {
  title: string;
  hint: string;
  children: ReactNode;
  onSubmit: (form: FormData, requestId: string) => Promise<ReactNode>;
}) {
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [done, setDone] = useState<ReactNode>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setNotice(null);
    try {
      setDone(await onSubmit(new FormData(form), requestId));
      setRequestId(crypto.randomUUID());
      form.reset();
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={(e) => void submit(e)}>
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      <div className="panel-body stack">
        <p className="muted">{hint}</p>
        <Notice notice={notice} />
        {done && (
          <p className="success" role="status">
            {done}
          </p>
        )}
        {children}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {tc('save')}
          </button>
        </div>
      </div>
    </form>
  );
}

function CurrencyFields({ prefix = '' }: { prefix?: string }) {
  const t = useTranslations('OpeningBalances');
  const name = useLocalName();
  const master = useMasterData();
  return (
    <>
      <label className="field">
        {t('currency')}
        <select name={`${prefix}currency`} required defaultValue="USD">
          {(master?.currencies ?? [])
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
        <input name={`${prefix}fxRate`} inputMode="decimal" dir="ltr" pattern={FX_RATE_PATTERN} />
      </label>
    </>
  );
}

const optionalRate = (form: FormData, currency: string, name = 'fxRate') => {
  const rate = field(form, name).trim();
  return currency === 'USD' || rate === '' ? null : rate;
};

function AccountsForm() {
  const t = useTranslations('OpeningBalances');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const { accounts } = useAccounts();
  const { record: settings } = useRecord<AccountingSettingsDto>('/accounting/settings');
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine(), emptyLine()]);

  // Dropdown narrowing only: receivable, payable and advances come from open items, and the
  // opening equity account takes the difference. The API refuses them anyway.
  const excluded = new Set(
    (settings?.mappings ?? [])
      .filter((m) => CONTROL_ROLES.includes(m.role) || m.role === 'OPENING_EQUITY')
      .map((m) => m.accountId),
  );
  const choices = (accounts ?? []).filter((a) => a.isPostable && a.isActive && !excluded.has(a.id));
  const update = (key: number, patch: Partial<LineDraft>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function submit(form: FormData, requestId: string) {
    const body: OpeningAccountsRequest = {
      requestId,
      branchId: field(form, 'branchId'),
      entryDate: field(form, 'entryDate'),
      description: field(form, 'description').trim() || null,
      lines: lines
        .filter((l) => l.accountId !== '')
        .map((l): ManualJournalLineInput => ({
          accountId: l.accountId,
          currency: l.currency,
          fxRate: l.currency === 'USD' || l.fxRate.trim() === '' ? null : l.fxRate.trim(),
          ...(l.debit.trim() ? { debit: l.debit.trim() } : {}),
          ...(l.credit.trim() ? { credit: l.credit.trim() } : {}),
        })),
    };
    const entry = await api<JournalEntryDto>('/accounting/opening-balances', {
      method: 'POST',
      body,
    });
    setLines([emptyLine(), emptyLine()]);
    return (
      <>
        {t('postedEntry')}{' '}
        <Link href={`/accounting/journals/${entry.id}`} dir="ltr">
          {entry.number}
        </Link>
      </>
    );
  }

  return (
    <OpeningPanel title={t('accountsTitle')} hint={t('accountsHint')} onSubmit={submit}>
      <div className="grid">
        <label className="field">
          {t('branch')}
          <select name="branchId" required>
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('entryDate')}
          <input name="entryDate" type="date" required defaultValue={todayString()} />
        </label>
        <label className="field">
          {t('description')}
          <input name="description" maxLength={1000} />
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('account')}</th>
              <th>{t('currency')}</th>
              <th>{t('fxRateOptional')}</th>
              <th>{t('debit')}</th>
              <th>{t('credit')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td>
                  <select
                    value={l.accountId}
                    aria-label={t('account')}
                    onChange={(e) => update(l.key, { accountId: e.target.value })}
                  >
                    <option value="">{t('chooseAccount')}</option>
                    {choices.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {name(a)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={l.currency}
                    aria-label={t('currency')}
                    onChange={(e) => update(l.key, { currency: e.target.value })}
                  >
                    {(master?.currencies ?? [])
                      .filter((c) => c.isActive)
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <input
                    className="amount-input"
                    inputMode="decimal"
                    dir="ltr"
                    pattern={FX_RATE_PATTERN}
                    aria-label={t('fxRateOptional')}
                    disabled={l.currency === 'USD'}
                    value={l.fxRate}
                    onChange={(e) => update(l.key, { fxRate: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="amount-input"
                    inputMode="decimal"
                    dir="ltr"
                    pattern={AMOUNT_PATTERN}
                    aria-label={t('debit')}
                    value={l.debit}
                    onChange={(e) => update(l.key, { debit: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="amount-input"
                    inputMode="decimal"
                    dir="ltr"
                    pattern={AMOUNT_PATTERN}
                    aria-label={t('credit')}
                    value={l.credit}
                    onChange={(e) => update(l.key, { credit: e.target.value })}
                  />
                </td>
                <td>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}
                    >
                      {tc('remove')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button type="button" onClick={() => setLines((all) => [...all, emptyLine()])}>
          {t('addLine')}
        </button>
      </div>
    </OpeningPanel>
  );
}

function ItemDates({ dateLabel }: { dateLabel: string }) {
  const t = useTranslations('OpeningBalances');
  return (
    <>
      <label className="field">
        {t('entryDate')}
        <input name="entryDate" type="date" required defaultValue={todayString()} />
      </label>
      <label className="field">
        {t('reference')}
        <input name="reference" required maxLength={50} dir="ltr" />
      </label>
      <label className="field">
        {dateLabel}
        <input name="documentDate" type="date" required />
      </label>
      <label className="field">
        {t('dueDate')}
        <input name="dueDate" type="date" required />
      </label>
      <CurrencyFields />
      <label className="field">
        {t('openAmount')}
        <input name="amount" required inputMode="decimal" dir="ltr" pattern={AMOUNT_PATTERN} />
      </label>
    </>
  );
}

function CustomerItemForm() {
  const t = useTranslations('OpeningBalances');
  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);

  async function submit(form: FormData, requestId: string) {
    if (!customer) throw new Error('No customer');
    const currency = field(form, 'currency');
    const body: OpeningCustomerItemRequest = {
      requestId,
      customerId: customer.id,
      entryDate: field(form, 'entryDate'),
      reference: field(form, 'reference').trim(),
      invoiceDate: field(form, 'documentDate'),
      dueDate: field(form, 'dueDate'),
      currency,
      fxRate: optionalRate(form, currency),
      amount: field(form, 'amount').trim(),
    };
    const invoice = await api<CustomerInvoiceDto>('/customer-invoices/opening', {
      method: 'POST',
      body,
    });
    return (
      <>
        {t('recordedItem')}{' '}
        <Link href={`/invoices/${invoice.id}`} dir="ltr">
          {invoice.number}
        </Link>
      </>
    );
  }

  return (
    <OpeningPanel title={t('customerTitle')} hint={t('customerHint')} onSubmit={submit}>
      <CustomerPicker value={customer} onChange={setCustomer} />
      <div className="grid">
        <ItemDates dateLabel={t('invoiceDate')} />
      </div>
    </OpeningPanel>
  );
}

function SupplierItemForm() {
  const t = useTranslations('OpeningBalances');
  const me = useMe();
  const name = useLocalName();
  const [suppliers, setSuppliers] = useState<SupplierSummaryDto[]>([]);

  useEffect(() => {
    api<Page<SupplierSummaryDto>>('/suppliers?activeOnly=true&pageSize=100')
      .then((page) => setSuppliers(page.items))
      .catch(() => {
        // Without the list nothing can be chosen; the panel's save then reports the error.
      });
  }, []);

  async function submit(form: FormData, requestId: string) {
    const currency = field(form, 'currency');
    const body: OpeningSupplierItemRequest = {
      requestId,
      supplierId: field(form, 'supplierId'),
      branchId: field(form, 'branchId'),
      entryDate: field(form, 'entryDate'),
      reference: field(form, 'reference').trim(),
      billDate: field(form, 'documentDate'),
      dueDate: field(form, 'dueDate'),
      currency,
      fxRate: optionalRate(form, currency),
      amount: field(form, 'amount').trim(),
    };
    const bill = await api<SupplierBillDto>('/supplier-bills/opening', { method: 'POST', body });
    return (
      <>
        {t('recordedItem')}{' '}
        <Link href={`/supplier-bills/${bill.id}`} dir="ltr">
          {bill.number}
        </Link>
      </>
    );
  }

  return (
    <OpeningPanel title={t('supplierTitle')} hint={t('supplierHint')} onSubmit={submit}>
      <div className="grid">
        <label className="field">
          {t('supplier')}
          <select name="supplierId" required>
            <option value="">{t('chooseSupplier')}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('branch')}
          <select name="branchId" required>
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        <ItemDates dateLabel={t('billDate')} />
      </div>
    </OpeningPanel>
  );
}
