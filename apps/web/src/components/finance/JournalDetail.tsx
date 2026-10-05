'use client';

import type { JournalEntryDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { MoreMenu } from '../MoreMenu';
import { StatusBadge } from '../StatusBadge';
import { Money, useBranchCode, useRecord } from './common';
import { PrintLink } from '../print/PrintLink';

type Panel = 'post' | 'delete' | 'reverse' | null;

export function JournalDetail({ id }: { id: string }) {
  const t = useTranslations('Journals');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const me = useMe();
  const branchCode = useBranchCode(me);
  const name = useLocalName();
  const router = useRouter();
  const failure = useFailureText();
  const {
    record: entry,
    notice: loadNotice,
    setRecord,
  } = useRecord<JournalEntryDto>(`/accounting/journals/${id}`);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!entry) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const post = () =>
    run(async () => {
      setRecord(await api<JournalEntryDto>(`/accounting/journals/${id}/post`, { method: 'POST' }));
      setPanel(null);
      setNotice({ ok: true, text: t('postedNotice') });
    });

  const remove = () =>
    run(async () => {
      await api(`/accounting/journals/${id}`, { method: 'DELETE' });
      router.push('/accounting/journals');
    });

  function reverse(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const entryDate = field(form, 'entryDate');
    void run(async () => {
      const reversal = await api<JournalEntryDto>(`/accounting/journals/${id}/reverse`, {
        method: 'POST',
        body: { reason: field(form, 'reason'), entryDate: entryDate || undefined },
      });
      router.push(`/accounting/journals/${reversal.id}`);
    });
  }

  const j = entry;
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const sourceLink =
    j.sourceId && j.source === 'CUSTOMER_INVOICE' && can(me, 'customer_invoices:view')
      ? `/invoices/${j.sourceId}`
      : j.sourceId && j.source === 'RECEIPT' && can(me, 'receipts:view')
        ? `/receipts/${j.sourceId}`
        : null;

  return (
    <section className="stack">
      <div className="page-head">
        <div className="title-row">
          <h1>
            {t('entry')} <span dir="ltr">{j.number}</span>
          </h1>
          <StatusBadge kind="journal" status={j.status} />
          {j.reversedById && <span className="badge">{t('reversed')}</span>}
        </div>
        <div className="actions">
          <MoreMenu>
            {sourceLink && (
              <Link href={sourceLink}>
                {te(`journalSource_${j.source}`)} <span dir="ltr">{j.sourceNumber}</span>
              </Link>
            )}
            {j.reversalOfId && (
              <Link href={`/accounting/journals/${j.reversalOfId}`}>
                {t('reversalOf')} <span dir="ltr">{j.reversalOfNumber}</span>
              </Link>
            )}
            {j.reversedById && (
              <Link href={`/accounting/journals/${j.reversedById}`}>
                {t('reversedBy')} <span dir="ltr">{j.reversedByNumber}</span>
              </Link>
            )}
            {j.actions.canReverse && (
              <button type="button" onClick={() => setPanel('reverse')}>
                {t('reverse')}
              </button>
            )}
            {j.actions.canDelete && (
              <button type="button" className="danger" onClick={() => setPanel('delete')}>
                {t('delete')}
              </button>
            )}
          </MoreMenu>
          <PrintLink href={`/journals/${j.id}`} />
          {j.actions.canEdit && (
            <Link href={`/accounting/journals/${id}/edit`} className="button">
              {tc('edit')}
            </Link>
          )}
          {j.actions.canPost && (
            <button type="button" className="primary" onClick={() => setPanel('post')}>
              {t('post')}
            </button>
          )}
        </div>
      </div>
      <Notice notice={notice} />

      {panel === 'post' && (
        <div className="card stack">
          <p>{t('postConfirm')}</p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void post()}>
              {t('post')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </div>
      )}
      {panel === 'delete' && (
        <div className="card stack">
          <p>{t('deleteConfirm')}</p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void remove()}>
              {t('delete')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </div>
      )}
      {panel === 'reverse' && (
        <form className="card stack" onSubmit={reverse}>
          <p>{t('reverseHint')}</p>
          <label className="field">
            {t('reverseReason')}
            <textarea name="reason" required maxLength={1000} />
          </label>
          <label className="field">
            {t('reverseDate')}
            <input type="date" name="entryDate" min={j.entryDate} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('reverse')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}

      <dl className="details">
        <dt>{t('branch')}</dt>
        <dd dir="ltr">{branchCode(j.branchId)}</dd>
        <dt>{t('entryDate')}</dt>
        <dd dir="ltr">{j.entryDate}</dd>
        <dt>{t('source')}</dt>
        <dd>
          {te(`journalSource_${j.source}`)}
          {j.sourceNumber ? (
            <>
              {' '}
              <span dir="ltr">{j.sourceNumber}</span>
            </>
          ) : null}
        </dd>
        <dt>{t('description')}</dt>
        <dd className="pre">{j.description}</dd>
        <dt>{t('totalUsd')}</dt>
        <dd dir="ltr">
          <strong>
            <Money value={j.totalUsd} currency="USD" />
          </strong>
        </dd>
        <dt>{t('createdBy')}</dt>
        <dd>{j.createdByName}</dd>
        {j.postedAt && (
          <>
            <dt>{t('postedBy')}</dt>
            <dd>
              <bdi>{j.postedByName ?? '—'}</bdi> ·{' '}
              <bdi>{dateTime.format(new Date(j.postedAt))}</bdi>
            </dd>
          </>
        )}
      </dl>

      <h2>{t('lines')}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('account')}</th>
              <th>{t('currency')}</th>
              <th>{t('fxRate')}</th>
              <th>{t('debit')}</th>
              <th>{t('credit')}</th>
              <th>{t('debitUsd')}</th>
              <th>{t('creditUsd')}</th>
            </tr>
          </thead>
          <tbody>
            {j.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.lineNo}</td>
                <td>
                  <span dir="ltr">{l.accountCode}</span>{' '}
                  {name({ nameEn: l.accountNameEn, nameAr: l.accountNameAr })}
                  {(l.description || l.customerName || l.shipmentNumber) && (
                    <div className="muted">
                      {[l.description, l.customerName, l.shipmentNumber]
                        .filter((part): part is string => Boolean(part))
                        .map((part, i) => (
                          <span key={i}>
                            {i > 0 ? ' · ' : ''}
                            <bdi>{part}</bdi>
                          </span>
                        ))}
                    </div>
                  )}
                </td>
                <td dir="ltr">{l.currency}</td>
                <td dir="ltr">{l.fxRate}</td>
                <td dir="ltr">{l.debit === '0' ? '' : <Money value={l.debit} />}</td>
                <td dir="ltr">{l.credit === '0' ? '' : <Money value={l.credit} />}</td>
                <td dir="ltr">{l.debitUsd === '0' ? '' : <Money value={l.debitUsd} />}</td>
                <td dir="ltr">{l.creditUsd === '0' ? '' : <Money value={l.creditUsd} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
