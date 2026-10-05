'use client';

import type { ExpenseDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { ExpenseNumber } from './Expenses';
import { Money, ReasonForm, useBranchCode, useRecord } from './common';

type Panel = 'approve' | 'cancel' | null;

export function ExpenseDetail({ id }: { id: string }) {
  const t = useTranslations('Expenses');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const branchCode = useBranchCode(me);
  const failure = useFailureText();
  const {
    record: expense,
    notice: loadNotice,
    setRecord,
  } = useRecord<ExpenseDto>(`/expenses/${id}`);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!expense) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function act(action: 'approve' | 'cancel', success: string, body?: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await api<ExpenseDto>(`/expenses/${id}/${action}`, { method: 'POST', body }));
      setPanel(null);
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const x = expense;
  const journals = can(me, 'manual_journals:view');

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('expense')} <ExpenseNumber number={x.number} />
        </h1>
        <StatusBadge kind="expense" status={x.status} />
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {x.actions.canEdit && (
          <Link href={`/expenses/${id}/edit`} className="button">
            {tc('edit')}
          </Link>
        )}
        {x.actions.canApprove && (
          <button type="button" className="primary" onClick={() => setPanel('approve')}>
            {t('approve')}
          </button>
        )}
        {x.actions.canCancel && (
          <button type="button" onClick={() => setPanel('cancel')}>
            {t('cancel')}
          </button>
        )}
        {journals && x.journalEntryId && (
          <Link href={`/accounting/journals/${x.journalEntryId}`} className="button">
            {t('openJournal')} <span dir="ltr">{x.journalEntryNumber}</span>
          </Link>
        )}
        {journals && x.cancelJournalEntryId && (
          <Link href={`/accounting/journals/${x.cancelJournalEntryId}`} className="button">
            {t('openCancelJournal')} <span dir="ltr">{x.cancelJournalEntryNumber}</span>
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
          hint={x.status === 'APPROVED' ? t('cancelApprovedHint') : undefined}
          label={t('cancelReason')}
          submitLabel={t('cancel')}
          backLabel={tc('back')}
          busy={busy}
          onSubmit={(reason) => void act('cancel', t('cancelledNotice'), { reason })}
          onBack={() => setPanel(null)}
        />
      )}

      <dl className="details">
        <dt>{t('branch')}</dt>
        <dd dir="ltr">{branchCode(x.branchId)}</dd>
        <dt>{t('expenseDate')}</dt>
        <dd dir="ltr">{x.expenseDate}</dd>
        <dt>{t('category')}</dt>
        <dd dir="ltr">{x.categoryCode}</dd>
        <dt>{t('description')}</dt>
        <dd>{x.description}</dd>
        <dt>{t('amount')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={x.amount} currency={x.currency} />
          </strong>
        </dd>
        <dt>{t('fxRate')}</dt>
        <dd dir="ltr">{x.fxRate}</dd>
        <dt>{t('cashAccount')}</dt>
        <dd>
          <span dir="ltr">{x.cashAccountCode}</span>{' '}
          {name({ nameEn: x.cashAccountNameEn, nameAr: x.cashAccountNameAr })}
        </dd>
        <dt>{t('reference')}</dt>
        <dd dir="ltr">{x.reference ?? '—'}</dd>
        {x.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd>{x.cancelReason}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
