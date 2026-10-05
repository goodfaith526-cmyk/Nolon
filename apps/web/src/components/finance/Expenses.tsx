'use client';

import {
  EXPENSE_STATUSES,
  type ExpenseStatus,
  type ExpenseSummaryDto,
  type Page,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { Money, useBranchCode } from './common';

/** An expense's number, or "Draft" before approval. */
export function ExpenseNumber({ number }: { number: string | null }) {
  const t = useTranslations('Expenses');
  return number ? <span dir="ltr">{number}</span> : <span className="muted">{t('draft')}</span>;
}

export function Expenses() {
  const t = useTranslations('Expenses');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const branchCode = useBranchCode(me);
  const failure = useFailureText();
  const [status, setStatus] = useState<ExpenseStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<ExpenseSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<ExpenseSummaryDto>>(`/expenses?pageSize=50${filter}&q=${encodeURIComponent(query)}`)
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'expenses:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'expenses:create') && (
          <Link href="/expenses/new" className="button primary">
            {t('add')}
          </Link>
        )}
      </div>
      <p className="muted">{t('intro')}</p>
      <Notice notice={notice} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          load(q);
        }}
      >
        <input
          type="search"
          value={q}
          placeholder={t('search')}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus | '')}>
          <option value="">{tc('all')}</option>
          {EXPENSE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`expense_${s}`)}
            </option>
          ))}
        </select>
        <button type="submit">{tc('search')}</button>
      </form>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('number')}</th>
                  <th>{t('expenseDate')}</th>
                  <th>{t('branch')}</th>
                  <th>{t('category')}</th>
                  <th>{t('description')}</th>
                  <th>{t('amount')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((x) => (
                  <tr key={x.id} className={x.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td className="nowrap">
                      <Link href={`/expenses/${x.id}`}>
                        <ExpenseNumber number={x.number} />
                      </Link>
                    </td>
                    <td dir="ltr">{x.expenseDate}</td>
                    <td dir="ltr">{branchCode(x.branchId)}</td>
                    <td dir="ltr">{x.categoryCode}</td>
                    <td>{x.description}</td>
                    <td dir="ltr">
                      <Money value={x.amount} currency={x.currency} />
                    </td>
                    <td>
                      <StatusBadge kind="expense" status={x.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.total > page.items.length && (
            <p className="muted">{tc('shown', { shown: page.items.length, total: page.total })}</p>
          )}
        </>
      )}
    </section>
  );
}
