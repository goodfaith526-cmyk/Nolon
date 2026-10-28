'use client';

import type {
  CsApprovalPriceDto,
  CsApproveRequest,
  CsBookingRequestStaffDto,
  CustomerSummaryDto,
  MasterDataDto,
  ShippingMode,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { isPlace, useLocalName } from '@/lib/master-data';
import { CustomerPicker } from '../commercial/CustomerPicker';
import { ModePicker } from '../commercial/ModePicker';

/**
 * Approving a bot request (plan 04a, R3-ج2): staff confirm the booking's customer, route and mode,
 * and the category, quantity and currency it is priced in; NOLON's engine prices those inputs, and
 * approval sends back the fingerprint of the price shown. Any change to an input asks for the price
 * again before approving. The booking is made as a draft with no price; the API checks everything
 * again, and the price under the card's lock (409 PRICE_STALE when it changed).
 */
export function BotRequestApprove({
  request: r,
  master,
  busy,
  onApprove,
}: {
  request: CsBookingRequestStaffDto;
  master: MasterDataDto;
  busy: boolean;
  onApprove: (body: CsApproveRequest) => void;
}) {
  const t = useTranslations('BotRequests');
  const te = useTranslations('Enums');
  const name = useLocalName();
  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  const [inputs, setInputs] = useState({
    originId: r.originId ?? '',
    destinationId: r.destinationId ?? '',
    mode: 'SEA' as ShippingMode,
    category: r.category ?? '',
    quantity: r.quantity,
    currency: r.priceCheck?.currency ?? r.botQuotedPrice?.currency ?? '',
  });
  const [paymentCurrency, setPaymentCurrency] = useState(inputs.currency);
  const [price, setPrice] = useState<{ key: string; dto: CsApprovalPriceDto } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const places = master.locations.filter((l) => l.isActive && isPlace(l));
  const currencies = master.currencies.filter((c) => c.isActive);
  const key = JSON.stringify(inputs);
  const priced = price !== null && price.key === key ? price.dto : null;
  const category = master.priceCategories.find((c) => c.code === inputs.category);
  const customerId = r.customerId ?? customer?.id ?? null;
  const set = (patch: Partial<typeof inputs>) => setInputs((v) => ({ ...v, ...patch }));

  async function check() {
    setFailed(null);
    try {
      const query = new URLSearchParams(inputs).toString();
      setPrice({
        key,
        dto: await api<CsApprovalPriceDto>(`/cs-booking-requests/${r.id}/price?${query}`),
      });
    } catch {
      setFailed(t('priceFailed'));
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!priced || !customerId || !category) return;
    onApprove({
      version: r.version,
      paymentCurrency,
      pricing: inputs,
      pricingFingerprint: priced.pricingFingerprint,
      // The route, mode and cargo of the booking are the priced inputs (the API takes them).
      booking: {
        customerId,
        services: [...r.services],
        requestedDeparture: r.requestedDate,
      },
    });
  }

  const ready =
    priced !== null &&
    customerId !== null &&
    category !== undefined &&
    paymentCurrency !== '' &&
    inputs.originId !== '' &&
    inputs.destinationId !== '';
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>{t('approveTitle')}</h2>
      <p className="muted">{t('approveHint')}</p>
      <div className="form-grid">
        <div className="field">
          {t('customer')}
          {r.customerId ? (
            <strong dir="ltr">{r.customerNumber}</strong>
          ) : (
            <CustomerPicker value={customer} onChange={setCustomer} />
          )}
        </div>
        <label className="field">
          {t('origin')}
          <select
            required
            value={inputs.originId}
            onChange={(e) => set({ originId: e.target.value })}
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
        <label className="field">
          {t('destination')}
          <select
            required
            value={inputs.destinationId}
            onChange={(e) => set({ destinationId: e.target.value })}
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
        <ModePicker label={t('mode')} value={inputs.mode} onChange={(mode) => set({ mode })} />
        <label className="field">
          {t('category')}
          <select
            required
            value={inputs.category}
            onChange={(e) => set({ category: e.target.value })}
          >
            <option value="" disabled>
              —
            </option>
            {master.priceCategories.map((c) => (
              <option key={c.code} value={c.code}>
                {name(c)} ({c.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('quantity')}
          <input
            required
            dir="ltr"
            inputMode="decimal"
            value={inputs.quantity}
            onChange={(e) => set({ quantity: e.target.value.trim() })}
          />
          {category && (
            <span className="muted">
              {t('quantityUnit', { unit: te(`unit_${category.defaultUnit}`) })}
            </span>
          )}
        </label>
        <label className="field">
          {t('priceCurrency')}
          <select
            required
            value={inputs.currency}
            onChange={(e) => set({ currency: e.target.value })}
          >
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
          {t('paymentCurrency')}
          <select
            required
            value={paymentCurrency}
            onChange={(e) => setPaymentCurrency(e.target.value)}
          >
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
      </div>
      <div className="row">
        <button type="button" onClick={() => void check()} disabled={busy}>
          {t('checkPrice')}
        </button>
        {priced ? (
          priced.state === 'priced' ? (
            <span>
              <span dir="ltr">
                {priced.total} {priced.currency}
              </span>{' '}
              <span className="muted">{t('priceSource')}</span>
            </span>
          ) : (
            <span className="muted">{t(`priceNone_${priced.reason ?? 'NO_RATE'}`)}</span>
          )
        ) : (
          <span className="muted">{t('checkPriceFirst')}</span>
        )}
      </div>
      {failed && <p className="error">{failed}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !ready}>
          {t('approveAction')}
        </button>
      </div>
    </form>
  );
}
