'use client';

import {
  BOOKING_SERVICES,
  cbmOf,
  hasSeaLeg,
  type BookingDto,
  type BookingFromQuotationPreviewDto,
  type BookingItemInput,
  type BookingPartySuggestionDto,
  type BookingService,
  type CargoType,
  type ConsolidationBookingDto,
  type ConsolidationDto,
  type CreateFormReviewRequest,
  type CustomerDto,
  type CustomerSummaryDto,
  type ShippingMode,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { asciiDigits } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { icons } from '../Icons';
import { can, useMe } from '../StaffShell';
import { cargoChoices } from './cargo';
import { CustomerPicker } from './CustomerPicker';
import { ModePicker } from './ModePicker';
import { FormDialog } from './FormDialog';
import {
  invalidFields,
  invalidGroupProps,
  invalidProps,
  Notice,
  type NoticeState,
  revealFailure,
  useFailureText,
  FieldNote,
  fieldNote,
  type FieldNoteState,
  useRefusalReason,
} from './Notice';
import { PartyForm } from './PartyForm';
import { refusedForm, ReviewWithAssistant } from './ReviewWithAssistant';

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
const itemState = (i: BookingItemInput): ItemState => ({
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
});
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

const DIMENSIONS: readonly string[] = ['lengthCm', 'widthCm', 'heightCm'];
const hasDimensions = (i: ItemState) => i.lengthCm !== '' || i.widthCm !== '' || i.heightCm !== '';

const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/** The services to choose from: every booking carries the main freight, so it is not one. */
const CHOSEN_SERVICES = BOOKING_SERVICES.filter((s) => s !== 'MAIN_FREIGHT');

type PartyField = 'shipperId' | 'consigneeId' | 'notifyPartyId';
const PARTY_FIELDS: readonly PartyField[] = ['shipperId', 'consigneeId', 'notifyPartyId'];

/**
 * New direct booking, or edit of a draft. CBM is computed by the API from the dimensions, and
 * shown as they are typed (the same rounding, from @nolon/shared). With
 * `consolidation`, an LCL sea booking from that container's port of loading: saving confirms it
 * and puts its shipment in the container. With `fromQuotation`, a booking from an approved
 * quotation (functional review B1): the form opens filled from the quotation's preview, nothing is
 * created until the person saves, and route, mode, load type and cargo stay the quotation's.
 */
export function BookingForm({
  booking,
  consolidation,
  fromQuotation,
}: {
  booking?: BookingDto;
  consolidation?: ConsolidationDto;
  fromQuotation?: BookingFromQuotationPreviewDto;
}) {
  const t = useTranslations('Bookings');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();
  const me = useMe();

  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  const [details, setDetails] = useState<CustomerDto | null>(null);
  // What the form starts from: the booking edited, or the quotation's preview.
  const initial = booking ?? fromQuotation;
  const [originChoice, setOrigin] = useState(initial?.originLocationId ?? '');
  const [destinationChoice, setDestination] = useState(
    initial?.destinationLocationId ?? consolidation?.destinationLocationId ?? '',
  );
  const [mode, setMode] = useState<ShippingMode>(initial?.mode ?? 'SEA');
  const [services, setServices] = useState<BookingService[]>(
    booking?.services.filter((s) => s !== 'MAIN_FREIGHT') ?? [],
  );
  // From a quotation: the container lines its per-container charges name (the API's preview).
  const [items, setItems] = useState<ItemState[]>(() => {
    if (booking) return booking.items.map(itemState);
    if (fromQuotation && fromQuotation.items.length > 0) return fromQuotation.items.map(itemState);
    return [emptyItem(fromQuotation?.cargoType ?? (consolidation ? 'PALLET' : 'CONTAINER'))];
  });
  const [busy, setBusy] = useState(false);
  // A new booking's parties (functional review B5): suggested by GET /bookings/party-suggestion
  // when the customer is picked (or with a quotation's preview): the parties of the customer's
  // last booking, or its only party. Shown with where they come from; a party the person picked
  // is kept; picking another customer drops the suggestion; the API checks each party on save.
  const [suggestion, setSuggestion] = useState<BookingPartySuggestionDto | null>(
    fromQuotation?.parties ?? null,
  );
  const [partyIds, setPartyIds] = useState<Record<PartyField, string>>({
    shipperId: booking?.shipperId ?? fromQuotation?.parties.shipperId ?? '',
    consigneeId: booking?.consigneeId ?? fromQuotation?.parties.consigneeId ?? '',
    notifyPartyId: booking?.notifyPartyId ?? fromQuotation?.parties.notifyPartyId ?? '',
  });
  const [addingParty, setAddingParty] = useState<PartyField | null>(null);
  // The party fields the person set or cleared since the customer was picked: a suggestion that
  // arrives later fills only the others (Codex F93-3). Reset when the customer changes.
  const touchedParties = useRef(new Set<PartyField>());

  // The route starts empty on a new booking: the person picks it (functional review B6).
  const origin = consolidation?.originLocationId ?? originChoice;
  const destination = destinationChoice;
  const [notice, setNotice] = useState<NoticeState | null>(null);
  // What the last refused save sent, for "Review with the assistant".
  const [refused, setRefused] = useState<CreateFormReviewRequest | null>(null);
  // The fields the last refused save named, marked on the form until the next save.
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  // Why it was refused, said under the first field the API named.
  const [note, setNote] = useState<FieldNoteState | null>(null);
  const refusalReason = useRefusalReason();
  const formRef = useRef<HTMLFormElement>(null);
  const mark = (path: string) => invalidProps(invalid, path);
  const markGroup = (path: string) => invalidGroupProps(invalid, path);
  useEffect(() => {
    if (notice && !notice.ok) revealFailure(formRef.current);
  }, [notice, invalid]);

  const customerId = booking?.customerId ?? fromQuotation?.customerId ?? customer?.id;
  // A booking from a quotation keeps the quotation's route and mode (the API refuses a change).
  const quoted = Boolean(booking?.quotationId) || fromQuotation !== undefined;
  // The customer the form is on now: a party saved for an earlier one is not applied.
  const currentCustomer = useRef(customerId);
  useEffect(() => {
    currentCustomer.current = customerId;
  }, [customerId]);

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

  // Only a customer picked on this form asks for a suggestion (an edit has its parties).
  const pickedCustomerId = customer?.id;
  useEffect(() => {
    if (!pickedCustomerId) return;
    let cancelled = false;
    api<BookingPartySuggestionDto>(`/bookings/party-suggestion?customerId=${pickedCustomerId}`)
      .then((s) => {
        if (cancelled || s.customerId !== pickedCustomerId) return;
        setSuggestion(s);
        const touched = touchedParties.current;
        const fill = (all: Record<PartyField, string>, f: PartyField) =>
          touched.has(f) ? all[f] : all[f] || (s[f] ?? '');
        setPartyIds((all) => ({
          shipperId: fill(all, 'shipperId'),
          consigneeId: fill(all, 'consigneeId'),
          notifyPartyId: fill(all, 'notifyPartyId'),
        }));
      })
      // No suggestion (no permission to create bookings, say): the parties start empty.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pickedCustomerId]);

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
    // A container's booking takes its port of loading, mode and load type from the container.
    const fields = {
      destinationLocationId: destination,
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
    const body = {
      ...fields,
      originLocationId: origin,
      mode,
    };
    setBusy(true);
    setNotice(null);
    setInvalid(new Set());
    setNote(null);
    setRefused(null);
    if (fromQuotation) {
      // The quotation gives the customer, route, mode, load type and cargo.
      const fromBody = {
        services,
        shipperId: fields.shipperId,
        consigneeId: fields.consigneeId,
        notifyPartyId: fields.notifyPartyId,
        requestedDeparture: fields.requestedDeparture,
        specialInstructions: fields.specialInstructions,
        items: fields.items,
      };
      try {
        const saved = await api<BookingDto>(
          `/bookings/from-quotation/${fromQuotation.quotationId}`,
          { method: 'POST', body: fromBody },
        );
        router.push(`/bookings/${saved.id}`);
      } catch (err) {
        setNotice({ ok: false, text: failure(err) });
        setInvalid(invalidFields(err));
        setNote(fieldNote(err, refusalReason(err)));
        setBusy(false);
      }
      return;
    }
    const sent = consolidation
      ? { ...fields, customerId: customer?.id ?? '' }
      : booking
        ? body
        : { ...body, customerId: customer?.id ?? '' };
    try {
      if (consolidation) {
        await api<ConsolidationBookingDto>(`/consolidations/${consolidation.id}/bookings`, {
          method: 'POST',
          body: sent,
        });
        router.push(`/consolidations/${consolidation.id}`);
        return;
      }
      const saved = booking
        ? await api<BookingDto>(`/bookings/${booking.id}`, { method: 'PATCH', body: sent })
        : await api<BookingDto>('/bookings', { method: 'POST', body: sent });
      router.push(`/bookings/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setInvalid(invalidFields(err));
      setNote(fieldNote(err, refusalReason(err)));
      setRefused(
        refusedForm(err, {
          form: 'booking',
          mode: consolidation ? 'container' : booking ? 'edit' : 'create',
          values: sent,
          customerName: customer?.name ?? null,
        }),
      );
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;
  const locations = master.locations.filter((l) => l.isActive);
  const parties = (details?.id === customerId ? details?.parties : undefined) ?? [];
  // The suggestion's source, said while a suggested party is still selected.
  const suggestedNote = (() => {
    if (!suggestion || suggestion.customerId !== customerId || suggestion.source === null) {
      return null;
    }
    const kept = PARTY_FIELDS.some((f) => suggestion[f] !== null && partyIds[f] === suggestion[f]);
    if (!kept) return null;
    return suggestion.source === 'LAST_BOOKING'
      ? t('partiesFromLastBooking', { number: suggestion.bookingNumber ?? '' })
      : t('partiesFromOnlyParty');
  })();
  const mayAddParty = !!customerId && details?.id === customerId && can(me, 'customers:update');
  const partySelect = (field: PartyField) => (
    <label className="field">
      {t(field)}
      <span className="row">
        <select
          name={field}
          {...mark(field)}
          value={partyIds[field]}
          onChange={(e) => {
            touchedParties.current.add(field);
            setPartyIds((all) => ({ ...all, [field]: e.target.value }));
          }}
        >
          <option value="">—</option>
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {mayAddParty && (
          <button type="button" onClick={() => setAddingParty(field)}>
            {t('addNewParty')}
          </button>
        )}
      </span>
      <FieldNote note={note} path={field} />
    </label>
  );

  return (
    <form ref={formRef} className="stack form-page" onSubmit={(e) => void submit(e)}>
      <h1>
        {booking
          ? t('editTitle', { number: booking.number })
          : fromQuotation
            ? t('fromQuotationTitle', { number: fromQuotation.quotationNumber })
            : consolidation
              ? t('addToContainer', { number: consolidation.number })
              : t('add')}
      </h1>
      {consolidation && <p className="muted">{t('addToContainerHint')}</p>}
      {fromQuotation && <p className="muted">{t('fromQuotationHint')}</p>}
      <Notice notice={notice} />
      <ReviewWithAssistant refused={refused} />
      {fromQuotation && (
        <section className="form-section">
          <header>
            <h2>{t('customer')}</h2>
          </header>
          <div className="form-section-body">
            <strong>{fromQuotation.customerName}</strong>
          </div>
        </section>
      )}
      {!booking && !fromQuotation && (
        <section className="form-section">
          <header>
            <h2>{t('customer')}</h2>
            <p>{t('sectionCustomerHint')}</p>
          </header>
          <div className="form-section-body" {...markGroup('customerId')}>
            <CustomerPicker
              value={customer}
              onChange={(c) => {
                setCustomer(c);
                setAddingParty(null);
                setSuggestion(null);
                touchedParties.current = new Set();
                setPartyIds({ shipperId: '', consigneeId: '', notifyPartyId: '' });
              }}
              allowCreate
            />
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
            <select
              {...mark('originLocationId')}
              value={origin}
              required
              disabled={consolidation !== undefined || quoted}
              onChange={(e) => setOrigin(e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {name(l)} ({l.code})
                </option>
              ))}
            </select>
            <FieldNote note={note} path="originLocationId" />
          </label>
          <label className="field">
            {t('destination')}
            <select
              {...mark('destinationLocationId')}
              value={destination}
              required
              disabled={quoted}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {name(l)} ({l.code})
                </option>
              ))}
            </select>
            <FieldNote note={note} path="destinationLocationId" />
          </label>
          <ModePicker
            label={t('mode')}
            value={mode}
            onChange={setMode}
            disabled={consolidation !== undefined || quoted}
            invalid={markGroup('mode')}
            note={<FieldNote note={note} path="mode" />}
          />
          {fromQuotation && (
            // The quotation's own cargo header, shown as the booking will take it; a direct
            // booking asks it on the lines only (owner «نظّف», 2026-10-19).
            <>
              {hasSeaLeg(mode) && (
                <label className="field">
                  {t('loadType')}
                  <input value={fromQuotation.loadType ?? t('notSet')} disabled readOnly />
                </label>
              )}
              <label className="field">
                {t('cargoType')}
                <input value={te(`cargo_${fromQuotation.cargoType}`)} disabled readOnly />
              </label>
            </>
          )}
          <label className="field">
            {t('requestedDeparture')}
            <input
              name="requestedDeparture"
              type="date"
              {...mark('requestedDeparture')}
              defaultValue={booking?.requestedDeparture ?? consolidation?.etd ?? ''}
            />
            <FieldNote note={note} path="requestedDeparture" />
          </label>
        </div>
      </section>
      <section className="form-section">
        <header>
          <h2>{t('sectionParties')}</h2>
          <p>{t('sectionPartiesHint')}</p>
          {suggestedNote && <p className="muted">{suggestedNote}</p>}
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
        <div className="form-section-body checks" {...markGroup('services')}>
          {CHOSEN_SERVICES.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={services.includes(s)}
                onChange={() => toggleService(s)}
              />{' '}
              {te(`service_${s}`)}
            </label>
          ))}
          <FieldNote note={note} path="services" />
        </div>
      </section>

      <section className="form-section wide">
        <header>
          <h2>{t('items')}</h2>
          <p>{t('cbmHint')}</p>
          {fromQuotation && fromQuotation.items.length > 0 && (
            <p className="muted">{t('itemsFromQuotation')}</p>
          )}
        </header>
        <fieldset className="form-section-body stack bare" {...markGroup('items')}>
          <legend className="visually-hidden">{t('items')}</legend>
          {items.map((i, index) => (
            <div key={i.key} className="line">
              <span className="muted">{index + 1}</span>
              <label className="field">
                {t('cargoType')}
                <select
                  {...mark(`items.${index}.cargoType`)}
                  value={i.cargoType}
                  onChange={(e) => {
                    const next = e.target.value as CargoType;
                    updateItem(i.key, {
                      cargoType: next,
                      containerTypeCode: next === 'CONTAINER' ? '20GP' : '',
                    });
                  }}
                >
                  {cargoChoices(i.cargoType).map((c) => (
                    <option key={c} value={c}>
                      {te(`cargo_${c}`)}
                    </option>
                  ))}
                </select>
                <FieldNote note={note} path={`items.${index}.cargoType`} />
              </label>
              {i.cargoType === 'CONTAINER' && (
                <label className="field">
                  {t('containerType')}
                  <select
                    {...mark(`items.${index}.containerTypeCode`)}
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
                  <FieldNote note={note} path={`items.${index}.containerTypeCode`} />
                </label>
              )}
              <label className="field">
                {t('quantity')}
                <input
                  type="number"
                  min={1}
                  required
                  {...mark(`items.${index}.quantity`)}
                  value={i.quantity}
                  onChange={(e) => updateItem(i.key, { quantity: e.target.value })}
                />
                <FieldNote note={note} path={`items.${index}.quantity`} />
              </label>
              {(['lengthCm', 'widthCm', 'heightCm', 'weightKg', 'volumeCbm'] as const).map((k) => (
                <label key={k} className="field">
                  {t(k)}
                  <input
                    inputMode="decimal"
                    dir="ltr"
                    {...mark(`items.${index}.${k}`)}
                    value={
                      k === 'volumeCbm' && hasDimensions(i)
                        ? (cbmOf(i.lengthCm, i.widthCm, i.heightCm, i.quantity) ?? '')
                        : i[k]
                    }
                    // Once one dimension is typed the other two are asked for here, and the API
                    // computes the CBM from them; it shows here as they are typed.
                    required={DIMENSIONS.includes(k) && hasDimensions(i)}
                    disabled={k === 'volumeCbm' && hasDimensions(i)}
                    onChange={(e) => updateItem(i.key, { [k]: asciiDigits(e.target.value) })}
                  />
                  <FieldNote note={note} path={`items.${index}.${k}`} />
                </label>
              ))}
              <label className="field">
                {t('cargoDescription')}
                <input
                  {...mark(`items.${index}.description`)}
                  value={i.description}
                  onChange={(e) => updateItem(i.key, { description: e.target.value })}
                />
                <FieldNote note={note} path={`items.${index}.description`} />
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
              onClick={() =>
                setItems((all) => [...all, emptyItem(all.at(-1)?.cargoType ?? 'PALLET')])
              }
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
          {fromQuotation && (
            <label className="field">
              {t('cargoDescription')}
              <textarea
                rows={2}
                disabled
                readOnly
                placeholder={t('notSet')}
                value={fromQuotation.cargoDescription ?? ''}
              />
            </label>
          )}
          <label className="field">
            {t('specialInstructions')}
            <textarea
              name="specialInstructions"
              rows={2}
              {...mark('specialInstructions')}
              defaultValue={booking?.specialInstructions ?? ''}
            />
            <FieldNote note={note} path="specialInstructions" />
          </label>
        </div>
      </section>

      <div className="actions form-footer">
        {!booking && !fromQuotation && customer === null && (
          <p className="muted">{t('pickCustomerToSave')}</p>
        )}
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={busy || (!booking && !fromQuotation && customer === null)}
        >
          {tc('save')}
        </button>
      </div>
      {addingParty && details && (
        <FormDialog onClose={() => setAddingParty(null)}>
          <PartyForm
            customerId={details.id}
            title={t(addingParty)}
            onCancel={() => setAddingParty(null)}
            onSaved={(c) => {
              if (c.id !== currentCustomer.current) return;
              touchedParties.current.add(addingParty);
              setDetails(c);
              setPartyIds((all) => ({ ...all, [addingParty]: c.addedPartyId }));
              setAddingParty(null);
            }}
          />
        </FormDialog>
      )}
    </form>
  );
}
