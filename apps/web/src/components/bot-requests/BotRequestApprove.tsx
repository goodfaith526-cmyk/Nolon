'use client';

import type {
  CsApprovalPriceDto,
  CsApproveRequest,
  CsBookingRequestStaffDto,
  CustomerSummaryDto,
  MasterDataDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
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
  failed: approveFailed = null,
  onApprove,
  defaultCurrency,
}: {
  request: CsBookingRequestStaffDto;
  master: MasterDataDto;
  busy: boolean;
  /** Why the last approval was refused, shown by its button. */
  failed?: string | null;
  onApprove: (body: CsApproveRequest) => void;
  /** The request branch's default currency: the price currency when the bot sent no quote. */
  defaultCurrency?: string;
}) {
  const t = useTranslations('BotRequests');
  const te = useTranslations('Enums');
  const name = useLocalName();
  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  // Client request 2026-11-04: a request linked to no one (the website chat) books, by default, a
  // new customer made from the name and phone the bot sent; staff may choose an existing one of
  // the request's branch instead.
  // Owner, 2026-11-04: the sender registered when the request arrived (the website chat) is the
  // booking's customer by default; staff may choose another.
  const registered =
    !r.profile && !r.customerId && !r.otherSender ? (r.instantAccount?.customerId ?? null) : null;
  const [pickOther, setPickOther] = useState(false);
  const useRegistered = registered !== null && !pickOther;
  const mayUseRequest = !r.profile && !r.customerId && !r.otherSender && registered === null;
  // Plan 09e section 3: the receiver's international phone, when the request has a local one.
  const receiverLocal = !/^(\+|00)/.test(r.consigneePhone.trim());
  const [receiverPhone, setReceiverPhone] = useState('');
  const [fromRequest, setFromRequest] = useState(mayUseRequest);
  // Codex F171-2: a request with an OTHER item books the terms its estimate priced, as set.
  const terms = r.items.some((i) => i.isOther) ? (r.estimate?.terms ?? null) : null;
  // The route, mode and currency are common; one priced line per item (or the one-item shape's).
  const [inputs, setInputs] = useState({
    originId: terms?.originId ?? r.originId ?? '',
    destinationId: terms?.destinationId ?? r.destinationId ?? '',
    // Owner, 2026-11-05: the mode the bot's quote priced (Jeddah to Khartoum is sea + road), not
    // sea alone, so the price the bot gave is found again.
    mode: terms?.mode ?? r.priceCheck?.mode ?? 'SEA',
    // A request with no quote (e.g. the website chat) is priced in its branch's currency, so the
    // price is checked as the form opens (owner, 2026-11-04: the currency was empty).
    currency: r.priceCheck?.currency ?? r.botQuotedPrice?.currency ?? defaultCurrency ?? '',
  });
  const byItems = r.items.length > 0;
  const hasOther = r.items.some((i) => i.isOther);
  // Plan 09 section 12: a request with an OTHER item is approved at the estimate the customer
  // accepted (the current version, still valid); the API checks it again.
  const estimate = r.estimate;
  // When the form opened: the API checks validity again at approval.
  const [openedAt] = useState(() => Date.now());
  const estimateAccepted =
    estimate !== null &&
    estimate.terms !== null &&
    estimate.acceptedVersion === estimate.version &&
    new Date(estimate.validUntil).getTime() > openedAt;
  const [lines, setLines] = useState<{ category: string; quantity: string }[]>(
    byItems
      ? r.items.map((i) => ({ category: i.category ?? '', quantity: i.quantity ?? '' }))
      : [{ category: r.category ?? '', quantity: r.quantity }],
  );
  const [paymentCurrency, setPaymentCurrency] = useState(inputs.currency);
  const [prices, setPrices] = useState<{ key: string; dtos: CsApprovalPriceDto[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Plan 09 section 11: the point the customer is told to bring the shipment to (none: the
  // branch's only point, when it has exactly one).
  const dropOffChoices = r.dropOffChoices.filter((d) => d.branchId === r.branchId);
  const [dropOffId, setDropOffId] = useState('');

  const places = master.locations.filter((l) => l.isActive && isPlace(l));
  const currencies = master.currencies.filter((c) => c.isActive);
  const key = JSON.stringify({ inputs, lines });
  const priced = prices !== null && prices.key === key ? prices.dtos : null;
  const categoryOf = (code: string) => master.priceCategories.find((c) => c.code === code);
  // Plan 09e section 2: a request for another sender books that sender; the API links them.
  const customerId =
    r.customerId ?? (fromRequest || r.otherSender || useRegistered ? null : (customer?.id ?? null));
  const newCustomer = mayUseRequest && fromRequest;
  const set = (patch: Partial<typeof inputs>) => setInputs((v) => ({ ...v, ...patch }));
  const setLine = (index: number, patch: Partial<(typeof lines)[number]>) =>
    setLines((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  async function check() {
    setFailed(null);
    setChecking(true);
    try {
      const dtos = [];
      for (const line of lines) {
        const query = new URLSearchParams({ ...inputs, ...line }).toString();
        dtos.push(await api<CsApprovalPriceDto>(`/cs-booking-requests/${r.id}/price?${query}`));
      }
      setPrices({ key, dtos });
    } catch {
      setFailed(t('priceFailed'));
    } finally {
      setChecking(false);
    }
  }

  const linesReady = lines.every((l) => categoryOf(l.category) !== undefined && l.quantity !== '');
  // Client request 2026-11-04: the request arrives complete, so its price is checked as the form
  // opens; staff check again only after changing an input.
  const inputsReady =
    inputs.originId !== '' && inputs.destinationId !== '' && inputs.currency !== '';
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || hasOther || !inputsReady || !linesReady) return;
    autoChecked.current = true;
    void check();
    // Once, when the form opens with a complete request.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check() reads the current inputs
  }, [hasOther, inputsReady, linesReady]);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const customerOk =
      (!!customerId || !!r.otherSender || useRegistered || !!r.profile?.name || newCustomer) &&
      (!!r.otherSender || !r.profile?.needsReview);
    if (!hasOther && (!priced || !customerOk)) return;
    if (hasOther) {
      if (!estimateAccepted || !customerOk) return;
      onApprove({
        version: r.version,
        ...(r.profile ? { profileVersion: r.profile.version } : {}),
        paymentCurrency,
        ...(newCustomer ? { newCustomerFromRequest: true as const } : {}),
        ...(receiverPhone.trim() ? { receiverPhone: receiverPhone.trim() } : {}),
        ...(dropOffId ? { dropOffId } : {}),
        pricing: { ...inputs, ...(terms?.loadType ? { loadType: terms.loadType } : {}) },
        booking: {
          ...(customerId ? { customerId } : {}),
          services: [...r.services],
          requestedDeparture: r.requestedDate,
        },
      });
      return;
    }
    if (!linesReady || !priced) return;
    const first = lines[0]!;
    onApprove({
      version: r.version,
      ...(r.profile ? { profileVersion: r.profile.version } : {}),
      paymentCurrency,
      ...(newCustomer ? { newCustomerFromRequest: true as const } : {}),
      ...(receiverPhone.trim() ? { receiverPhone: receiverPhone.trim() } : {}),
      ...(dropOffId ? { dropOffId } : {}),
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
    (hasOther ? estimateAccepted : priced !== null && linesReady) &&
    (!!r.otherSender || !r.profile?.needsReview) &&
    (customerId !== null || !!r.otherSender || useRegistered || !!r.profile?.name || newCustomer) &&
    paymentCurrency !== '' &&
    inputs.originId !== '' &&
    inputs.destinationId !== '';
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>{t('approveTitle')}</h2>
      <p className="muted">{t('approveHint')}</p>
      <div className="form-grid">
        <div className="field span-all">
          {t('customer')}
          {r.otherSender ? (
            <strong>
              {r.otherSender.name} <bdi dir="ltr">{r.otherSender.phone}</bdi>{' '}
              <span className="muted">({t('otherSender')})</span>
            </strong>
          ) : useRegistered ? (
            <div className="title-row">
              <strong>
                <Link href={`/customers/${registered}`}>{r.senderName}</Link>{' '}
                <span className="muted">({t('registeredSender')})</span>
              </strong>
              <button type="button" onClick={() => setPickOther(true)}>
                {t('chooseExistingCustomer')}
              </button>
            </div>
          ) : r.profile ? (
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
          ) : newCustomer ? (
            <div className="title-row">
              <strong>
                {t('newCustomerFromRequest', { name: r.senderName })}
                {r.contactPhone ? <bdi dir="ltr"> {r.contactPhone}</bdi> : null}
              </strong>
              <button type="button" onClick={() => setFromRequest(false)}>
                {t('chooseExistingCustomer')}
              </button>
            </div>
          ) : (
            <div className="stack">
              <CustomerPicker value={customer} onChange={setCustomer} />
              {mayUseRequest ? (
                <button type="button" onClick={() => setFromRequest(true)}>
                  {t('useRequestCustomer')}
                </button>
              ) : null}
            </div>
          )}
        </div>
        {receiverLocal ? (
          <label className="field">
            {t('receiverPhone')}
            <input
              dir="ltr"
              type="tel"
              placeholder="+249…"
              pattern="\+[1-9][0-9]{6,14}"
              value={receiverPhone}
              onChange={(e) => setReceiverPhone(e.target.value)}
            />
          </label>
        ) : null}
        <label className="field">
          {t('origin')}
          <select
            required
            disabled={terms !== null}
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
            disabled={terms !== null}
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
        <ModePicker
          label={t('mode')}
          value={inputs.mode}
          disabled={terms !== null}
          onChange={(mode) => set({ mode })}
        />
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
        {dropOffChoices.length > 0 && (
          <label className="field">
            {t('dropOff')}
            <select value={dropOffId} onChange={(e) => setDropOffId(e.target.value)}>
              <option value="">{t('dropOffAuto')}</option>
              {dropOffChoices.map((d) => (
                <option key={d.id} value={d.id}>
                  {name(d)} ({d.code}){d.outletName ? ` · ${d.outletName}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {hasOther &&
        (estimateAccepted && estimate ? (
          <p>
            {t('approveAtEstimate')}{' '}
            <strong dir="ltr">
              {estimate.amount} {estimate.currency}
            </strong>
          </p>
        ) : (
          <p className="error">{t('estimateRequired')}</p>
        ))}
      {!hasOther && (
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
      )}
      {!hasOther && (
        <div className="approve-price" aria-live="polite">
          {checking ? (
            <span className="muted">{t('checkingPrice')}</span>
          ) : priced ? (
            priced.every((p) => p.state === 'priced') ? (
              <>
                <strong dir="ltr">
                  {totalOf(priced)} {priced[0]?.currency}
                </strong>
                <span className="muted">{t('priceSource')}</span>
              </>
            ) : (
              <span className="error">
                {t(`priceNone_${priced.find((p) => p.state !== 'priced')?.reason ?? 'NO_RATE'}`)}
              </span>
            )
          ) : (
            <span className="muted">{t('checkPriceFirst')}</span>
          )}
        </div>
      )}
      {failed && <p className="error">{failed}</p>}
      {approveFailed && (
        <p className="error" role="alert">
          {approveFailed}
        </p>
      )}
      <div className="actions">
        {!hasOther && (
          <button type="button" onClick={() => void check()} disabled={busy || checking}>
            {t('checkPrice')}
          </button>
        )}
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
