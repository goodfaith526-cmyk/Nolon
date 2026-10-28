'use client';

import {
  LOAD_TYPES,
  RATE_UNITS,
  hasSeaLeg,
  loadTypeOf,
  type CargoType,
  type CreateFormReviewRequest,
  type CustomerSummaryDto,
  type LoadType,
  type Page,
  type QuotationDefaultsDto,
  type QuotationDto,
  type RateCardDto,
  type RateUnit,
  type ShippingMode,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { asciiDigits } from '@/lib/form';
import { isPlace, useLocalName, useMasterData } from '@/lib/master-data';
import { todayString } from '@/lib/money';
import { icons } from '../Icons';
import { useMe } from '../StaffShell';
import { CustomerPicker } from './CustomerPicker';
import { cargoChoices } from './cargo';
import { ModePicker } from './ModePicker';
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
import { refusedForm, ReviewWithAssistant } from './ReviewWithAssistant';

interface LineState {
  key: number;
  /** '' for none: the line is priced from general cards only (plan 5.3). */
  priceCategoryCode: string;
  rateCardId: string;
  chargeTypeCode: string;
  unit: RateUnit;
  unitPrice: string;
  quantity: string;
  discount: string;
  description: string;
}

let nextKey = 1;
/** A line that already holds an amount: a price or discount typed, or a rate card picked. */
/**
 * A line leaving its rate card leaves the card's price too (plan 5.2): the amount shown while the
 * card priced the line is never sent as a typed price. The user types one, or picks a card again.
 */
const dropCard = { rateCardId: '', unitPrice: '' } as const;

const hasAmount = (l: LineState) => l.unitPrice !== '' || l.discount !== '' || l.rateCardId !== '';

const emptyLine = (): LineState => ({
  key: nextKey++,
  priceCategoryCode: '',
  rateCardId: '',
  chargeTypeCode: 'FREIGHT',
  unit: 'PER_SHIPMENT',
  unitPrice: '',
  quantity: '1',
  discount: '',
  description: '',
});

/** New quotation, or edit of a draft. Totals are computed by the API after saving. */
export function QuotationForm({ quotation }: { quotation?: QuotationDto }) {
  const t = useTranslations('Quotations');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();

  const isEdit = quotation !== undefined;
  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  const [originChoice, setOrigin] = useState(quotation?.originLocationId ?? '');
  const [destinationChoice, setDestination] = useState(quotation?.destinationLocationId ?? '');
  const [mode, setMode] = useState<ShippingMode>(quotation?.mode ?? 'SEA');
  const [cargoType, setCargoType] = useState<CargoType>(quotation?.cargoType ?? 'CONTAINER');
  // FCL/LCL follows the cargo type (FCL for a container, else LCL: functional review B2) until the
  // person picks one, which is kept, LCL for a container included. An edit keeps a saved value
  // that does not follow the rule as picked; one that does, or none, follows it again.
  const [loadTypeChoice, setLoadType] = useState<LoadType | null>(
    quotation?.loadType && quotation.loadType !== loadTypeOf(quotation.mode, quotation.cargoType)
      ? quotation.loadType
      : null,
  );
  const loadType = hasSeaLeg(mode) ? (loadTypeChoice ?? loadTypeOf(mode, cargoType)) : null;
  // A new quotation's currency and valid-until (functional review B3, B4): generated when the
  // customer is picked, from GET /quotations/defaults (the customer's preferred currency, else
  // its branch's; the branch's today plus the configured days). Picking another customer asks
  // again; a currency or date the person chose (a `...Choice`, null until then) is kept, and an
  // edit keeps what the quotation holds. Nothing is suggested before the customer.
  // A suggested currency is applied only while no line holds an amount (Codex F93-1): once a
  // price, discount or rate is on a line, the currency stays as it is (`autoCurrency`) and the
  // suggestion is only shown, so an amount is never sent in a currency it was not entered in.
  const [currencyChoice, setCurrency] = useState<string | null>(quotation?.currency ?? null);
  const [validUntilChoice, setValidUntil] = useState<string | null>(quotation?.validUntil ?? null);
  const [defaults, setDefaults] = useState<QuotationDefaultsDto | null>(null);
  const [autoCurrency, setAutoCurrency] = useState('');
  const currency = currencyChoice ?? autoCurrency;
  const validUntil = validUntilChoice ?? defaults?.validUntil ?? '';
  const [lines, setLines] = useState<LineState[]>(
    quotation?.lines.map((l) => ({
      key: nextKey++,
      priceCategoryCode: l.priceCategoryCode ?? '',
      rateCardId: l.rateCardId ?? '',
      chargeTypeCode: l.chargeTypeCode,
      unit: l.unit,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      discount: l.discount === '0' ? '' : l.discount,
      description: l.description ?? '',
    })) ?? [emptyLine()],
  );
  const [rates, setRates] = useState<RateCardDto[]>([]);
  const [busy, setBusy] = useState(false);
  // The lines as last rendered, for deciding whether a suggestion that arrives later applies.
  const linesNow = useRef(lines);
  useEffect(() => {
    linesNow.current = lines;
  }, [lines]);

  // The route starts empty: the person picks it (functional review B6).
  const origin = originChoice;
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

  const branchId = quotation?.branchId ?? customer?.branchId;
  // The quotation's branch's date: the day the API checks a rate card's validity on.
  const today = me.branches.find((b) => b.id === branchId)?.today ?? todayString();

  const customerId = customer?.id;
  useEffect(() => {
    if (isEdit || !customerId) return;
    let cancelled = false;
    api<QuotationDefaultsDto>(`/quotations/defaults?customerId=${customerId}`)
      .then((d) => {
        if (cancelled) return;
        setDefaults(d);
        if (!linesNow.current.some(hasAmount)) setAutoCurrency(d.currency);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isEdit, customerId]);

  useEffect(() => {
    if (!origin || !destination || !branchId) return;
    let cancelled = false;
    const query = `status=APPROVED&originLocationId=${origin}&destinationLocationId=${destination}&mode=${mode}&validOn=${today}&covering=true&pageSize=100`;
    api<Page<RateCardDto>>(`/rates?${query}`)
      .then((page) => {
        if (!cancelled) {
          // Rate cards of every branch price a quotation (owner, 2026-10-19). Only the cards the
          // API accepts for this quotation are offered: same currency, load type and cargo type.
          const offered = page.items.filter(
            (r) => r.currency === currency && r.loadType === loadType && r.cargoType === cargoType,
          );
          setRates(offered);
          // On a new quotation, a line priced from a rate no longer offered (another customer's
          // currency, say: functional review B3) is picked again rather than kept unseen. Typed
          // values stay; an edit keeps its lines for the API to check.
          if (!isEdit) {
            const ids = new Set(offered.map((r) => r.id));
            setLines((all) =>
              all.some((l) => l.rateCardId && !ids.has(l.rateCardId))
                ? all.map((l) =>
                    l.rateCardId && !ids.has(l.rateCardId) ? { ...l, ...dropCard } : l,
                  )
                : all,
            );
          }
        }
      })
      .catch(() => {
        if (!cancelled) setRates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [origin, destination, mode, currency, loadType, cargoType, today, branchId, isEdit]);

  function updateLine(key: number, patch: Partial<LineState>) {
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (key: string) => {
      const v = form.get(key);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    };
    const body = {
      originLocationId: origin,
      destinationLocationId: destination,
      mode,
      loadType,
      cargoType,
      cargoDescription: text('cargoDescription'),
      currency,
      validUntil: text('validUntil') ?? '',
      terms: text('terms'),
      lines: lines.map((l) =>
        l.rateCardId
          ? {
              rateCardId: l.rateCardId,
              priceCategoryCode: l.priceCategoryCode || null,
              quantity: l.quantity,
              discount: l.discount || undefined,
              description: l.description || null,
            }
          : {
              chargeTypeCode: l.chargeTypeCode,
              priceCategoryCode: l.priceCategoryCode || null,
              unit: l.unit,
              unitPrice: l.unitPrice,
              quantity: l.quantity,
              discount: l.discount || undefined,
              description: l.description || null,
            },
      ),
    };
    setBusy(true);
    setNotice(null);
    setInvalid(new Set());
    setNote(null);
    setRefused(null);
    const sent = quotation ? body : { ...body, customerId: customer?.id ?? '' };
    try {
      const saved = quotation
        ? await api<QuotationDto>(`/quotations/${quotation.id}`, { method: 'PATCH', body: sent })
        : await api<QuotationDto>('/quotations', { method: 'POST', body: sent });
      router.push(`/quotations/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setInvalid(invalidFields(err));
      setNote(fieldNote(err, refusalReason(err)));
      setRefused(
        refusedForm(err, {
          form: 'quotation',
          mode: quotation ? 'edit' : 'create',
          values: sent,
          customerName: customer?.name ?? null,
        }),
      );
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;
  const locations = master.locations.filter((l) => l.isActive && isPlace(l));
  // A card of the place's city or country names where it prices from (plan 5.3).
  const locationName = (id: string) => {
    const l = master.locations.find((x) => x.id === id);
    return l ? name(l) : '…';
  };
  const scopeOf = (r: RateCardDto) =>
    r.originLocationId !== origin || r.destinationLocationId !== destination
      ? ` · ${tc('route', { from: locationName(r.originLocationId), to: locationName(r.destinationLocationId) })}`
      : '';
  const categoryName = (code: string | null) => {
    const c = master.priceCategories.find((x) => x.code === code);
    return c ? ` · ${name(c)}` : '';
  };
  const rateLabel = (r: RateCardDto) =>
    `${r.chargeTypeCode} · ${te(`cargo_${r.cargoType}`)}${r.containerTypeCode ? ` ${r.containerTypeCode}` : ''}${r.loadType ? ` ${r.loadType}` : ''}${categoryName(r.priceCategoryCode)} · ${r.price} ${r.currency} / ${te(`unit_${r.unit}`)}${scopeOf(r)}`;
  // A line offers the general cards, and its category's when it has one (plan 5.3).
  const ratesFor = (l: LineState) =>
    rates.filter((r) => !r.priceCategoryCode || r.priceCategoryCode === l.priceCategoryCode);
  const categories = master.priceCategories.filter(
    (c) =>
      c.cargoType === cargoType &&
      (c.isActive || lines.some((l) => l.priceCategoryCode === c.code)),
  );

  const locationOptions = locations.map((l) => (
    <option key={l.id} value={l.id}>
      {name(l)} ({l.code})
    </option>
  ));

  return (
    <form ref={formRef} className="stack form-page" onSubmit={(e) => void submit(e)}>
      <h1>{quotation ? t('editTitle', { number: quotation.number }) : t('add')}</h1>
      <Notice notice={notice} />
      <ReviewWithAssistant refused={refused} />

      {!quotation && (
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
                setDefaults(null);
              }}
              allowCreate
            />
          </div>
        </section>
      )}

      <section className="form-section">
        <header>
          <h2>{t('sectionShipment')}</h2>
          <p>{t('sectionShipmentHint')}</p>
        </header>
        <div className="form-section-body form-grid">
          <label className="field">
            {t('origin')}
            <select
              {...mark('originLocationId')}
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              required
            >
              <option value="" disabled>
                —
              </option>
              {locationOptions}
            </select>
            <FieldNote note={note} path="originLocationId" />
          </label>
          <label className="field">
            {t('destination')}
            <select
              {...mark('destinationLocationId')}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              required
            >
              <option value="" disabled>
                —
              </option>
              {locationOptions}
            </select>
            <FieldNote note={note} path="destinationLocationId" />
          </label>
          <ModePicker
            label={t('mode')}
            value={mode}
            onChange={setMode}
            invalid={markGroup('mode')}
            note={<FieldNote note={note} path="mode" />}
          />
          {hasSeaLeg(mode) && (
            <label className="field">
              {t('loadType')}
              <select
                {...mark('loadType')}
                value={loadType ?? ''}
                onChange={(e) => setLoadType(e.target.value as LoadType)}
              >
                {LOAD_TYPES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              {loadTypeChoice === null && <small className="muted">{tc('loadTypeFollows')}</small>}
              <FieldNote note={note} path="loadType" />
            </label>
          )}
          <label className="field">
            {t('cargoType')}
            <select
              {...mark('cargoType')}
              value={cargoType}
              onChange={(e) => {
                setCargoType(e.target.value as CargoType);
                // A category follows one cargo type: the lines' categories go with the old one.
                setLines((all) =>
                  all.some((l) => l.priceCategoryCode)
                    ? all.map((l) => ({ ...l, priceCategoryCode: '' }))
                    : all,
                );
              }}
            >
              {cargoChoices(cargoType).map((c) => (
                <option key={c} value={c}>
                  {te(`cargo_${c}`)}
                </option>
              ))}
            </select>
            <FieldNote note={note} path="cargoType" />
          </label>
          <label className="field span-all">
            {t('cargoDescription')}
            <textarea
              name="cargoDescription"
              rows={2}
              {...mark('cargoDescription')}
              defaultValue={quotation?.cargoDescription ?? ''}
            />
            <FieldNote note={note} path="cargoDescription" />
          </label>
        </div>
      </section>

      <section className="form-section">
        <header>
          <h2>{t('sectionPricing')}</h2>
          <p>{t('sectionPricingHint')}</p>
        </header>
        <div className="form-section-body form-grid">
          <label className="field">
            {t('currency')}
            <select
              {...mark('currency')}
              value={currency}
              required
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {master.currencies
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
            </select>
            {defaults && currencyChoice === null && currency === defaults.currency && (
              <small className="muted">
                {defaults.currencySource === 'CUSTOMER'
                  ? t('currencyFromCustomer')
                  : t('currencyFromBranch')}
              </small>
            )}
            {defaults && currencyChoice === null && currency !== defaults.currency && (
              <small className="muted">
                {t('currencySuggestionNotApplied', { currency: defaults.currency })}
              </small>
            )}
            <FieldNote note={note} path="currency" />
          </label>
          <label className="field">
            {t('validUntil')}
            <input
              name="validUntil"
              type="date"
              required
              {...mark('validUntil')}
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
            />
            {defaults && validUntilChoice === null && (
              <small className="muted">
                {t('validUntilFromDays', { days: defaults.validityDays })}
              </small>
            )}
            <FieldNote note={note} path="validUntil" />
          </label>
        </div>
      </section>

      <section className="form-section wide">
        <header>
          <h2>{t('lines')}</h2>
          <p>{t('totalsHint')}</p>
        </header>
        <div className="form-section-body stack">
          {branchId && rates.length === 0 && <p className="muted">{t('noRates')}</p>}
          <div className="line-items" role="table" aria-label={t('lines')} {...markGroup('lines')}>
            <div className="line-items-head" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">{t('rate')}</span>
              <span role="columnheader">{t('chargeType')}</span>
              <span role="columnheader">{t('unit')}</span>
              <span role="columnheader">{t('unitPrice')}</span>
              <span role="columnheader">{t('quantity')}</span>
              <span role="columnheader">{t('discount')}</span>
              <span role="columnheader" />
            </div>
            {lines.map((l, index) => (
              <div key={l.key} className="line-item" role="row">
                <span className="line-no" role="cell">
                  {index + 1}
                </span>
                <label className="cell" role="cell" data-label={t('rate')}>
                  {categories.length > 0 && (
                    <select
                      aria-label={t('priceCategory')}
                      {...mark(`lines.${index}.priceCategoryCode`)}
                      value={l.priceCategoryCode}
                      onChange={(e) => {
                        const code = e.target.value;
                        // A card of another category no longer prices the line.
                        const card = rates.find((r) => r.id === l.rateCardId);
                        const keeps =
                          !card || !card.priceCategoryCode || card.priceCategoryCode === code;
                        updateLine(l.key, {
                          priceCategoryCode: code,
                          ...(keeps ? {} : dropCard),
                        });
                      }}
                    >
                      <option value="">{t('noCategory')}</option>
                      {categories.map((c) => (
                        <option key={c.code} value={c.code}>
                          {name(c)}
                        </option>
                      ))}
                    </select>
                  )}
                  <FieldNote note={note} path={`lines.${index}.priceCategoryCode`} />
                  <select
                    aria-label={t('rate')}
                    {...mark(`lines.${index}.rateCardId`)}
                    value={l.rateCardId}
                    onChange={(e) =>
                      updateLine(
                        l.key,
                        e.target.value === '' && l.rateCardId !== ''
                          ? dropCard
                          : { rateCardId: e.target.value },
                      )
                    }
                  >
                    <option value="">{t('manualLine')}</option>
                    {ratesFor(l).map((r) => (
                      <option key={r.id} value={r.id}>
                        {rateLabel(r)}
                      </option>
                    ))}
                  </select>
                  <FieldNote note={note} path={`lines.${index}.rateCardId`} />
                </label>
                {l.rateCardId ? (
                  <span className="cell from-rate" role="cell">
                    {t('fromRate')}
                  </span>
                ) : (
                  <>
                    <label className="cell" role="cell" data-label={t('chargeType')}>
                      <select
                        aria-label={t('chargeType')}
                        {...mark(`lines.${index}.chargeTypeCode`)}
                        value={l.chargeTypeCode}
                        onChange={(e) => updateLine(l.key, { chargeTypeCode: e.target.value })}
                      >
                        {master.chargeTypes
                          .filter((c) => c.isActive)
                          .map((c) => (
                            <option key={c.code} value={c.code}>
                              {name(c)}
                            </option>
                          ))}
                      </select>
                      <FieldNote note={note} path={`lines.${index}.chargeTypeCode`} />
                    </label>
                    <label className="cell" role="cell" data-label={t('unit')}>
                      <select
                        aria-label={t('unit')}
                        {...mark(`lines.${index}.unit`)}
                        value={l.unit}
                        onChange={(e) => updateLine(l.key, { unit: e.target.value as RateUnit })}
                      >
                        {RATE_UNITS.map((u) => (
                          <option key={u} value={u}>
                            {te(`unit_${u}`)}
                          </option>
                        ))}
                      </select>
                      <FieldNote note={note} path={`lines.${index}.unit`} />
                    </label>
                    <label className="cell" role="cell" data-label={t('unitPrice')}>
                      <input
                        aria-label={t('unitPrice')}
                        required
                        inputMode="decimal"
                        dir="ltr"
                        pattern="\d{1,14}(\.\d{1,4})?"
                        {...mark(`lines.${index}.unitPrice`)}
                        value={l.unitPrice}
                        onChange={(e) =>
                          updateLine(l.key, { unitPrice: asciiDigits(e.target.value) })
                        }
                      />
                      <FieldNote note={note} path={`lines.${index}.unitPrice`} />
                    </label>
                  </>
                )}
                <label className="cell" role="cell" data-label={t('quantity')}>
                  <input
                    aria-label={t('quantity')}
                    required
                    inputMode="decimal"
                    dir="ltr"
                    pattern="\d{1,14}(\.\d{1,4})?"
                    {...mark(`lines.${index}.quantity`)}
                    value={l.quantity}
                    onChange={(e) => updateLine(l.key, { quantity: asciiDigits(e.target.value) })}
                  />
                  <FieldNote note={note} path={`lines.${index}.quantity`} />
                </label>
                <label className="cell" role="cell" data-label={t('discount')}>
                  <input
                    aria-label={t('discount')}
                    inputMode="decimal"
                    dir="ltr"
                    pattern="\d{1,14}(\.\d{1,4})?"
                    placeholder="0"
                    {...mark(`lines.${index}.discount`)}
                    value={l.discount}
                    onChange={(e) => updateLine(l.key, { discount: asciiDigits(e.target.value) })}
                  />
                  <FieldNote note={note} path={`lines.${index}.discount`} />
                </label>
                <span className="cell line-remove" role="cell">
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="ghost icon-button"
                      aria-label={tc('remove')}
                      title={tc('remove')}
                      onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}
                    >
                      {icons.close}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div>
            <button
              type="button"
              className="ghost add-line"
              onClick={() => setLines((all) => [...all, emptyLine()])}
            >
              {icons.plus}
              <span>{t('addLine')}</span>
            </button>
          </div>
        </div>
      </section>

      <section className="form-section">
        <header>
          <h2>{t('terms')}</h2>
          <p>{t('termsHint')}</p>
        </header>
        <div className="form-section-body">
          <label className="field">
            <span className="visually-hidden">{t('terms')}</span>
            <textarea
              name="terms"
              rows={3}
              {...mark('terms')}
              defaultValue={quotation?.terms ?? ''}
            />
            <FieldNote note={note} path="terms" />
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
          disabled={busy || (!quotation && customer === null)}
        >
          {tc('save')}
        </button>
      </div>
    </form>
  );
}
