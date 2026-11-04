'use client';

import type {
  CsBookingRequestStaffDto,
  CsEstimateRequest,
  MasterDataDto,
  ShippingMode,
} from '@nolon/shared';
import { CS_ESTIMATE_MAX_DAYS } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { field } from '@/lib/form';
import { isPlace, useLocalName } from '@/lib/master-data';
import { ModePicker } from '../commercial/ModePicker';

/**
 * Plan 09 section 12: staff's estimate of a request with an item outside the standard categories,
 * as the customer reads it, and the form for a new version (the customer must accept it before
 * approval; a new version replaces an accepted one). The API checks every rule.
 */
export function BotRequestEstimate({
  request: r,
  master,
  busy,
  onEstimate,
}: {
  request: CsBookingRequestStaffDto;
  master: MasterDataDto | null;
  busy: boolean;
  onEstimate: (body: CsEstimateRequest) => void;
}) {
  const t = useTranslations('BotRequests');
  const e = r.estimate;
  const name = useLocalName();
  const currencies = master?.currencies.filter((c) => c.isActive) ?? [];
  const places = master?.locations.filter((l) => l.isActive && isPlace(l)) ?? [];
  // Codex F171-2: the estimate prices a route and mode staff name with it; approval books them.
  const [mode, setMode] = useState<ShippingMode>(e?.terms?.mode ?? 'SEA');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const until = new Date(field(form, 'validUntil'));
    if (Number.isNaN(until.getTime())) return;
    onEstimate({
      version: r.version,
      amount: field(form, 'amount').trim(),
      currency: field(form, 'currency'),
      terms: {
        originId: field(form, 'originId'),
        destinationId: field(form, 'destinationId'),
        mode,
      },
      noteAr: field(form, 'noteAr').trim() || null,
      noteEn: field(form, 'noteEn').trim() || null,
      validUntil: until.toISOString(),
    });
  }

  if (!e && !r.actions.canEstimate) return null;
  return (
    <div className="card stack">
      <h2>{t('estimateTitle')}</h2>
      {e ? (
        <p>
          <strong dir="ltr">
            {e.amount} {e.currency}
          </strong>{' '}
          <span className="muted">
            {t('estimateVersion', { version: e.version })} ·{' '}
            {t('estimateValidUntil', { date: e.validUntil.slice(0, 16).replace('T', ' ') })} ·{' '}
            {e.acceptedVersion === e.version ? t('estimateAccepted') : t('estimateAwaiting')}
          </span>
        </p>
      ) : (
        <p className="muted">{t('estimateHint')}</p>
      )}
      {r.actions.canEstimate && (
        <form className="form-grid" onSubmit={submit}>
          <label className="field">
            {t('estimateAmount')}
            <input
              name="amount"
              required
              dir="ltr"
              inputMode="decimal"
              pattern="\d{1,14}(\.\d{1,4})?"
            />
          </label>
          <label className="field">
            {t('origin')}
            <select name="originId" required defaultValue={e?.terms?.originId ?? r.originId ?? ''}>
              <option value="" disabled>
                —
              </option>
              {places.map((l) => (
                <option key={l.id} value={l.id}>
                  {name(l)} ({l.code})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('destination')}
            <select
              name="destinationId"
              required
              defaultValue={e?.terms?.destinationId ?? r.destinationId ?? ''}
            >
              <option value="" disabled>
                —
              </option>
              {places.map((l) => (
                <option key={l.id} value={l.id}>
                  {name(l)} ({l.code})
                </option>
              ))}
            </select>
          </label>
          <ModePicker label={t('mode')} value={mode} onChange={setMode} />
          <label className="field">
            {t('priceCurrency')}
            <select name="currency" required defaultValue="">
              <option value="" disabled>
                —
              </option>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('estimateValidUntilLabel', { days: CS_ESTIMATE_MAX_DAYS })}
            <input name="validUntil" type="datetime-local" required dir="ltr" />
          </label>
          <label className="field">
            {t('estimateNoteAr')}
            <textarea name="noteAr" maxLength={500} rows={2} />
          </label>
          <label className="field">
            {t('estimateNoteEn')}
            <textarea name="noteEn" maxLength={500} rows={2} dir="ltr" />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {e ? t('estimateReplace') : t('estimateAction')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
