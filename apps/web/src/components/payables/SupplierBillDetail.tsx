'use client';

import type { SupplierBillDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money, ReasonForm, useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { BillNumber } from './SupplierBills';

type Panel = 'approve' | 'cancel' | null;

export function SupplierBillDetail({ id }: { id: string }) {
  const t = useTranslations('SupplierBills');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const name = useLocalName();
  const failure = useFailureText();
  const {
    record: bill,
    notice: loadNotice,
    setRecord,
  } = useRecord<SupplierBillDto>(`/supplier-bills/${id}`);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!bill) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function act(action: 'approve' | 'cancel', success: string, body?: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(
        await api<SupplierBillDto>(`/supplier-bills/${id}/${action}`, { method: 'POST', body }),
      );
      setPanel(null);
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const b = bill;
  const journals = can(me, 'manual_journals:view');
  const chargeName = (code: string | null) => {
    const charge = master?.chargeTypes.find((c) => c.code === code);
    return charge ? name(charge) : (code ?? '');
  };

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('bill')} <BillNumber number={b.number} />
        </h1>
        <StatusBadge kind="supplierBill" status={b.status} />
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {b.actions.canEdit && (
          <Link href={`/supplier-bills/${id}/edit`} className="button">
            {tc('edit')}
          </Link>
        )}
        {b.actions.canApprove && (
          <button type="button" className="primary" onClick={() => setPanel('approve')}>
            {t('approve')}
          </button>
        )}
        {b.actions.canCancel && (
          <button type="button" onClick={() => setPanel('cancel')}>
            {t('cancel')}
          </button>
        )}
        {b.status === 'APPROVED' && can(me, 'supplier_payments:create') && (
          <Link href={`/supplier-payments/new?supplierId=${b.supplierId}`} className="button">
            {t('pay')}
          </Link>
        )}
        {journals && b.journalEntryId && (
          <Link href={`/accounting/journals/${b.journalEntryId}`} className="button">
            {t('openJournal')} <span dir="ltr">{b.journalEntryNumber}</span>
          </Link>
        )}
        {journals && b.cancelJournalEntryId && (
          <Link href={`/accounting/journals/${b.cancelJournalEntryId}`} className="button">
            {t('openCancelJournal')} <span dir="ltr">{b.cancelJournalEntryNumber}</span>
          </Link>
        )}
      </div>

      {panel === 'approve' && (
        <div className="card stack">
          <p>{t('approveConfirm')}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void act('approve', t('approvedNotice'))}
            >
              {t('approve')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </div>
      )}
      {panel === 'cancel' && (
        <ReasonForm
          hint={b.status === 'APPROVED' ? t('cancelApprovedHint') : undefined}
          label={t('cancelReason')}
          submitLabel={t('cancel')}
          backLabel={tc('back')}
          busy={busy}
          onSubmit={(reason) => void act('cancel', t('cancelledNotice'), { reason })}
          onBack={() => setPanel(null)}
        />
      )}

      <dl className="details">
        <dt>{t('supplier')}</dt>
        <dd>
          {can(me, 'suppliers:view') ? (
            <Link href={`/suppliers/${b.supplierId}`}>{b.supplierName}</Link>
          ) : (
            b.supplierName
          )}
        </dd>
        <dt>{t('supplierReference')}</dt>
        <dd dir="ltr">{b.supplierReference ?? '—'}</dd>
        {b.isOpening && (
          <>
            <dt>{t('opening')}</dt>
            <dd>{t('openingHint')}</dd>
          </>
        )}
        <dt>{t('billDate')}</dt>
        <dd dir="ltr">{b.billDate}</dd>
        <dt>{t('dueDate')}</dt>
        <dd dir="ltr">{b.dueDate}</dd>
        <dt>{t('currency')}</dt>
        <dd dir="ltr">{b.currency}</dd>
        <dt>{t('fxRate')}</dt>
        <dd dir="ltr">{b.fxRate}</dd>
        {b.notes && (
          <>
            <dt>{tc('notes')}</dt>
            <dd className="pre">{b.notes}</dd>
          </>
        )}
        {b.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd>{b.cancelReason}</dd>
          </>
        )}
      </dl>

      {b.lines.length > 0 && (
        <>
          <h2>{t('lines')}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('lineKind')}</th>
                  <th>{t('lineFor')}</th>
                  <th>{t('description')}</th>
                  <th>{t('lineAmount')}</th>
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.lineNo}>
                    <td>{l.lineNo}</td>
                    <td>{te(`billLineKind_${l.kind}`)}</td>
                    <td>
                      {l.kind === 'SHIPMENT_COST' && (
                        <>
                          <span dir="ltr">{l.shipmentNumber}</span> · {chargeName(l.chargeTypeCode)}
                        </>
                      )}
                      {l.kind === 'TRIP' &&
                        (can(me, 'transport_trips:view') && l.tripId ? (
                          <Link href={`/trips/${l.tripId}`} dir="ltr">
                            {l.tripNumber}
                          </Link>
                        ) : (
                          <span dir="ltr">{l.tripNumber}</span>
                        ))}
                      {l.kind === 'EXPENSE' && <span dir="ltr">{l.expenseCategoryCode}</span>}
                    </td>
                    <td>{l.description ?? ''}</td>
                    <td dir="ltr">
                      <Money value={l.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <dl className="details totals">
        <dt>{t('total')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={b.total} currency={b.currency} />
          </strong>
        </dd>
        <dt>{t('totalUsd')}</dt>
        <dd dir="ltr">
          <Money value={b.totalUsd} currency="USD" />
        </dd>
        <dt>{t('paid')}</dt>
        <dd dir="ltr">
          <Money value={b.paidAmount} currency={b.currency} />
        </dd>
        <dt>{t('balance')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={b.balance} currency={b.currency} />
          </strong>
        </dd>
      </dl>

      <h2>{t('payments')}</h2>
      {b.payments.length === 0 ? (
        <p className="muted">{t('noPayments')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('payment')}</th>
                <th>{t('paymentDate')}</th>
                <th>{t('lineAmount')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {b.payments.map((p) => (
                <tr key={p.paymentId} className={p.cancelled ? 'inactive' : ''}>
                  <td dir="ltr">
                    {can(me, 'supplier_payments:view') ? (
                      <Link href={`/supplier-payments/${p.paymentId}`}>{p.paymentNumber}</Link>
                    ) : (
                      p.paymentNumber
                    )}
                  </td>
                  <td dir="ltr">{p.paymentDate}</td>
                  <td dir="ltr">
                    <Money value={p.amount} currency={b.currency} />
                  </td>
                  <td>
                    <StatusBadge
                      kind="supplierPayment"
                      status={p.cancelled ? 'CANCELLED' : 'POSTED'}
                    />
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
