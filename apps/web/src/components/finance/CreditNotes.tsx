'use client';

import {
  CREDIT_NOTE_STATUSES,
  type CreditNoteStatus,
  type CreditNoteSummaryDto,
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

/** A credit note's number, or "Draft" before approval. */
export function CreditNoteNumber({ number }: { number: string | null }) {
  const t = useTranslations('CreditNotes');
  return number ? <span dir="ltr">{number}</span> : <span className="muted">{t('draft')}</span>;
}

/** Credit notes are created from an approved invoice's page; this lists them. */
export function CreditNotes() {
  const t = useTranslations('CreditNotes');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const failure = useFailureText();
  const [status, setStatus] = useState<CreditNoteStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<CreditNoteSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<CreditNoteSummaryDto>>(
        `/credit-notes?pageSize=50${filter}&q=${encodeURIComponent(query)}`,
      )
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'credit_notes:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
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
        <select value={status} onChange={(e) => setStatus(e.target.value as CreditNoteStatus | '')}>
          <option value="">{tc('all')}</option>
          {CREDIT_NOTE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`creditNote_${s}`)}
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
                  <th>{t('creditDate')}</th>
                  <th>{t('customer')}</th>
                  <th>{t('invoice')}</th>
                  <th>{t('amount')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((n) => (
                  <tr key={n.id} className={n.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td className="nowrap">
                      <Link href={`/credit-notes/${n.id}`}>
                        <CreditNoteNumber number={n.number} />
                      </Link>
                    </td>
                    <td dir="ltr">{n.creditDate}</td>
                    <td>{n.customerName}</td>
                    <td dir="ltr">
                      <Link href={`/invoices/${n.invoiceId}`}>{n.invoiceNumber}</Link>
                    </td>
                    <td dir="ltr">
                      <Money value={n.amount} currency={n.currency} />
                    </td>
                    <td>
                      <StatusBadge kind="creditNote" status={n.status} />
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
