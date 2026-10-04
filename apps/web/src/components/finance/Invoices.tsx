'use client';

import {
  INVOICE_STATUSES,
  type CustomerInvoiceSummaryDto,
  type InvoiceStatus,
  type Page,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { Money } from './common';

/** An invoice's number, or "Draft" until approval gives it one. */
export function InvoiceNumber({ number }: { number: string | null }) {
  const t = useTranslations('Invoices');
  return number ? <span dir="ltr">{number}</span> : <span>{t('draftNumber')}</span>;
}

export function Invoices() {
  const t = useTranslations('Invoices');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const failure = useFailureText();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [openOnly, setOpenOnly] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<CustomerInvoiceSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = `${status ? `&status=${status}` : ''}${openOnly ? '&openOnly=true' : ''}`;
      api<Page<CustomerInvoiceSummaryDto>>(
        `/customer-invoices?pageSize=50${filter}&q=${encodeURIComponent(query)}`,
      )
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, openOnly, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'customer_invoices:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
      </div>
      <p className="muted">{t('createHint')}</p>
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
        <select value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')}>
          <option value="">{tc('all')}</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`invoice_${s}`)}
            </option>
          ))}
        </select>
        <label className="field inline">
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
                  <th>{t('invoiceDate')}</th>
                  <th>{t('customer')}</th>
                  <th>{t('shipment')}</th>
                  <th>{t('total')}</th>
                  <th>{t('balance')}</th>
                  <th>{tc('status')}</th>
                  <th>{t('paymentStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((i) => (
                  <tr key={i.id} className={i.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td className="nowrap">
                      <Link href={`/invoices/${i.id}`}>
                        <InvoiceNumber number={i.number} />
                      </Link>
                    </td>
                    <td dir="ltr">{i.invoiceDate}</td>
                    <td>{i.customerName}</td>
                    <td dir="ltr">{i.shipmentNumber}</td>
                    <td dir="ltr">
                      <Money value={i.total} currency={i.currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={i.balance} currency={i.currency} />
                    </td>
                    <td>
                      <StatusBadge kind="invoice" status={i.status} />
                    </td>
                    <td>
                      {i.status === 'APPROVED' ? (
                        <StatusBadge kind="payment" status={i.paymentStatus} />
                      ) : (
                        '—'
                      )}
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
