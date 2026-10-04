'use client';

import {
  MAX_DOCUMENT_BYTES,
  MAX_POD_PHOTOS,
  type PodDto,
  type ShipmentPodsDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { SignaturePad, type SignaturePadHandle } from './SignaturePad';
import { toIso } from './common';

/** Sends a POD as multipart: its fields, the signature PNG and the photos. */
async function sendPod(shipmentId: string, form: FormData): Promise<PodDto> {
  const res = await fetch(`/api/v1/shipments/${shipmentId}/pods`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { message?: unknown };
      if (typeof data.message === 'string') message = data.message;
    } catch {
      // Not JSON; keep the status text.
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as PodDto;
}

/**
 * Proof of delivery form: recipient and capacity, time, packages, photos and the on-screen
 * signature. The statuses and trips offered come from the API (`actions`); the API checks again.
 */
export function PodForm({
  shipmentId,
  actions,
  tripId,
  onSaved,
  onCancel,
}: {
  shipmentId: string;
  actions: ShipmentPodsDto['actions'];
  /** The trip the form was opened from, preselected. */
  tripId?: string;
  onSaved: (pod: PodDto) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const failure = useFailureText();
  const pad = useRef<SignaturePadHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const onReady = useCallback((handle: SignaturePadHandle) => {
    pad.current = handle;
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const signature = pad.current;
    if (!signature || signature.isEmpty()) {
      setNotice({ ok: false, text: t('signatureRequired') });
      return;
    }
    const photos = f.getAll('photos').filter((p): p is File => p instanceof File && p.size > 0);
    if (photos.length > MAX_POD_PHOTOS) {
      setNotice({ ok: false, text: t('tooManyPhotos', { max: MAX_POD_PHOTOS }) });
      return;
    }
    if (photos.some((p) => p.size > MAX_DOCUMENT_BYTES)) {
      setNotice({ ok: false, text: t('photoTooLarge') });
      return;
    }
    const png = await signature.toPng();
    if (!png) {
      setNotice({ ok: false, text: tc('failed') });
      return;
    }
    const body = new FormData();
    body.set('recipientName', field(f, 'recipientName').trim());
    body.set('recipientCapacity', field(f, 'recipientCapacity').trim());
    const deliveredAt = toIso(field(f, 'deliveredAt'));
    if (deliveredAt) body.set('deliveredAt', deliveredAt);
    body.set('packages', field(f, 'packages').trim());
    body.set('note', field(f, 'note').trim());
    body.set('tripId', field(f, 'tripId'));
    body.set('shipmentStatus', field(f, 'shipmentStatus'));
    body.set('signature', png, 'signature.png');
    for (const photo of photos) body.append('photos', photo, photo.name);
    setBusy(true);
    setNotice(null);
    try {
      onSaved(await sendPod(shipmentId, body));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setNotice({
        ok: false,
        text: status === 413 ? t('photoTooLarge') : status === 400 ? t('podRejected') : failure(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack pod-form" onSubmit={(e) => void onSubmit(e)}>
      <h3>{t('podTitle')}</h3>
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          <span>{t('recipientName')}</span>
          <input name="recipientName" required maxLength={200} autoComplete="off" />
        </label>
        <label className="field">
          <span>{t('recipientCapacity')}</span>
          <input
            name="recipientCapacity"
            required
            maxLength={100}
            placeholder={t('capacityHint')}
          />
        </label>
        <label className="field">
          <span>{t('deliveredAt')}</span>
          <input name="deliveredAt" type="datetime-local" />
        </label>
        <label className="field">
          <span>{t('podPackages')}</span>
          <input name="packages" type="number" min={1} step={1} dir="ltr" inputMode="numeric" />
        </label>
        {actions.trips.length > 0 && (
          <label className="field">
            <span>{t('trip')}</span>
            <select name="tripId" defaultValue={tripId ?? actions.trips[0]?.id ?? ''}>
              {actions.trips.map((trip) => (
                <option key={trip.id} value={trip.id}>
                  {trip.number}
                </option>
              ))}
            </select>
          </label>
        )}
        {actions.statuses.length > 0 && (
          <label className="field">
            <span>{t('podStatus')}</span>
            <select name="shipmentStatus" defaultValue={actions.defaultStatus ?? ''}>
              <option value="">{t('keepStatus')}</option>
              {actions.statuses.map((s) => (
                <option key={s} value={s}>
                  {te(`shipment_${s}`)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="field">
        <span>{t('photos')}</span>
        <input
          name="photos"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
        />
        <span className="muted">{t('photosHint', { max: MAX_POD_PHOTOS })}</span>
      </label>
      <label className="field">
        <span>{t('note')}</span>
        <textarea name="note" maxLength={1000} rows={2} />
      </label>
      <div className="field">
        <span>{t('signature')}</span>
        <SignaturePad onReady={onReady} />
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {t('savePod')}
        </button>
        <button type="button" onClick={onCancel}>
          {tc('back')}
        </button>
      </div>
    </form>
  );
}
