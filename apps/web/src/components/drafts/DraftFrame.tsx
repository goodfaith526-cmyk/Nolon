'use client';

import type { DraftStatus, EntryDraftCheck, EntryDraftReviewFields } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { failureStatus } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money, ReasonForm } from '../finance/common';
import { DRAFT_KINDS } from './draft-kinds';

export function DraftStatusBadge({ status }: { status: DraftStatus }) {
  const t = useTranslations('Drafts');
  return <span className={`badge badge-grn-draft badge-${status}`}>{t(`status_${status}`)}</span>;
}

/**
 * The parts every draft review shares: who it was proposed for and when, what NOLON says about
 * it now, the decision, and the entry an approval created. `children` shows the proposed values.
 * Approving sends the version the person is looking at (and `approveBody`, what else they were
 * shown, such as a quotation's prices); NOLON records the entry with its own checks and that
 * person's permissions, or refuses it if anything changed since. A draft that still misses values
 * (`missingFields`, filled in with MissingFields) cannot be approved until NOLON says none is left.
 */
export function DraftFrame<
  D extends EntryDraftReviewFields & { check: EntryDraftCheck | null; missingFields?: string[] },
>({
  draft,
  apiPath,
  title,
  approveHint,
  result,
  approveBody,
  onChanged,
  children,
}: {
  draft: D;
  apiPath: string;
  title: string;
  approveHint: string;
  /** The created entry, once approved: its label and link. */
  result: { label: string; href: string } | null;
  /** Sent with an approval beyond the version; null when the draft cannot be approved now. */
  approveBody?: Record<string, unknown> | null;
  onChanged: (draft: D) => void;
  children: ReactNode;
}) {
  const t = useTranslations('Drafts');
  const page = DRAFT_KINDS.find((k) => k.api === apiPath)?.key;
  const tc = useTranslations('Common');
  const locale = useLocale();
  const failure = useFailureText();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  async function decide(action: 'approve' | 'reject', reason?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const body =
        action === 'approve'
          ? { ...approveBody, version: draft.version }
          : { version: draft.version, reason };
      const saved = await api<D>(`${apiPath}/${draft.id}/${action}`, { method: 'POST', body });
      setRejecting(false);
      setNotice({ ok: true, text: t(action === 'approve' ? 'approvedNotice' : 'rejectedNotice') });
      onChanged(saved);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      // Refused because something changed since the draft was read (another version, or the
      // shipment's invoices): show it as it is now, so the person decides on that.
      if (action === 'approve' && failureStatus(e) === 409) {
        api<D>(`${apiPath}/${draft.id}`)
          .then(onChanged)
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{title}</h1>
        <DraftStatusBadge status={draft.status} />
      </div>
      <p className="muted">
        {t('proposedFor', { name: draft.createdByName })} ·{' '}
        {dateTime.format(new Date(draft.createdAt))} ·{' '}
        {t('expires', { at: dateTime.format(new Date(draft.expiresAt)) })}
      </p>
      <p className="notice">{t('notRecorded')}</p>
      <Notice notice={notice} />
      {draft.status === 'APPROVED' && result && (
        <p>
          {t('approvedBy', { name: draft.decidedByName ?? '' })}{' '}
          <Link href={result.href}>{result.label}</Link>
        </p>
      )}
      {draft.replacesDraftId && page && (
        <p className="muted">
          {t('replacesEarlier')}{' '}
          <Link href={`/drafts/${page}/${draft.replacesDraftId}`}>{t('earlierDraft')}</Link>
        </p>
      )}
      {draft.status === 'REJECTED' &&
        (draft.replacedByDraftId && page ? (
          <p>
            {t('replacedBy')}{' '}
            <Link href={`/drafts/${page}/${draft.replacedByDraftId}`}>{t('newerDraft')}</Link>
          </p>
        ) : (
          <p>
            {t('rejectedBy', { name: draft.decidedByName ?? '', reason: draft.rejectReason ?? '' })}
          </p>
        ))}
      {draft.decidedFromAssistant && <p className="muted">{t('decidedInAssistant')}</p>}
      {draft.check &&
        (draft.check.ok ? (
          <p className="notice ok">
            {t('checkOk')}
            {draft.check.total !== null && (
              <>
                {' '}
                {t('checkTotal')}{' '}
                <Money value={draft.check.total} currency={draft.check.currency ?? undefined} />
              </>
            )}
          </p>
        ) : (
          <p className="error">{t('checkFailed', { message: draft.check.message })}</p>
        ))}
      {children}
      {draft.actions.canDecide &&
        (rejecting ? (
          <ReasonForm
            label={t('rejectReason')}
            submitLabel={t('reject')}
            backLabel={tc('back')}
            busy={busy}
            onSubmit={(reason) => void decide('reject', reason)}
            onBack={() => setRejecting(false)}
          />
        ) : (
          <div className="card stack">
            <p>{approveHint}</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  draft.check?.ok === false ||
                  approveBody === null ||
                  (draft.missingFields ?? []).length > 0
                }
                onClick={() => void decide('approve')}
              >
                {t('approve')}
              </button>
              <button type="button" disabled={busy} onClick={() => setRejecting(true)}>
                {t('reject')}
              </button>
            </div>
          </div>
        ))}
    </section>
  );
}
