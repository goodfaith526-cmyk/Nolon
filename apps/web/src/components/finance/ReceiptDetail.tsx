'use client';

import type { ApplyReceiptRequest, ReceiptApplicableInvoiceDto, ReceiptDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { branchToday } from '@/lib/branches';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { AMOUNT_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { MoreMenu } from '../MoreMenu';
import { StatusBadge } from '../StatusBadge';
import { Money, ReasonForm, useRecord } from './common';
import { PrintLink } from '../print/PrintLink';

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
  /** Open invoices the advance can go to, loaded when the apply panel opens. */
  const [applicable, setApplicable] = useState<ReceiptApplicableInvoiceDto[] | null>(null);
  const [applyRequestId, setApplyRequestId] = useState(() => crypto.randomUUID());
  const [reversing, setReversing] = useState<string | null>(null);

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

  async function openApply() {
    setNotice(null);
    setCancelling(false);
    setReversing(null);
    try {
      setApplicable(
        await api<ReceiptApplicableInvoiceDto[]>(`/receipts/${id}/applicable-invoices`),
      );
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  async function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: ApplyReceiptRequest = {
      requestId: applyRequestId,
      invoiceId: field(form, 'invoiceId'),
      amount: field(form, 'amount').trim(),
      applicationDate: field(form, 'applicationDate'),
    };
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await api<ReceiptDto>(`/receipts/${id}/applications`, { method: 'POST', body }));
      setApplicable(null);
      setApplyRequestId(crypto.randomUUID());
      setNotice({ ok: true, text: t('appliedNotice') });
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  async function reverseApplication(applicationId: string, why: string) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(
        await api<ReceiptDto>(`/receipts/${id}/applications/${applicationId}/reverse`, {
          method: 'POST',
          body: { reason: why },
        }),
      );
      setReversing(null);
      setNotice({ ok: true, text: t('applicationReversedNotice') });
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  const r = receipt;
  const journals = can(me, 'manual_journals:view');
  const hasActiveApplication = r.applications.some((a) => a.status === 'ACTIVE');

  return (
    <section className="stack">
      <div className="page-head">
        <div className="title-row">
          <h1>
            {t('receipt')} <span dir="ltr">{r.number}</span>
          </h1>
          <StatusBadge kind="receipt" status={r.status} />
        </div>
        <div className="actions">
          <MoreMenu>
            {journals && (
              <Link href={`/accounting/journals/${r.journalEntryId}`}>
                {t('openJournal')} <span dir="ltr">{r.journalEntryNumber}</span>
              </Link>
            )}
            {journals && r.cancelJournalEntryId && (
              <Link href={`/accounting/journals/${r.cancelJournalEntryId}`}>
                {t('openCancelJournal')} <span dir="ltr">{r.cancelJournalEntryNumber}</span>
              </Link>
            )}
            {r.actions.canApply && (
              <button type="button" onClick={() => void openApply()}>
                {t('applyAdvance')}
              </button>
            )}
            {r.actions.canCancel && (
              <button type="button" className="danger" onClick={() => setCancelling(true)}>
                {t('cancel')}
              </button>
            )}
          </MoreMenu>
          <PrintLink href={`/receipts/${r.id}`} />
        </div>
      </div>
      <Notice notice={notice} />
      {r.status === 'POSTED' && hasActiveApplication && can(me, 'receipts:cancel') && (
        <p className="muted">{t('cancelNeedsReversal')}</p>
      )}
      {applicable && (
        <form className="card stack" onSubmit={(e) => void apply(e)}>
          <p>{t('applyHint', { amount: r.unallocated, currency: r.currency })}</p>
          {applicable.length === 0 ? (
            <p className="muted">{t('noApplicableInvoices')}</p>
          ) : (
            <div className="grid">
              <label className="field">
                {t('invoice')}
                <select name="invoiceId" required defaultValue="">
                  <option value="" disabled>
                    {t('chooseInvoice')}
                  </option>
                  {applicable.map((i) => (
                    <option key={i.invoiceId} value={i.invoiceId}>
                      {t('applicableInvoice', {
                        number: i.invoiceNumber,
                        date: i.invoiceDate,
                        balance: i.balance,
                        currency: r.currency,
                      })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {t('applyAmount', { currency: r.currency })}
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  dir="ltr"
                  pattern={AMOUNT_PATTERN}
                />
              </label>
              <label className="field">
                {t('applicationDate')}
                <input
                  name="applicationDate"
                  type="date"
                  required
                  defaultValue={branchToday(me, r.branchId)}
                />
              </label>
            </div>
          )}
          <div className="actions">
            {applicable.length > 0 && (
              <button type="submit" className="primary" disabled={busy}>
                {t('applyAdvance')}
              </button>
            )}
            <button type="button" onClick={() => setApplicable(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}
      {reversing && (
        <ReasonForm
          hint={t('reverseApplicationHint')}
          label={t('reverseReason')}
          submitLabel={t('reverseApplication')}
          backLabel={tc('back')}
          busy={busy}
          onSubmit={(why) => void reverseApplication(reversing, why)}
          onBack={() => setReversing(null)}
        />
      )}
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
        <dt>{t('applied')}</dt>
        <dd dir="ltr">
          <Money value={r.applied} currency={r.currency} />
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

      <h2>{t('applications')}</h2>
      {r.applications.length === 0 ? (
        <p className="muted">{t('noApplications')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('invoice')}</th>
                <th>{t('applicationDate')}</th>
                <th>{t('appliedAmount')}</th>
                <th>{t('advanceUsd')}</th>
                <th>{t('relievedUsd')}</th>
                <th>{tc('status')}</th>
                {journals && <th>{t('openJournal')}</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {r.applications.map((a) => (
                <tr key={a.id} className={a.status === 'REVERSED' ? 'inactive' : ''}>
                  <td dir="ltr">
                    {can(me, 'customer_invoices:view') ? (
                      <Link href={`/invoices/${a.invoiceId}`}>{a.invoiceNumber}</Link>
                    ) : (
                      a.invoiceNumber
                    )}
                  </td>
                  <td dir="ltr">{a.applicationDate}</td>
                  <td dir="ltr">
                    <Money value={a.amount} currency={r.currency} />
                  </td>
                  <td dir="ltr">
                    <Money value={a.advanceUsd} currency="USD" />
                  </td>
                  <td dir="ltr">
                    <Money value={a.relievedUsd} currency="USD" />
                  </td>
                  <td>
                    {t(`applicationStatus_${a.status}`)}
                    {a.reverseReason && <div className="muted">{a.reverseReason}</div>}
                  </td>
                  {journals && (
                    <td dir="ltr">
                      <Link href={`/accounting/journals/${a.journalEntryId}`}>
                        {a.journalEntryNumber}
                      </Link>
                      {a.reverseJournalEntryId && (
                        <div>
                          <Link href={`/accounting/journals/${a.reverseJournalEntryId}`}>
                            {a.reverseJournalEntryNumber}
                          </Link>
                        </div>
                      )}
                    </td>
                  )}
                  <td>
                    {a.status === 'ACTIVE' && r.actions.canReverseApplication && (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setApplicable(null);
                          setCancelling(false);
                          setReversing(a.id);
                        }}
                      >
                        {t('reverseApplication')}
                      </button>
                    )}
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
