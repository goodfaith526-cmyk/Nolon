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
  // The route, mode and currency are common; one priced line per item (or the one-item shape's).
  const [inputs, setInputs] = useState({
    originId: r.originId ?? '',
    destinationId: r.destinationId ?? '',
    mode: 'SEA' as ShippingMode,
    currency: r.priceCheck?.currency ?? r.botQuotedPrice?.currency ?? '',
  });
  const byItems = r.items.length > 0;
  const hasOther = r.items.some((i) => i.isOther);
  const [lines, setLines] = useState<{ category: string; quantity: string }[]>(
    byItems
      ? r.items.map((i) => ({ category: i.category ?? '', quantity: i.quantity ?? '' }))
      : [{ category: r.category ?? '', quantity: r.quantity }],
  );
  const [paymentCurrency, setPaymentCurrency] = useState(inputs.currency);
  const [prices, setPrices] = useState<{ key: string; dtos: CsApprovalPriceDto[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const places = master.locations.filter((l) => l.isActive && isPlace(l));
  const currencies = master.currencies.filter((c) => c.isActive);
  const key = JSON.stringify({ inputs, lines });
  const priced = prices !== null && prices.key === key ? prices.dtos : null;
  const categoryOf = (code: string) => master.priceCategories.find((c) => c.code === code);
  const customerId = r.customerId ?? customer?.id ?? null;
  const set = (patch: Partial<typeof inputs>) => setInputs((v) => ({ ...v, ...patch }));
  const setLine = (index: number, patch: Partial<(typeof lines)[number]>) =>
    setLines((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  async function check() {
    setFailed(null);
    try {
      const dtos = [];
      for (const line of lines) {
        const query = new URLSearchParams({ ...inputs, ...line }).toString();
        dtos.push(await api<CsApprovalPriceDto>(`/cs-booking-requests/${r.id}/price?${query}`));
      }
      setPrices({ key, dtos });
    } catch {
      setFailed(t('priceFailed'));
    }
  }

  const linesReady = lines.every((l) => categoryOf(l.category) !== undefined && l.quantity !== '');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!priced || (!customerId && !r.profile?.name) || r.profile?.needsReview) return;
    if (!linesReady || hasOther) return;
    const first = lines[0]!;
    onApprove({
      version: r.version,
      ...(r.profile ? { profileVersion: r.profile.version } : {}),
      paymentCurrency,
      // Plan 09 section 4: a request with items is priced per line; the one-item shape as before.
      ...(byItems
        ? {
            pricing: inputs,
            lines: lines.map((l, i) => ({
              ...l,
              pricingFingerprint: priced[i]?.pricingFingerprint ?? null,
            })),
          }
        : {
            pricing: { ...inputs, ...first },
            pricingFingerprint: priced[0]?.pricingFingerprint ?? null,
          }),
      // The route, mode and cargo of the booking are the priced inputs (the API takes them).
      booking: {
        ...(customerId ? { customerId } : {}),
        services: [...r.services],
        requestedDeparture: r.requestedDate,
      },
    });
  }

  const ready =
    priced !== null &&
    !hasOther &&
    !r.profile?.needsReview &&
    (customerId !== null || !!r.profile?.name) &&
    linesReady &&
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
          {r.profile ? (
            <strong>
              {r.profile.name ?? t('profileNameRequired')}
              {r.profile.needsReview ? (
                <span className="error"> {t('profileReviewRequired')}</span>
              ) : null}
              {r.profile.phone && !r.profile.phoneVerified ? (
                <span className="muted"> {t('profilePhoneUnverified')}</span>
              ) : null}{' '}
              <span dir="ltr">({r.profile.number})</span>
            </strong>
          ) : r.customerId ? (
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
      {hasOther && <p className="error">{t('estimateRequired')}</p>}
      <div className="stack">
        {lines.map((line, index) => {
          const category = categoryOf(line.category);
          const item = r.items[index];
          const price = priced?.[index];
          return (
            <div key={item?.id ?? 'single'} className="form-grid">
              {byItems && <strong>{t('itemLine', { line: item?.lineNo ?? index + 1 })}</strong>}
              <label className="field">
                {t('category')}
                <select
                  required
                  value={line.category}
                  onChange={(e) => setLine(index, { category: e.target.value })}
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
                  value={line.quantity}
                  onChange={(e) => setLine(index, { quantity: e.target.value.trim() })}
                />
                {category && (
                  <span className="muted">
                    {t('quantityUnit', { unit: te(`unit_${category.defaultUnit}`) })}
                  </span>
                )}
              </label>
              {byItems && price && (
                <span className="muted" dir="ltr">
                  {price.state === 'priced'
                    ? `${price.total} ${price.currency}`
                    : t(`priceNone_${price.reason ?? 'NO_RATE'}`)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="row">
        <button type="button" onClick={() => void check()} disabled={busy || hasOther}>
          {t('checkPrice')}
        </button>
        {priced ? (
          priced.every((p) => p.state === 'priced') ? (
            <span>
              <span dir="ltr">
                {totalOf(priced)} {priced[0]?.currency}
              </span>{' '}
              <span className="muted">{t('priceSource')}</span>
            </span>
          ) : (
            <span className="muted">
              {t(`priceNone_${priced.find((p) => p.state !== 'priced')?.reason ?? 'NO_RATE'}`)}
            </span>
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

/**
 * The lines' totals summed for display only, in integer units of 1/10000 (decimal strings of up
 * to 4 places): the API recomputes and keeps the total as Decimal on approval.
 */
function totalOf(prices: CsApprovalPriceDto[]): string {
  const scale = 4;
  let sum = BigInt(0);
  for (const p of prices) {
    const [whole = '0', frac = ''] = (p.total ?? '0').split('.');
    sum += BigInt(whole + frac.padEnd(scale, '0').slice(0, scale));
  }
  const digits = sum.toString().padStart(scale + 1, '0');
  const places = Math.max(0, ...prices.map((p) => (p.total ?? '').split('.')[1]?.length ?? 0));
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).slice(0, places);
  return places > 0 ? `${whole}.${frac}` : whole;
}
