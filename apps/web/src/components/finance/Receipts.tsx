'use client';

import {
  RECEIPT_STATUSES,
  type Page,
  type ReceiptStatus,
  type ReceiptSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { Money } from './common';

export function Receipts() {
  const t = useTranslations('Receipts');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const failure = useFailureText();
  const [status, setStatus] = useState<ReceiptStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<ReceiptSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<ReceiptSummaryDto>>(`/receipts?pageSize=50${filter}&q=${encodeURIComponent(query)}`)
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'receipts:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'receipts:create') && (
          <Link href="/receipts/new" className="button primary">
            {t('add')}
          </Link>
        )}
      </div>
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
        <select value={status} onChange={(e) => setStatus(e.target.value as ReceiptStatus | '')}>
          <option value="">{tc('all')}</option>
          {RECEIPT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`receipt_${s}`)}
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
                  <th>{t('receiptDate')}</th>
                  <th>{t('customer')}</th>
                  <th>{t('amount')}</th>
                  <th>{t('allocated')}</th>
                  <th>{t('unallocated')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((r) => (
                  <tr key={r.id} className={r.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td dir="ltr">
                      <Link href={`/receipts/${r.id}`}>{r.number}</Link>
                    </td>
                    <td dir="ltr">{r.receiptDate}</td>
                    <td>{r.customerName}</td>
                    <td dir="ltr">
                      <Money value={r.amount} currency={r.currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={r.allocated} currency={r.currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={r.unallocated} currency={r.currency} />
                    </td>
                    <td>
                      <StatusBadge kind="receipt" status={r.status} />
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
