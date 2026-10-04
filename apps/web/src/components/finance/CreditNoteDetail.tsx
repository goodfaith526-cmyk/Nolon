'use client';

import type { CreditNoteDto, CreditNoteInput } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { AMOUNT_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { CreditNoteNumber } from './CreditNotes';
import { Money, ReasonForm, useRecord } from './common';

/** The credit note fields (date, amount, reason) as the API takes them. */
export function creditNoteFields(form: FormData): CreditNoteInput {
  return {
    creditDate: field(form, 'creditDate'),
    amount: field(form, 'amount').trim(),
    reason: field(form, 'reason').trim(),
  };
}

export function CreditNoteFields({
  currency,
  note,
  defaultDate,
}: {
  currency: string;
  note?: CreditNoteDto;
  defaultDate: string;
}) {
  const t = useTranslations('CreditNotes');
  return (
    <>
      <div className="grid">
        <label className="field">
          {t('creditDate')}
          <input
            name="creditDate"
            type="date"
            required
            defaultValue={note?.creditDate ?? defaultDate}
          />
        </label>
        <label className="field">
          {t('amountIn', { currency })}
          <input
            name="amount"
            required
            inputMode="decimal"
            dir="ltr"
            pattern={AMOUNT_PATTERN}
            defaultValue={note?.amount ?? ''}
          />
        </label>
      </div>
      <label className="field">
        {t('reason')}
        <textarea name="reason" required maxLength={1000} defaultValue={note?.reason ?? ''} />
      </label>
    </>
  );
}

type Panel = 'edit' | 'approve' | 'cancel' | null;

export function CreditNoteDetail({ id }: { id: string }) {
  const t = useTranslations('CreditNotes');
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const {
    record: note,
    notice: loadNotice,
    setRecord,
  } = useRecord<CreditNoteDto>(`/credit-notes/${id}`);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!note) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function run(path: string, method: 'POST' | 'PATCH', success: string, body?: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await api<CreditNoteDto>(path, { method, body }));
      setPanel(null);
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void run(
      `/credit-notes/${id}`,
      'PATCH',
      tc('saved'),
      creditNoteFields(new FormData(e.currentTarget)),
    );
  }

  const n = note;
  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('creditNote')} <CreditNoteNumber number={n.number} />
        </h1>
        <StatusBadge kind="creditNote" status={n.status} />
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {n.actions.canEdit && (
          <button type="button" onClick={() => setPanel('edit')}>
            {tc('edit')}
          </button>
        )}
        {n.actions.canApprove && (
          <button type="button" className="primary" onClick={() => setPanel('approve')}>
            {t('approve')}
          </button>
        )}
        {n.actions.canCancel && (
          <button type="button" onClick={() => setPanel('cancel')}>
            {t('cancel')}
          </button>
        )}
        {can(me, 'customer_invoices:view') && (
          <Link href={`/invoices/${n.invoiceId}`} className="button">
            {t('openInvoice')} <span dir="ltr">{n.invoiceNumber}</span>
          </Link>
        )}
        {n.journalEntryId && can(me, 'manual_journals:view') && (
          <Link href={`/accounting/journals/${n.journalEntryId}`} className="button">
            {t('openJournal')} <span dir="ltr">{n.journalEntryNumber}</span>
          </Link>
        )}
      </div>

      {panel === 'edit' && (
        <form className="card stack" onSubmit={save}>
          <CreditNoteFields currency={n.currency} note={n} defaultDate={n.creditDate} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}
      {panel === 'approve' && (
        <div className="card stack">
          <p>{t('approveConfirm')}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void run(`/credit-notes/${id}/approve`, 'POST', t('approvedNotice'))}
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
          label={t('cancelReason')}
          submitLabel={t('cancel')}
          backLabel={tc('back')}
          busy={busy}
          onSubmit={(reason) =>
            void run(`/credit-notes/${id}/cancel`, 'POST', t('cancelledNotice'), { reason })
          }
          onBack={() => setPanel(null)}
        />
      )}

      <dl className="details">
        <dt>{t('customer')}</dt>
        <dd>{n.customerName}</dd>
        <dt>{t('creditDate')}</dt>
        <dd dir="ltr">{n.creditDate}</dd>
        <dt>{t('amount')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={n.amount} currency={n.currency} />
          </strong>
        </dd>
        <dt>{t('fxRate')}</dt>
        <dd dir="ltr">{n.fxRate}</dd>
        {n.amountUsd !== null && (
          <>
            <dt>{t('amountUsd')}</dt>
            <dd dir="ltr">
              <Money value={n.amountUsd} currency="USD" />
            </dd>
          </>
        )}
        <dt>{t('invoiceBalance')}</dt>
        <dd dir="ltr">
          <Money value={n.invoiceBalance} currency={n.currency} />
        </dd>
        <dt>{t('reason')}</dt>
        <dd className="pre">{n.reason}</dd>
        {n.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd>{n.cancelReason}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
