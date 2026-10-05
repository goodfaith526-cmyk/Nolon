'use client';

import {
  BOOKING_SERVICES,
  CARGO_TYPES,
  LOAD_TYPES,
  SHIPPING_MODES,
  type BookingDto,
  type BookingService,
  type CargoType,
  type CustomerDto,
  type CustomerSummaryDto,
  type LoadType,
  type ShippingMode,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { icons } from '../Icons';
import { CustomerPicker } from './CustomerPicker';
import { Notice, type NoticeState, useFailureText } from './Notice';

interface ItemState {
  key: number;
  cargoType: CargoType;
  containerTypeCode: string;
  description: string;
  quantity: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  weightKg: string;
  volumeCbm: string;
}

let nextKey = 1;
const emptyItem = (cargoType: CargoType): ItemState => ({
  key: nextKey++,
  cargoType,
  containerTypeCode: cargoType === 'CONTAINER' ? '20GP' : '',
  description: '',
  quantity: '1',
  lengthCm: '',
  widthCm: '',
  heightCm: '',
  weightKg: '',
  volumeCbm: '',
});

const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/** New direct booking, or edit of a draft. CBM is computed by the API from the dimensions. */
export function BookingForm({ booking }: { booking?: BookingDto }) {
  const t = useTranslations('Bookings');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();

  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  const [details, setDetails] = useState<CustomerDto | null>(null);
  const [originChoice, setOrigin] = useState(booking?.originLocationId ?? '');
  const [destinationChoice, setDestination] = useState(booking?.destinationLocationId ?? '');
  const [mode, setMode] = useState<ShippingMode>(booking?.mode ?? 'SEA');
  const [loadType, setLoadType] = useState<LoadType>(booking?.loadType ?? 'FCL');
  const [cargoType, setCargoType] = useState<CargoType>(booking?.cargoType ?? 'CONTAINER');
  const [services, setServices] = useState<BookingService[]>(booking?.services ?? ['MAIN_FREIGHT']);
  const [items, setItems] = useState<ItemState[]>(
    booking?.items.map((i) => ({
      key: nextKey++,
      cargoType: i.cargoType,
      containerTypeCode: i.containerTypeCode ?? '',
      description: i.description ?? '',
      quantity: String(i.quantity),
      lengthCm: i.lengthCm ?? '',
      widthCm: i.widthCm ?? '',
      heightCm: i.heightCm ?? '',
      weightKg: i.weightKg ?? '',
      volumeCbm: i.lengthCm ? '' : (i.volumeCbm ?? ''),
    })) ?? [emptyItem('CONTAINER')],
  );
  const [busy, setBusy] = useState(false);

  // Until the user picks, the route defaults to the first two active locations.
  const activeLocations = master?.locations.filter((l) => l.isActive) ?? [];
  const origin = originChoice || (activeLocations[0]?.id ?? '');
  const destination = destinationChoice || (activeLocations[1]?.id ?? '');
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const customerId = booking?.customerId ?? customer?.id;

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    api<CustomerDto>(`/customers/${customerId}`)
      .then((c) => {
        if (!cancelled) setDetails(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  function updateItem(key: number, patch: Partial<ItemState>) {
    setItems((all) => all.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function toggleService(service: BookingService) {
    setServices((all) =>
      all.includes(service) ? all.filter((s) => s !== service) : [...all, service],
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (key: string) => {
      const v = form.get(key);
      return typeof v === 'string' ? orNull(v) : null;
    };
    const body = {
      originLocationId: origin,
      destinationLocationId: destination,
      mode,
      loadType: mode === 'SEA' ? loadType : null,
      cargoType,
      cargoDescription: text('cargoDescription'),
      services,
      shipperId: text('shipperId'),
      consigneeId: text('consigneeId'),
      notifyPartyId: text('notifyPartyId'),
      requestedDeparture: text('requestedDeparture'),
      specialInstructions: text('specialInstructions'),
      items: items.map((i) => ({
        cargoType: i.cargoType,
        containerTypeCode: i.cargoType === 'CONTAINER' ? i.containerTypeCode : null,
        description: orNull(i.description),
        quantity: Number.parseInt(i.quantity, 10),
        lengthCm: orNull(i.lengthCm),
        widthCm: orNull(i.widthCm),
        heightCm: orNull(i.heightCm),
        weightKg: orNull(i.weightKg),
        volumeCbm: orNull(i.volumeCbm),
      })),
    };
    setBusy(true);
    setNotice(null);
    try {
      const saved = booking
        ? await api<BookingDto>(`/bookings/${booking.id}`, { method: 'PATCH', body })
        : await api<BookingDto>('/bookings', {
            method: 'POST',
            body: { ...body, customerId: customer?.id ?? '' },
          });
      router.push(`/bookings/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;
  const locations = master.locations.filter((l) => l.isActive);
  const parties = (details?.id === customerId ? details?.parties : undefined) ?? [];
  const partySelect = (field: 'shipperId' | 'consigneeId' | 'notifyPartyId') => (
    <label className="field">
      {t(field)}
      <select name={field} defaultValue={booking?.[field] ?? ''}>
        <option value="">—</option>
        {parties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form className="stack form-page" onSubmit={(e) => void submit(e)}>
      <h1>{booking ? t('editTitle', { number: booking.number }) : t('add')}</h1>
      <Notice notice={notice} />
      {!booking && (
        <section className="form-section">
          <header>
            <h2>{t('customer')}</h2>
            <p>{t('sectionCustomerHint')}</p>
          </header>
          <div className="form-section-body">
            <CustomerPicker value={customer} onChange={setCustomer} />
          </div>
        </section>
      )}
      <section className="form-section">
        <header>
          <h2>{t('sectionRoute')}</h2>
          <p>{t('sectionRouteHint')}</p>
        </header>
        <div className="form-section-body form-grid">
          <label className="field">
            {t('origin')}
            <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {name(l)} ({l.code})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('destination')}
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {name(l)} ({l.code})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('mode')}
            <select value={mode} onChange={(e) => setMode(e.target.value as ShippingMode)}>
              {SHIPPING_MODES.map((m) => (
                <option key={m} value={m}>
                  {te(`mode_${m}`)}
                </option>
              ))}
            </select>
          </label>
          {mode === 'SEA' && (
            <label className="field">
              {t('loadType')}
              <select value={loadType} onChange={(e) => setLoadType(e.target.value as LoadType)}>
                {LOAD_TYPES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            {t('cargoType')}
            <select value={cargoType} onChange={(e) => setCargoType(e.target.value as CargoType)}>
              {CARGO_TYPES.map((c) => (
                <option key={c} value={c}>
                  {te(`cargo_${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('requestedDeparture')}
            <input
              name="requestedDeparture"
              type="date"
              defaultValue={booking?.requestedDeparture ?? ''}
            />
          </label>
        </div>
      </section>
      <section className="form-section">
        <header>
          <h2>{t('sectionParties')}</h2>
          <p>{t('sectionPartiesHint')}</p>
        </header>
        <div className="form-section-body form-grid">
          {partySelect('shipperId')}
          {partySelect('consigneeId')}
          {partySelect('notifyPartyId')}
        </div>
      </section>
      <section className="form-section">
        <header>
          <h2>{t('services')}</h2>
          <p>{t('servicesHint')}</p>
        </header>
        <div className="form-section-body checks">
          {BOOKING_SERVICES.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={services.includes(s)}
                onChange={() => toggleService(s)}
              />{' '}
              {te(`service_${s}`)}
            </label>
          ))}
        </div>
      </section>

      <section className="form-section wide">
        <header>
          <h2>{t('items')}</h2>
          <p>{t('cbmHint')}</p>
        </header>
        <fieldset className="form-section-body stack bare">
          <legend className="visually-hidden">{t('items')}</legend>
          {items.map((i, index) => (
            <div key={i.key} className="line">
              <span className="muted">{index + 1}</span>
              <label className="field">
                {t('cargoType')}
                <select
                  value={i.cargoType}
                  onChange={(e) => {
                    const next = e.target.value as CargoType;
                    updateItem(i.key, {
                      cargoType: next,
                      containerTypeCode: next === 'CONTAINER' ? '20GP' : '',
                    });
                  }}
                >
                  {CARGO_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {te(`cargo_${c}`)}
                    </option>
                  ))}
                </select>
              </label>
              {i.cargoType === 'CONTAINER' && (
                <label className="field">
                  {t('containerType')}
                  <select
                    value={i.containerTypeCode}
                    onChange={(e) => updateItem(i.key, { containerTypeCode: e.target.value })}
                  >
                    {master.containerTypes
                      .filter((c) => c.isActive)
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {name(c)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label className="field">
                {t('quantity')}
                <input
                  type="number"
                  min={1}
                  required
                  value={i.quantity}
                  onChange={(e) => updateItem(i.key, { quantity: e.target.value })}
                />
              </label>
              {(['lengthCm', 'widthCm', 'heightCm', 'weightKg', 'volumeCbm'] as const).map((k) => (
                <label key={k} className="field">
                  {t(k)}
                  <input
                    inputMode="decimal"
                    dir="ltr"
                    value={i[k]}
                    disabled={k === 'volumeCbm' && i.lengthCm !== ''}
                    onChange={(e) => updateItem(i.key, { [k]: e.target.value })}
                  />
                </label>
              ))}
              <label className="field">
                {t('itemDescription')}
                <input
                  value={i.description}
                  onChange={(e) => updateItem(i.key, { description: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="ghost icon-button line-remove-button"
                aria-label={tc('remove')}
                title={tc('remove')}
                onClick={() => setItems((all) => all.filter((x) => x.key !== i.key))}
              >
                {icons.close}
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="ghost add-line"
              onClick={() => setItems((all) => [...all, emptyItem(cargoType)])}
            >
              {icons.plus}
              <span>{t('addItem')}</span>
            </button>
          </div>
        </fieldset>
      </section>

      <section className="form-section">
        <header>
          <h2>{t('sectionNotes')}</h2>
          <p>{t('sectionNotesHint')}</p>
        </header>
        <div className="form-section-body stack">
          <label className="field">
            {t('cargoDescription')}
            <textarea
              name="cargoDescription"
              rows={2}
              defaultValue={booking?.cargoDescription ?? ''}
            />
          </label>
          <label className="field">
            {t('specialInstructions')}
            <textarea
              name="specialInstructions"
              rows={2}
              defaultValue={booking?.specialInstructions ?? ''}
            />
          </label>
        </div>
      </section>

      <div className="actions form-footer">
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={busy || (!booking && customer === null)}
        >
          {tc('save')}
        </button>
      </div>
    </form>
  );
}
