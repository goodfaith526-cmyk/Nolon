'use client';

import type { ReceiptDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { Money, useRecord } from './common';

export function ReceiptDetail({ id }: { id: string }) {
  const t = useTranslations('Receipts');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  const {
    record: receipt,
    notice: loadNotice,
    setRecord,
  } = useRecord<ReceiptDto>(`/receipts/${id}`);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!receipt) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function cancel() {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(
        await api<ReceiptDto>(`/receipts/${id}/cancel`, { method: 'POST', body: { reason } }),
      );
      setCancelling(false);
      setNotice({ ok: true, text: t('cancelledNotice') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const r = receipt;
  const journals = can(me, 'manual_journals:view');

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('receipt')} <span dir="ltr">{r.number}</span>
        </h1>
        <StatusBadge kind="receipt" status={r.status} />
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {r.actions.canCancel && (
          <button type="button" onClick={() => setCancelling(true)}>
            {t('cancel')}
          </button>
        )}
        {journals && (
          <Link href={`/accounting/journals/${r.journalEntryId}`} className="button">
            {t('openJournal')} <span dir="ltr">{r.journalEntryNumber}</span>
          </Link>
        )}
        {journals && r.cancelJournalEntryId && (
          <Link href={`/accounting/journals/${r.cancelJournalEntryId}`} className="button">
            {t('openCancelJournal')} <span dir="ltr">{r.cancelJournalEntryNumber}</span>
          </Link>
        )}
      </div>
      {cancelling && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            void cancel();
          }}
        >
          <p>{t('cancelHint')}</p>
          <label className="field">
            {t('cancelReason')}
            <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('cancel')}
            </button>
            <button type="button" onClick={() => setCancelling(false)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}

      <dl className="details">
        <dt>{t('customer')}</dt>
        <dd>{r.customerName}</dd>
        <dt>{t('receiptDate')}</dt>
        <dd dir="ltr">{r.receiptDate}</dd>
        <dt>{t('amount')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={r.amount} currency={r.currency} />
          </strong>
        </dd>
        <dt>{t('fxRate')}</dt>
        <dd dir="ltr">{r.fxRate}</dd>
        <dt>{t('allocated')}</dt>
        <dd dir="ltr">
          <Money value={r.allocated} currency={r.currency} />
        </dd>
        <dt>{t('unallocated')}</dt>
        <dd dir="ltr">
          <Money value={r.unallocated} currency={r.currency} />
        </dd>
        <dt>{t('cashAccount')}</dt>
        <dd>
          <span dir="ltr">{r.cashAccountCode}</span>{' '}
          {name({ nameEn: r.cashAccountNameEn, nameAr: r.cashAccountNameAr })}
        </dd>
        <dt>{t('reference')}</dt>
        <dd dir="ltr">{r.reference ?? '—'}</dd>
        {r.notes && (
          <>
            <dt>{tc('notes')}</dt>
            <dd className="pre">{r.notes}</dd>
          </>
        )}
        {r.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd>{r.cancelReason}</dd>
          </>
        )}
      </dl>

      <h2>{t('allocations')}</h2>
      {r.allocations.length === 0 ? (
        <p className="muted">{t('noAllocations')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('invoice')}</th>
                <th>{t('allocatedAmount')}</th>
                <th>{t('relievedUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {r.allocations.map((a) => (
                <tr key={a.invoiceId}>
                  <td dir="ltr">
                    {can(me, 'customer_invoices:view') ? (
                      <Link href={`/invoices/${a.invoiceId}`}>{a.invoiceNumber}</Link>
                    ) : (
                      a.invoiceNumber
                    )}
                  </td>
                  <td dir="ltr">
                    <Money value={a.amount} currency={r.currency} />
                  </td>
                  <td dir="ltr">
                    <Money value={a.relievedUsd} currency="USD" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
