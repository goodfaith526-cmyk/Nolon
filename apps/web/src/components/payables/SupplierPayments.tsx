'use client';

import {
  SUPPLIER_PAYMENT_STATUSES,
  type Page,
  type SupplierPaymentStatus,
  type SupplierPaymentSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

export function SupplierPayments() {
  const t = useTranslations('SupplierPayments');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const failure = useFailureText();
  const [status, setStatus] = useState<SupplierPaymentStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<SupplierPaymentSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<SupplierPaymentSummaryDto>>(
        `/supplier-payments?pageSize=50${filter}&q=${encodeURIComponent(query)}`,
      )
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'supplier_payments:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'supplier_payments:create') && (
          <Link href="/supplier-payments/new" className="button primary">
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
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as SupplierPaymentStatus | '')}
        >
          <option value="">{tc('all')}</option>
          {SUPPLIER_PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`supplierPayment_${s}`)}
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
                  <th>{t('paymentDate')}</th>
                  <th>{t('supplier')}</th>
                  <th>{t('amount')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((p) => (
                  <tr key={p.id} className={p.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td dir="ltr">
                      <Link href={`/supplier-payments/${p.id}`}>{p.number}</Link>
                    </td>
                    <td dir="ltr">{p.paymentDate}</td>
                    <td>{p.supplierName}</td>
                    <td dir="ltr">
                      <Money value={p.amount} currency={p.currency} />
                    </td>
                    <td>
                      <StatusBadge kind="supplierPayment" status={p.status} />
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
