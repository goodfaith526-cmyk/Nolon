'use client';

import type { SupplierPaymentDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money, ReasonForm, useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

export function SupplierPaymentDetail({ id }: { id: string }) {
  const t = useTranslations('SupplierPayments');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  const {
    record: payment,
    notice: loadNotice,
    setRecord,
  } = useRecord<SupplierPaymentDto>(`/supplier-payments/${id}`);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!payment) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function cancel(reason: string) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(
        await api<SupplierPaymentDto>(`/supplier-payments/${id}/cancel`, {
          method: 'POST',
          body: { reason },
        }),
      );
      setCancelling(false);
      setNotice({ ok: true, text: t('cancelledNotice') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const p = payment;
  const journals = can(me, 'manual_journals:view');

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('payment')} <span dir="ltr">{p.number}</span>
        </h1>
        <StatusBadge kind="supplierPayment" status={p.status} />
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {p.actions.canCancel && (
          <button type="button" onClick={() => setCancelling(true)}>
            {t('cancel')}
          </button>
        )}
        {journals && (
          <Link href={`/accounting/journals/${p.journalEntryId}`} className="button">
            {t('openJournal')} <span dir="ltr">{p.journalEntryNumber}</span>
          </Link>
        )}
        {journals && p.cancelJournalEntryId && (
          <Link href={`/accounting/journals/${p.cancelJournalEntryId}`} className="button">
            {t('openCancelJournal')} <span dir="ltr">{p.cancelJournalEntryNumber}</span>
          </Link>
        )}
      </div>
      {cancelling && (
        <ReasonForm
          hint={t('cancelHint')}
          label={t('cancelReason')}
          submitLabel={t('cancel')}
          backLabel={tc('back')}
          busy={busy}
          onSubmit={(reason) => void cancel(reason)}
          onBack={() => setCancelling(false)}
        />
      )}

      <dl className="details">
        <dt>{t('supplier')}</dt>
        <dd>{p.supplierName}</dd>
        <dt>{t('paymentDate')}</dt>
        <dd dir="ltr">{p.paymentDate}</dd>
        <dt>{t('amount')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={p.amount} currency={p.currency} />
          </strong>
        </dd>
        <dt>{t('fxRate')}</dt>
        <dd dir="ltr">{p.fxRate}</dd>
        <dt>{t('cashAccount')}</dt>
        <dd>
          <span dir="ltr">{p.cashAccountCode}</span>{' '}
          {name({ nameEn: p.cashAccountNameEn, nameAr: p.cashAccountNameAr })}
        </dd>
        <dt>{t('reference')}</dt>
        <dd dir="ltr">{p.reference ?? '—'}</dd>
        {p.notes && (
          <>
            <dt>{tc('notes')}</dt>
            <dd className="pre">{p.notes}</dd>
          </>
        )}
        {p.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd>{p.cancelReason}</dd>
          </>
        )}
      </dl>

      <h2>{t('allocations')}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('bill')}</th>
              <th>{t('allocatedAmount')}</th>
              <th>{t('relievedUsd')}</th>
            </tr>
          </thead>
          <tbody>
            {p.allocations.map((a) => (
              <tr key={a.billId}>
                <td dir="ltr">
                  {can(me, 'suppliers:view') ? (
                    <Link href={`/supplier-bills/${a.billId}`}>{a.billNumber}</Link>
                  ) : (
                    a.billNumber
                  )}
                </td>
                <td dir="ltr">
                  <Money value={a.amount} currency={p.currency} />
                </td>
                <td dir="ltr">
                  <Money value={a.relievedUsd} currency="USD" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
