'use client';

import {
  SUPPLIER_BILL_STATUSES,
  type Page,
  type SupplierBillStatus,
  type SupplierBillSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

/** A bill's number, or "Draft" before approval. */
export function BillNumber({ number }: { number: string | null }) {
  const t = useTranslations('SupplierBills');
  return number ? <span dir="ltr">{number}</span> : <span className="muted">{t('draft')}</span>;
}

export function SupplierBills({ supplierId }: { supplierId?: string }) {
  const t = useTranslations('SupplierBills');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const failure = useFailureText();
  const [status, setStatus] = useState<SupplierBillStatus | ''>('');
  const [openOnly, setOpenOnly] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<SupplierBillSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const params = new URLSearchParams({ pageSize: '50', q: query });
      if (status) params.set('status', status);
      if (openOnly) params.set('openOnly', 'true');
      if (supplierId) params.set('supplierId', supplierId);
      api<Page<SupplierBillSummaryDto>>(`/supplier-bills?${params.toString()}`)
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, openOnly, supplierId, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'suppliers:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'suppliers:create') && (
          <Link href="/supplier-bills/new" className="button primary">
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
          onChange={(e) => setStatus(e.target.value as SupplierBillStatus | '')}
        >
          <option value="">{tc('all')}</option>
          {SUPPLIER_BILL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`supplierBill_${s}`)}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          {t('openOnly')}
        </label>
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
                  <th>{t('supplier')}</th>
                  <th>{t('supplierReference')}</th>
                  <th>{t('billDate')}</th>
                  <th>{t('dueDate')}</th>
                  <th>{t('total')}</th>
                  <th>{t('balance')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((b) => (
                  <tr key={b.id} className={b.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td className="nowrap">
                      <Link href={`/supplier-bills/${b.id}`}>
                        <BillNumber number={b.number} />
                      </Link>
                      {b.isOpening && <div className="muted">{t('opening')}</div>}
                    </td>
                    <td>{b.supplierName}</td>
                    <td dir="ltr">{b.supplierReference ?? '—'}</td>
                    <td dir="ltr">{b.billDate}</td>
                    <td dir="ltr">{b.dueDate}</td>
                    <td dir="ltr">
                      <Money value={b.total} currency={b.currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={b.balance} currency={b.currency} />
                    </td>
                    <td>
                      <StatusBadge kind="supplierBill" status={b.status} />
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
