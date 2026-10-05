'use client';

import type { AccountDto, ExpenseCategoryDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';

/**
 * Expense categories (master data the client extends): each posts general expenses and expense
 * lines of supplier bills to one expense account. The Administrator maintains them.
 */
export function ExpenseCategories({ accounts }: { accounts: AccountDto[] }) {
  const t = useTranslations('Accounts');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  const [categories, setCategories] = useState<ExpenseCategoryDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const canUpdate = can(me, 'chart_of_accounts:update');

  useEffect(() => {
    api<ExpenseCategoryDto[]>('/accounting/expense-categories')
      .then(setCategories)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);

  async function save(e: FormEvent<HTMLFormElement>, code: string) {
    e.preventDefault();
    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<ExpenseCategoryDto>(
        `/accounting/expense-categories/${encodeURIComponent(code || field(form, 'code'))}`,
        {
          method: 'PUT',
          body: {
            nameEn: field(form, 'nameEn').trim(),
            nameAr: field(form, 'nameAr').trim(),
            accountId: field(form, 'accountId'),
            isActive: form.get('isActive') === 'on',
          },
        },
      );
      setCategories((all) =>
        [...(all ?? []).filter((c) => c.code !== saved.code), saved].sort((a, b) =>
          a.code.localeCompare(b.code),
        ),
      );
      if (!code) formElement.reset();
      setNotice({ ok: true, text: tc('saved') });
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  // Dropdown narrowing only; the API checks the account is an active expense account.
  const expenseAccounts = accounts.filter(
    (a) => a.type === 'EXPENSE' && a.isPostable && a.isActive && !a.isCash,
  );

  const row = (c: ExpenseCategoryDto | null) => {
    const formId = `category-${c?.code ?? 'new'}`;
    return (
      <tr key={c ? `${c.code}-${c.accountId}-${String(c.isActive)}` : 'new'}>
        <td dir="ltr">
          <form id={formId} onSubmit={(e) => void save(e, c?.code ?? '')} />
          {c ? (
            c.code
          ) : (
            <input
              form={formId}
              name="code"
              required
              pattern="[A-Za-z0-9_]{1,20}"
              aria-label={t('categoryCode')}
            />
          )}
        </td>
        <td>
          <input
            form={formId}
            name="nameEn"
            required
            maxLength={200}
            dir="ltr"
            disabled={!canUpdate}
            defaultValue={c?.nameEn ?? ''}
            aria-label={t('nameEn')}
          />
        </td>
        <td>
          <input
            form={formId}
            name="nameAr"
            required
            maxLength={200}
            dir="rtl"
            disabled={!canUpdate}
            defaultValue={c?.nameAr ?? ''}
            aria-label={t('nameAr')}
          />
        </td>
        <td>
          <select
            form={formId}
            name="accountId"
            required
            disabled={!canUpdate}
            defaultValue={c?.accountId ?? ''}
            aria-label={t('account')}
          >
            <option value="">{t('chooseAccount')}</option>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {name(a)}
              </option>
            ))}
          </select>
        </td>
        <td>
          <input
            type="checkbox"
            form={formId}
            name="isActive"
            disabled={!canUpdate}
            defaultChecked={c?.isActive ?? true}
            aria-label={tc('active')}
          />
        </td>
        {canUpdate && (
          <td>
            <button type="submit" form={formId} disabled={busy}>
              {c ? tc('save') : t('addCategory')}
            </button>
          </td>
        )}
      </tr>
    );
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('expenseCategoriesTitle')}</h2>
      </div>
      <p className="panel-body muted">{t('expenseCategoriesHint')}</p>
      <Notice notice={notice} />
      {categories === null ? (
        <p className="panel-body muted">{tc('loading')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('categoryCode')}</th>
              <th>{t('nameEn')}</th>
              <th>{t('nameAr')}</th>
              <th>{t('account')}</th>
              <th>{tc('active')}</th>
              {canUpdate && <th />}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => row(c))}
            {canUpdate && row(null)}
          </tbody>
        </table>
      )}
    </div>
  );
}
