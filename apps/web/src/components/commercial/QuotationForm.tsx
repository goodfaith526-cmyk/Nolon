'use client';

import {
  CARGO_TYPES,
  LOAD_TYPES,
  RATE_UNITS,
  SHIPPING_MODES,
  type CargoType,
  type CustomerSummaryDto,
  type LoadType,
  type Page,
  type QuotationDto,
  type RateCardDto,
  type RateUnit,
  type ShippingMode,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { CustomerPicker } from './CustomerPicker';
import { Notice, type NoticeState, useFailureText } from './Notice';

interface LineState {
  key: number;
  rateCardId: string;
  chargeTypeCode: string;
  unit: RateUnit;
  unitPrice: string;
  quantity: string;
  discount: string;
  description: string;
}

let nextKey = 1;
const emptyLine = (): LineState => ({
  key: nextKey++,
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
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();

  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  const [originChoice, setOrigin] = useState(quotation?.originLocationId ?? '');
  const [destinationChoice, setDestination] = useState(quotation?.destinationLocationId ?? '');
  const [mode, setMode] = useState<ShippingMode>(quotation?.mode ?? 'SEA');
  const [loadType, setLoadType] = useState<LoadType | ''>(quotation?.loadType ?? 'FCL');
  const [cargoType, setCargoType] = useState<CargoType>(quotation?.cargoType ?? 'CONTAINER');
  const [currency, setCurrency] = useState(quotation?.currency ?? 'USD');
  const [lines, setLines] = useState<LineState[]>(
    quotation?.lines.map((l) => ({
      key: nextKey++,
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

  // Until the user picks, the route defaults to the first two active locations.
  const activeLocations = master?.locations.filter((l) => l.isActive) ?? [];
  const origin = originChoice || (activeLocations[0]?.id ?? '');
  const destination = destinationChoice || (activeLocations[1]?.id ?? '');
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const branchId = quotation?.branchId ?? customer?.branchId;

  useEffect(() => {
    if (!origin || !destination || !branchId) return;
    let cancelled = false;
    const query = `status=APPROVED&originLocationId=${origin}&destinationLocationId=${destination}&mode=${mode}&pageSize=100`;
    api<Page<RateCardDto>>(`/rates?${query}`)
      .then((page) => {
        if (!cancelled) {
          setRates(page.items.filter((r) => r.branchId === branchId && r.currency === currency));
        }
      })
      .catch(() => {
        if (!cancelled) setRates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [origin, destination, mode, currency, branchId]);

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
      loadType: mode === 'SEA' && loadType ? loadType : null,
      cargoType,
      cargoDescription: text('cargoDescription'),
      currency,
      validUntil: text('validUntil') ?? '',
      terms: text('terms'),
      lines: lines.map((l) =>
        l.rateCardId
          ? {
              rateCardId: l.rateCardId,
              quantity: l.quantity,
              discount: l.discount || undefined,
              description: l.description || null,
            }
          : {
              chargeTypeCode: l.chargeTypeCode,
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
    try {
      const saved = quotation
        ? await api<QuotationDto>(`/quotations/${quotation.id}`, { method: 'PATCH', body })
        : await api<QuotationDto>('/quotations', {
            method: 'POST',
            body: { ...body, customerId: customer?.id ?? '' },
          });
      router.push(`/quotations/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;
  const locations = master.locations.filter((l) => l.isActive);
  const rateLabel = (r: RateCardDto) =>
    `${r.chargeTypeCode} · ${te(`cargo_${r.cargoType}`)}${r.containerTypeCode ? ` ${r.containerTypeCode}` : ''}${r.loadType ? ` ${r.loadType}` : ''} · ${r.price} ${r.currency} / ${te(`unit_${r.unit}`)}`;

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <h1>{quotation ? t('editTitle', { number: quotation.number }) : t('add')}</h1>
      <Notice notice={notice} />
      {!quotation && (
        <fieldset>
          <legend>{t('customer')}</legend>
          <CustomerPicker value={customer} onChange={setCustomer} />
        </fieldset>
      )}
      <div className="grid">
        <label className="field">
          {t('origin')}
          <select value={origin} onChange={(e) => setOrigin(e.target.value)} required>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {name(l)} ({l.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('destination')}
          <select value={destination} onChange={(e) => setDestination(e.target.value)} required>
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
          {t('currency')}
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {master.currencies
              .filter((c) => c.isActive)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('validUntil')}
          <input name="validUntil" type="date" required defaultValue={quotation?.validUntil} />
        </label>
      </div>
      <label className="field">
        {t('cargoDescription')}
        <textarea name="cargoDescription" defaultValue={quotation?.cargoDescription ?? ''} />
      </label>

      <fieldset className="stack">
        <legend>{t('lines')}</legend>
        {branchId && rates.length === 0 && <p className="muted">{t('noRates')}</p>}
        {lines.map((l, index) => (
          <div key={l.key} className="line">
            <span className="muted">{index + 1}</span>
            <label className="field">
              {t('rate')}
              <select
                value={l.rateCardId}
                onChange={(e) => updateLine(l.key, { rateCardId: e.target.value })}
              >
                <option value="">{t('manualLine')}</option>
                {rates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {rateLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            {!l.rateCardId && (
              <>
                <label className="field">
                  {t('chargeType')}
                  <select
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
                </label>
                <label className="field">
                  {t('unit')}
                  <select
                    value={l.unit}
                    onChange={(e) => updateLine(l.key, { unit: e.target.value as RateUnit })}
                  >
                    {RATE_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {te(`unit_${u}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  {t('unitPrice')}
                  <input
                    required
                    inputMode="decimal"
                    dir="ltr"
                    pattern="\d{1,14}(\.\d{1,4})?"
                    value={l.unitPrice}
                    onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                  />
                </label>
              </>
            )}
            <label className="field">
              {t('quantity')}
              <input
                required
                inputMode="decimal"
                dir="ltr"
                pattern="\d{1,14}(\.\d{1,4})?"
                value={l.quantity}
                onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
              />
            </label>
            <label className="field">
              {t('discount')}
              <input
                inputMode="decimal"
                dir="ltr"
                pattern="\d{1,14}(\.\d{1,4})?"
                value={l.discount}
                onChange={(e) => updateLine(l.key, { discount: e.target.value })}
              />
            </label>
            {lines.length > 1 && (
              <button
                type="button"
                onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}
              >
                {tc('remove')}
              </button>
            )}
          </div>
        ))}
        <div>
          <button type="button" onClick={() => setLines((all) => [...all, emptyLine()])}>
            {t('addLine')}
          </button>
        </div>
        <p className="muted">{t('totalsHint')}</p>
      </fieldset>

      <label className="field">
        {t('terms')}
        <textarea name="terms" defaultValue={quotation?.terms ?? ''} />
      </label>
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={busy || (!quotation && customer === null)}
        >
          {tc('save')}
        </button>
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
