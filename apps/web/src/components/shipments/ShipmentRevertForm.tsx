'use client';

import { type RevertStepDto, SHIPMENT_REASON_MIN_LENGTH, type ShipmentStatus } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { field } from '@/lib/form';

/** Ready reasons for going back a status; OTHER asks for the reason in words. */
const REVERT_REASONS = ['WRONG_SHIPMENT', 'WRONG_STATUS', 'WRONG_TIME', 'OTHER'] as const;
type RevertReason = (typeof REVERT_REASONS)[number];

/**
 * Going back a status. The form is bound to the step it was opened on: it only ever sends that
 * step's event, and once the shipment's step to undo is another one (a refresh after another
 * user's change), it shows nothing to confirm, so a confirmation never carries over to another
 * step. The user closes it and opens it again on the step shown then.
 */
export function ShipmentRevertForm({
  step,
  to,
  busy,
  onRevert,
  onTooShort,
  onBack,
}: {
  /** The step a revert would undo now (null when there is none). */
  step: RevertStepDto | null;
  to: ShipmentStatus | null;
  busy: boolean;
  onRevert: (reason: string, undoEventId: string) => void;
  onTooShort: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const [shown] = useState(step);
  const [reasonKind, setReasonKind] = useState<RevertReason>('WRONG_SHIPMENT');
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  if (!shown || !to || step?.eventId !== shown.eventId) {
    return (
      <div className="card stack">
        <p className="warning">{t('revertTargetChanged')}</p>
        <div className="actions">
          <button type="button" onClick={onBack}>
            {tc('back')}
          </button>
        </div>
      </div>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>, undoEventId: string) {
    event.preventDefault();
    const details = field(new FormData(event.currentTarget), 'reason').trim();
    if (reasonKind === 'OTHER') {
      if (details.length < SHIPMENT_REASON_MIN_LENGTH) {
        onTooShort();
        return;
      }
      onRevert(details, undoEventId);
      return;
    }
    const preset = t(`revertReason_${reasonKind}`);
    onRevert(details ? `${preset}: ${details}` : preset, undoEventId);
  }

  return (
    <form className="card stack" onSubmit={(e) => submit(e, shown.eventId)}>
      <p>
        {t('revertUndoes', {
          status: te(`shipment_${shown.status}`),
          user: shown.userName ?? '—',
          time: dateTime.format(new Date(shown.occurredAt)),
          to: te(`shipment_${to}`),
        })}
      </p>
      {!shown.byMe && (
        <>
          <p className="warning">{t('revertOthersStep', { user: shown.userName ?? '—' })}</p>
          <div className="checks">
            <label>
              <input type="checkbox" name="confirmOthers" required />
              {t('revertConfirmOthers')}
            </label>
          </div>
        </>
      )}
      <label className="field">
        <span>{t('revertReason')}</span>
        <select value={reasonKind} onChange={(e) => setReasonKind(e.target.value as RevertReason)}>
          {REVERT_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`revertReason_${r}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{reasonKind === 'OTHER' ? t('revertReasonOther') : t('revertDetails')}</span>
        <textarea
          name="reason"
          required={reasonKind === 'OTHER'}
          minLength={reasonKind === 'OTHER' ? SHIPMENT_REASON_MIN_LENGTH : undefined}
          maxLength={900}
        />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {t('revert')}
        </button>
        <button type="button" onClick={onBack}>
          {tc('back')}
        </button>
      </div>
    </form>
  );
}
