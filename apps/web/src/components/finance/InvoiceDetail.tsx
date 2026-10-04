'use client';

import type { CreateCreditNoteRequest, CreditNoteDto, CustomerInvoiceDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { CreditNoteFields, creditNoteFields } from './CreditNoteDetail';
import { CreditNoteNumber } from './CreditNotes';
import { Money, useRecord } from './common';
import { InvoiceNumber } from './Invoices';
import { PrintLink } from '../print/PrintLink';

type Panel = 'approve' | 'cancel' | 'credit' | null;

export function InvoiceDetail({ id }: { id: string }) {
  const t = useTranslations('Invoices');
  const tc = useTranslations('Common');
  const me = useMe();
  const master = useMasterData();
  const name = useLocalName();
  const failure = useFailureText();
  const router = useRouter();
  const [creditRequestId] = useState(() => crypto.randomUUID());
  const {
    record: invoice,
    notice: loadNotice,
    setRecord,
  } = useRecord<CustomerInvoiceDto>(`/customer-invoices/${id}`);
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!invoice) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function act(action: 'approve' | 'cancel', success: string, body?: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(
        await api<CustomerInvoiceDto>(`/customer-invoices/${id}/${action}`, {
          method: 'POST',
          body,
        }),
      );
      setPanel(null);
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  async function createCreditNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body: CreateCreditNoteRequest = {
      ...creditNoteFields(new FormData(e.currentTarget)),
      requestId: creditRequestId,
      invoiceId: id,
    };
    setBusy(true);
    setNotice(null);
    try {
      const note = await api<CreditNoteDto>('/credit-notes', { method: 'POST', body });
      router.push(`/credit-notes/${note.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  const inv = invoice;
  const chargeName = (code: string) => {
    const charge = master?.chargeTypes.find((c) => c.code === code);
    return charge ? name(charge) : code;
  };

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('invoice')} <InvoiceNumber number={inv.number} />
        </h1>
        <div className="actions">
          <StatusBadge kind="invoice" status={inv.status} />
          {inv.status === 'APPROVED' && <StatusBadge kind="payment" status={inv.paymentStatus} />}
        </div>
      </div>
      <Notice notice={notice} />
      <div className="actions">
        <PrintLink href={`/invoices/${inv.id}`} />
        {inv.actions.canEdit && (
          <Link href={`/invoices/${id}/edit`} className="button">
            {tc('edit')}
          </Link>
        )}
        {inv.actions.canApprove && (
          <button type="button" className="primary" onClick={() => setPanel('approve')}>
            {t('approve')}
          </button>
        )}
        {inv.actions.canCancel && (
          <button type="button" onClick={() => setPanel('cancel')}>
            {t('cancel')}
          </button>
        )}
        {inv.actions.canCreditNote && can(me, 'credit_notes:create') && (
          <button type="button" onClick={() => setPanel('credit')}>
            {t('newCreditNote')}
          </button>
        )}
        {inv.shipmentId && can(me, 'shipments:view') && (
          <Link href={`/shipments/${inv.shipmentId}`} className="button">
            {t('openShipment')} <span dir="ltr">{inv.shipmentNumber}</span>
          </Link>
        )}
        {inv.journalEntryId && can(me, 'manual_journals:view') && (
          <Link href={`/accounting/journals/${inv.journalEntryId}`} className="button">
            {t('openJournal')} <span dir="ltr">{inv.journalEntryNumber}</span>
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
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act('cancel', t('cancelledNotice'), { reason });
          }}
        >
          {inv.status === 'APPROVED' && <p>{t('cancelApprovedHint')}</p>}
          <label className="field">
            {t('cancelReason')}
            <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('cancel')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}

      {panel === 'credit' && (
        <form className="card stack" onSubmit={(e) => void createCreditNote(e)}>
          <p>{t('creditNoteHint')}</p>
          <CreditNoteFields currency={inv.currency} defaultDate={inv.invoiceDate} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('saveCreditNote')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}

      <dl className="details">
        <dt>{t('customer')}</dt>
        <dd>{inv.customerName}</dd>
        {inv.isOpening ? (
          <>
            <dt>{t('openingReference')}</dt>
            <dd dir="ltr">{inv.reference}</dd>
          </>
        ) : (
          <>
            <dt>{t('shipment')}</dt>
            <dd dir="ltr">{inv.shipmentNumber}</dd>
          </>
        )}
        <dt>{t('invoiceDate')}</dt>
        <dd dir="ltr">{inv.invoiceDate}</dd>
        <dt>{t('dueDate')}</dt>
        <dd dir="ltr">{inv.dueDate}</dd>
        <dt>{t('currency')}</dt>
        <dd dir="ltr">{inv.currency}</dd>
        <dt>{t('fxRate')}</dt>
        <dd dir="ltr">{inv.fxRate}</dd>
        {inv.notes && (
          <>
            <dt>{tc('notes')}</dt>
            <dd className="pre">{inv.notes}</dd>
          </>
        )}
        {inv.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd>{inv.cancelReason}</dd>
          </>
        )}
      </dl>

      <h2>{t('lines')}</h2>
      {inv.lines.length === 0 ? (
        <p className="muted">{t('noLines')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('chargeType')}</th>
                <th>{t('quantity')}</th>
                <th>{t('unitPrice')}</th>
                <th>{t('lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.lineNo}</td>
                  <td>
                    {chargeName(l.chargeTypeCode)}
                    {l.description ? <div className="muted">{l.description}</div> : null}
                  </td>
                  <td dir="ltr">{l.quantity}</td>
                  <td dir="ltr">
                    <Money value={l.unitPrice} />
                  </td>
                  <td dir="ltr">
                    <Money value={l.lineTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="details totals">
        <dt>{t('total')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={inv.total} currency={inv.currency} />
          </strong>
        </dd>
        <dt>{t('totalUsd')}</dt>
        <dd dir="ltr">
          <Money value={inv.totalUsd} currency="USD" />
        </dd>
        <dt>{t('paid')}</dt>
        <dd dir="ltr">
          <Money value={inv.paidAmount} currency={inv.currency} />
        </dd>
        <dt>{t('credited')}</dt>
        <dd dir="ltr">
          <Money value={inv.creditedAmount} currency={inv.currency} />
        </dd>
        <dt>{t('balance')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={inv.balance} currency={inv.currency} />
          </strong>
        </dd>
      </dl>

      <h2>{t('payments')}</h2>
      {inv.payments.length === 0 ? (
        <p className="muted">{t('noPayments')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('receipt')}</th>
                <th>{t('receiptDate')}</th>
                <th>{t('amount')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.payments.map((p) => (
                <tr key={p.receiptId} className={p.cancelled ? 'inactive' : ''}>
                  <td dir="ltr">
                    {can(me, 'receipts:view') ? (
                      <Link href={`/receipts/${p.receiptId}`}>{p.receiptNumber}</Link>
                    ) : (
                      p.receiptNumber
                    )}
                  </td>
                  <td dir="ltr">{p.receiptDate}</td>
                  <td dir="ltr">
                    <Money value={p.amount} currency={inv.currency} />
                  </td>
                  <td>
                    <StatusBadge kind="receipt" status={p.cancelled ? 'CANCELLED' : 'POSTED'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>{t('creditNotes')}</h2>
      {inv.creditNotes.length === 0 ? (
        <p className="muted">{t('noCreditNotes')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('creditNote')}</th>
                <th>{t('creditDate')}</th>
                <th>{t('amount')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.creditNotes.map((n) => (
                <tr key={n.creditNoteId} className={n.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td className="nowrap">
                    {can(me, 'credit_notes:view') ? (
                      <Link href={`/credit-notes/${n.creditNoteId}`}>
                        <CreditNoteNumber number={n.number} />
                      </Link>
                    ) : (
                      <CreditNoteNumber number={n.number} />
                    )}
                  </td>
                  <td dir="ltr">{n.creditDate}</td>
                  <td dir="ltr">
                    <Money value={n.amount} currency={inv.currency} />
                  </td>
                  <td>
                    <StatusBadge kind="creditNote" status={n.status} />
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
