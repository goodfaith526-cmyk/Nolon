'use client';

import type {
  CreateExpenseRequest,
  ExpenseCategoryDto,
  ExpenseDto,
  ExpenseInput,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { branchCurrency, branchToday } from '@/lib/branches';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useApiList } from './reports/ReportKit';
import { can, useMe } from '../StaffShell';
import { cashAccountsFor, chosenCashAccount, useAccounts, useRecord } from './common';

/** New expense (no id) or a draft's edit page. The API checks every field again. */
export function ExpenseForm({ id }: { id?: string }) {
  return id ? <EditExpense id={id} /> : <Form expense={null} />;
}

function EditExpense({ id }: { id: string }) {
  const tc = useTranslations('Common');
  const { record, notice } = useRecord<ExpenseDto>(`/expenses/${id}`);
  if (!record)
    return notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>;
  return <Form expense={record} />;
}

function Form({ expense }: { expense: ExpenseDto | null }) {
  const t = useTranslations('Expenses');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();
  const { accounts, status: accountsStatus } = useAccounts();
  const categories = useApiList<ExpenseCategoryDto>('/accounting/expense-categories', true);
  const [branchId, setBranchId] = useState(expense?.branchId ?? me.branches[0]?.id ?? '');
  // A new expense's currency is its branch's (functional review C4), read from /auth/me and
  // following the branch until the person picks one (null until then), which is kept. A saved
  // expense keeps its own.
  const [currencyChoice, setCurrency] = useState<string | null>(expense?.currency ?? null);
  const currency = currencyChoice ?? branchCurrency(me, branchId);
  const [cashAccountId, setCashAccountId] = useState(expense?.cashAccountId ?? '');
  // A new expense is dated today in its branch (C9), following the branch until a date is typed.
  const [dateChoice, setDate] = useState<string | null>(expense?.expenseDate ?? null);
  const expenseDate = dateChoice ?? branchToday(me, branchId);
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!can(me, expense ? 'expenses:update' : 'expenses:create')) {
    return <p className="error">{tc('noAccess')}</p>;
  }
  if (!master) return <p className="muted">{tc('loading')}</p>;

  const cashAccounts = cashAccountsFor(accounts, branchId, currency);
  // The only matching account is taken; another branch or currency drops one that no longer
  // matches (C4).
  const selectedCash = chosenCashAccount(cashAccounts, cashAccountId);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fxRate = field(form, 'fxRate').trim();
    const input: ExpenseInput = {
      expenseDate,
      categoryCode: field(form, 'categoryCode'),
      description: field(form, 'description').trim(),
      currency,
      fxRate: currency === 'USD' || fxRate === '' ? null : fxRate,
      amount: field(form, 'amount').trim(),
      cashAccountId: selectedCash,
      reference: field(form, 'reference').trim() || null,
    };
    setBusy(true);
    setNotice(null);
    try {
      if (expense) {
        await api<ExpenseDto>(`/expenses/${expense.id}`, { method: 'PATCH', body: input });
        router.push(`/expenses/${expense.id}`);
      } else {
        const body: CreateExpenseRequest = { ...input, requestId, branchId };
        const saved = await api<ExpenseDto>('/expenses', { method: 'POST', body });
        router.push(`/expenses/${saved.id}`);
      }
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <h1>{expense ? t('editTitle') : t('add')}</h1>
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          {t('branch')}
          <select
            value={branchId}
            required
            disabled={expense !== null}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('expenseDate')}
          <input
            name="expenseDate"
            type="date"
            required
            value={expenseDate}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="field">
          {t('category')}
          <select name="categoryCode" required defaultValue={expense?.categoryCode ?? ''}>
            <option value="">{t('chooseCategory')}</option>
            {(categories ?? [])
              .filter((c) => c.isActive || c.code === expense?.categoryCode)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {name(c)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('description')}
          <input
            name="description"
            required
            maxLength={200}
            defaultValue={expense?.description ?? ''}
          />
        </label>
        <label className="field">
          {t('currency')}
          <select value={currency} required onChange={(e) => setCurrency(e.target.value)}>
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
            // Only a rate the user entered is sent back: otherwise the FX table's rate for the
            // date applies again. A changed currency starts empty.
            key={currency}
            name="fxRate"
            inputMode="decimal"
            dir="ltr"
            pattern={FX_RATE_PATTERN}
            disabled={currency === 'USD'}
            defaultValue={currency === expense?.currency ? (expense.enteredFxRate ?? '') : ''}
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
            defaultValue={expense?.amount ?? ''}
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
          <input
            name="reference"
            maxLength={100}
            dir="ltr"
            defaultValue={expense?.reference ?? ''}
          />
        </label>
      </div>
      {accountsStatus === 403 && <p className="error">{t('cashAccountsNoAccess')}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || selectedCash === ''}>
          {t('save')}
        </button>
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
