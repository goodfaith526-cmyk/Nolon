'use client';

import type { WarehouseDto, WarehouseUpdateRequest } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { field } from '@/lib/form';
import { PartnerSelect, partnerChange } from '../partners/PartnerSelect';

/**
 * A facility's customer-facing details (plan 09 section 11): whether customers may bring their
 * shipments here, the addresses, opening hours, phone, map link and position, and the sales
 * outlet a window belongs to. The bot names an active point to the customer once a request is
 * approved; the API checks every field on save.
 */
export function DropOffEditor({
  warehouse: w,
  busy,
  onSave,
}: {
  warehouse: WarehouseDto;
  busy: boolean;
  onSave: (body: WarehouseUpdateRequest) => void;
}) {
  const t = useTranslations('Warehouse');
  const [partner, setPartner] = useState(w.partner?.id ?? '');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => field(form, name).trim() || null;
    const partnerId = partnerChange(w.partner, partner);
    onSave({
      acceptsDropOff: form.get('acceptsDropOff') === 'on',
      address: text('address'),
      addressEn: text('addressEn'),
      hoursAr: text('hoursAr'),
      hoursEn: text('hoursEn'),
      phone: text('phone'),
      mapUrl: text('mapUrl'),
      latitude: text('latitude'),
      longitude: text('longitude'),
      ...(partnerId !== undefined ? { partnerId } : {}),
    });
  }

  return (
    <details className="panel-body">
      <summary>{t('dropOffTitle')}</summary>
      <p className="muted">{t('dropOffHint')}</p>
      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          <span>
            <input type="checkbox" name="acceptsDropOff" defaultChecked={w.acceptsDropOff} />{' '}
            {t('acceptsDropOff')}
          </span>
        </label>
        <label className="field">
          <span>{t('addressAr')}</span>
          <input name="address" maxLength={500} defaultValue={w.address ?? ''} />
        </label>
        <label className="field">
          <span>{t('addressEn')}</span>
          <input name="addressEn" maxLength={500} dir="ltr" defaultValue={w.addressEn ?? ''} />
        </label>
        <label className="field">
          <span>{t('hoursAr')}</span>
          <input name="hoursAr" maxLength={200} defaultValue={w.hoursAr ?? ''} />
        </label>
        <label className="field">
          <span>{t('hoursEn')}</span>
          <input name="hoursEn" maxLength={200} dir="ltr" defaultValue={w.hoursEn ?? ''} />
        </label>
        <label className="field">
          <span>{t('phone')}</span>
          <input
            name="phone"
            dir="ltr"
            inputMode="tel"
            pattern="\+[1-9][0-9]{7,14}"
            placeholder="+249912345678"
            defaultValue={w.phone ?? ''}
          />
        </label>
        <label className="field">
          <span>{t('mapUrl')}</span>
          <input
            name="mapUrl"
            type="url"
            dir="ltr"
            maxLength={500}
            pattern="https://.+"
            defaultValue={w.mapUrl ?? ''}
          />
        </label>
        <label className="field">
          <span>{t('latitude')}</span>
          <input name="latitude" dir="ltr" inputMode="decimal" defaultValue={w.latitude ?? ''} />
        </label>
        <label className="field">
          <span>{t('longitude')}</span>
          <input name="longitude" dir="ltr" inputMode="decimal" defaultValue={w.longitude ?? ''} />
        </label>
        <label className="field">
          <span>{t('outlet')}</span>
          <PartnerSelect
            kind="SALES_OUTLET"
            branchIds={[w.branchId]}
            held={w.partner}
            value={partner}
            onChange={setPartner}
            disabled={busy}
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy}>
            {t('saveDropOff')}
          </button>
        </div>
      </form>
    </details>
  );
}
