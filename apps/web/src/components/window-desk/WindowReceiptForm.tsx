'use client';

import {
  GOODS_CONDITIONS,
  type GoodsCondition,
  type WindowDeskBookingDto,
  type WindowDeskReceiptRequest,
  type WindowDeskReferrerDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

/** Kilograms with up to 3 decimals, as the API takes them. */
const WEIGHT_PATTERN = '\\d{1,9}(\\.\\d{1,3})?';
const VOLUME_PATTERN = '\\d{1,8}(\\.\\d{1,4})?';

/**
 * Plan 13 section 3: the window receives the goods. A goods receipt (GRN) into the booking's
 * window; the API picks the window and moves the shipment. The booking comes back with it.
 */
export function WindowReceiptForm({
  row,
  onReceived,
}: {
  row: WindowDeskBookingDto;
  onReceived: (row: WindowDeskBookingDto) => void;
}) {
  const t = useTranslations('WindowDesk');
  const tw = useTranslations('Warehouse');
  const te = useTranslations('Enums');
  const failure = useFailureText();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const booked = row.items.reduce((sum, i) => sum + i.quantity, 0);
  // Plan 18, 4.3: the referral broker who brought the goods in person, found by name or phone.
  const [brokerQuery, setBrokerQuery] = useState('');
  const [brokers, setBrokers] = useState<WindowDeskReferrerDto[] | null>(null);

  async function findBrokers() {
    try {
      const q = brokerQuery.trim();
      setBrokers(
        await api<WindowDeskReferrerDto[]>(
          `/window-desk/bookings/${row.bookingId}/referrers${q ? `?q=${encodeURIComponent(q)}` : ''}`,
        ),
      );
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const body: WindowDeskReceiptRequest = {
      packages: Number.parseInt(field(f, 'packages'), 10),
      weightKg: field(f, 'weightKg').trim() || null,
      volumeCbm: field(f, 'volumeCbm').trim() || null,
      condition: field(f, 'condition') as GoodsCondition,
      partyName: field(f, 'partyName').trim() || null,
      partyIdType: field(f, 'partyIdType').trim() || null,
      partyIdNumber: field(f, 'partyIdNumber').trim() || null,
      note: field(f, 'note').trim() || null,
      extraPackagesConfirmed: f.get('extraPackagesConfirmed') === 'on',
      broughtByReferrerId: field(f, 'broughtByReferrerId') || null,
    };
    setBusy(true);
    setNotice(null);
    try {
      const next = await api<WindowDeskBookingDto>(
        `/window-desk/bookings/${row.bookingId}/receipt`,
        { method: 'POST', body },
      );
      // The card lists the new GRN with its printout.
      onReceived(next);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
      <h3>{t('receiveTitle')}</h3>
      <Notice notice={notice} />
      <div className="form-grid">
        <label className="field">
          <span>{tw('packages')}</span>
          <input
            name="packages"
            type="number"
            required
            min={1}
            step={1}
            dir="ltr"
            defaultValue={booked > 0 ? booked : undefined}
          />
        </label>
        <label className="field">
          <span>{tw('weightKg')}</span>
          <input name="weightKg" inputMode="decimal" dir="ltr" pattern={WEIGHT_PATTERN} />
        </label>
        <label className="field">
          <span>{tw('volumeCbm')}</span>
          <input name="volumeCbm" inputMode="decimal" dir="ltr" pattern={VOLUME_PATTERN} />
        </label>
        <label className="field">
          <span>{tw('condition')}</span>
          <select name="condition" required defaultValue="GOOD">
            {GOODS_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {te(`condition_${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{tw('deliveredBy')}</span>
          <input name="partyName" maxLength={200} defaultValue={row.sender.name} />
        </label>
        <label className="field">
          <span>{tw('partyIdType')}</span>
          <input name="partyIdType" maxLength={50} />
        </label>
        <label className="field">
          <span>{tw('partyIdNumber')}</span>
          <input name="partyIdNumber" maxLength={50} dir="ltr" />
        </label>
      </div>
      <fieldset className="stack">
        <legend>{t('broughtByBroker')}</legend>
        <div className="row">
          <input
            type="search"
            value={brokerQuery}
            onChange={(e) => setBrokerQuery(e.target.value)}
            placeholder={t('brokerSearch')}
            aria-label={t('brokerSearch')}
            maxLength={60}
          />
          <button type="button" onClick={() => void findBrokers()}>
            {t('brokerFind')}
          </button>
        </div>
        {brokers && (
          <select name="broughtByReferrerId" defaultValue="" aria-label={t('broughtByBroker')}>
            <option value="">{brokers.length > 0 ? t('brokerNone') : t('brokerNotFound')}</option>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.number})
              </option>
            ))}
          </select>
        )}
      </fieldset>
      <label className="field">
        <span>{tw('note')}</span>
        <textarea name="note" maxLength={1000} />
      </label>
      <div className="checks">
        <label>
          <input type="checkbox" name="extraPackagesConfirmed" />
          {t('extraPackages', { booked })}
        </label>
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {tw('issueGrn')}
        </button>
      </div>
    </form>
  );
}
