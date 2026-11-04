'use client';

import type { CsBookingRequestStaffDto, CsName, CsRejectReasonDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { useMe } from '../StaffShell';
import { BotRequestApprove } from './BotRequestApprove';
import { BotRequestEstimate } from './BotRequestEstimate';

/**
 * One bot booking request for staff (plan 04a): what the customer asked, in NOLON's terms and, for
 * a request by names, in the bot's own words; the advisory price check of its quote; and routing
 * or rejection. The API decides who may do what (`actions`) and rechecks it on every write.
 */
export function BotRequestDetail({ id }: { id: string }) {
  const t = useTranslations('BotRequests');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const failure = useFailureText();
  const master = useMasterData();
  const localName = useLocalName();
  const locationName = useLocationName(master);
  const {
    record,
    notice: loadNotice,
    setRecord,
  } = useRecord<CsBookingRequestStaffDto>(`/cs-booking-requests/${id}`);
  const [reasons, setReasons] = useState<CsRejectReasonDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    api<CsRejectReasonDto[]>('/cs-booking-requests/reject-reasons')
      .then((r) => setReasons(r.filter((x) => x.isActive)))
      .catch(() => setReasons([]));
  }, []);

  if (!record) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }
  const r = record;
  const named = (n: CsName | undefined) => (n ? (locale === 'ar' ? n.ar : n.en) : '—');
  const place = (placeId: string | null, n: CsName | undefined) =>
    placeId ? locationName(placeId) : `${t('unmatched')}: «${named(n)}»`;
  const branchName = (branchId: string | null) => {
    const b = branchId ? me.branches.find((x) => x.id === branchId) : undefined;
    return b ? localName(b) : t('noBranch');
  };
  const routeTo = r.allowedBranchIds.filter((b) => me.branches.some((x) => x.id === b));

  async function post(path: string, body: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(
        await api<CsBookingRequestStaffDto>(`/cs-booking-requests/${id}/${path}`, {
          method: 'POST',
          body,
        }),
      );
      setNotice({ ok: true, text: tc('saved') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function route(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void post('route', {
      version: r.version,
      branchId: field(new FormData(e.currentTarget), 'branchId'),
    });
  }

  function reject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void post('reject', {
      version: r.version,
      reasonCode: field(form, 'reasonCode'),
      internalNote: field(form, 'internalNote').trim() || null,
    });
  }

  const check = r.priceCheck;
  return (
    <section className="stack">
      <div className="row">
        <h1 dir="ltr">{r.reference}</h1>
        <span className={`badge badge-${r.status.toUpperCase()}`}>{t(`state_${r.status}`)}</span>
      </div>
      <Notice notice={notice} />
      {r.byNames && <p className="muted">{t('byNamesHint')}</p>}
      <dl className="details">
        <dt>{t('source')}</dt>
        <dd>
          {r.customerNumber
            ? t('sourceCustomer', { number: r.customerNumber })
            : r.channel
              ? t(`channel_${r.channel}`)
              : '—'}
        </dd>
        <dt>{t('createdAt')}</dt>
        <dd>{new Date(r.createdAt).toLocaleString(locale)}</dd>
        <dt>{t('expiresAt')}</dt>
        <dd>{new Date(r.expiresAt).toLocaleString(locale)}</dd>
        <dt>{t('origin')}</dt>
        <dd>{place(r.originId, r.botNames?.origin)}</dd>
        <dt>{t('destination')}</dt>
        <dd>{place(r.destinationId, r.botNames?.destination)}</dd>
        <dt>{t('category')}</dt>
        <dd dir="ltr">{r.category ?? `${t('unmatched')}: «${named(r.botNames?.kind)}»`}</dd>
        <dt>{t('quantity')}</dt>
        <dd dir="ltr">{r.quantity}</dd>
        <dt>{t('handover')}</dt>
        <dd>{t(`handover_${r.handover}`)}</dd>
        <dt>{t('sender')}</dt>
        <dd>
          {r.senderName}
          {r.contactPhone && (
            <span className="muted" dir="ltr">
              {' '}
              {r.contactPhone}
            </span>
          )}
        </dd>
        <dt>{t('consignee')}</dt>
        <dd>
          {r.consigneeName}{' '}
          <span className="muted" dir="ltr">
            {r.consigneePhone}
          </span>
        </dd>
        {r.requestedDate && (
          <>
            <dt>{t('requestedDate')}</dt>
            <dd dir="ltr">{r.requestedDate}</dd>
          </>
        )}
        <dt>{t('branch')}</dt>
        <dd>{branchName(r.branchId)}</dd>
        <dt>{t('price')}</dt>
        <dd>
          {check ? (
            <span>
              <span dir="ltr">
                {check.quotedTotal ?? check.unitPrice} {check.currency}
              </span>{' '}
              <span
                className={`badge ${check.state === 'current' ? 'badge-APPROVED' : 'badge-EXPIRED'}`}
              >
                {t(`price_${check.state}`)}
              </span>
              {check.state === 'stale' && (
                <span className="muted">
                  {' '}
                  {check.totalNow
                    ? t('priceNow', { total: `${check.totalNow} ${check.currency}` })
                    : t('priceNone')}
                </span>
              )}
            </span>
          ) : (
            t('noQuote')
          )}
        </dd>
        {r.botQuotedPrice && (
          <>
            <dt>{t('botPrice')}</dt>
            <dd>
              <span dir="ltr">
                {r.botQuotedPrice.amount} {r.botQuotedPrice.currency}
              </span>{' '}
              <span className="muted">{t('botPriceHint')}</span>
            </dd>
          </>
        )}
        {r.rejectReasonCode && (
          <>
            <dt>{t('rejectReason')}</dt>
            <dd>
              {(() => {
                const reason = reasons.find((x) => x.code === r.rejectReasonCode);
                return reason
                  ? locale === 'ar'
                    ? reason.textAr
                    : reason.textEn
                  : r.rejectReasonCode;
              })()}
            </dd>
          </>
        )}
        {r.bookingId && (
          <>
            <dt>{t('booking')}</dt>
            <dd>
              <Link href={`/bookings/${r.bookingId}`} dir="ltr">
                {r.bookingNumber}
              </Link>{' '}
              {r.paymentCurrency && (
                <span className="muted">
                  {t('paymentCurrency')}: <span dir="ltr">{r.paymentCurrency}</span>
                </span>
              )}
            </dd>
          </>
        )}
        {(r.dropOffPoint || r.actions.canSetDropOff) && (
          <>
            <dt>{t('dropOff')}</dt>
            <dd>
              {r.dropOffPoint ? (
                <>
                  {localName(r.dropOffPoint)} <span dir="ltr">({r.dropOffPoint.code})</span>
                </>
              ) : (
                <span className="muted">{t('dropOffNone')}</span>
              )}
            </dd>
          </>
        )}
        {r.approvedPricing && (
          <>
            <dt>{t('approvedPricing')}</dt>
            <dd dir="ltr">
              {r.approvedPricing.category} × {r.approvedPricing.quantity}
              {r.approvedPricing.total !== null &&
                ` = ${r.approvedPricing.total} ${r.approvedPricing.currency}`}
            </dd>
          </>
        )}
        {r.cancelledAt && (
          <>
            <dt>{t('cancelledByCustomer')}</dt>
            <dd>
              <span dir="ltr">{r.cancelledAt.slice(0, 16).replace('T', ' ')}</span>
              {r.cancelReason && <span className="pre"> — {r.cancelReason}</span>}
            </dd>
          </>
        )}
        {r.cancelRequest && (
          <>
            <dt>{t('cancelRequest')}</dt>
            <dd>
              <span dir="ltr">{r.cancelRequest.requestedAt.slice(0, 16).replace('T', ' ')}</span>
              {r.cancelRequest.reason && (
                <span className="pre"> — {r.cancelRequest.reason}</span>
              )}{' '}
              <span className="muted">
                {r.cancelRequest.closedAt ? t('cancelRequestClosed') : t('cancelRequestOpen')}
              </span>
            </dd>
          </>
        )}
        {r.instantAccount && (
          <>
            <dt>{t('instantAccount')}</dt>
            <dd>
              {r.instantAccount.customerId ? (
                <Link href={`/customers/${r.instantAccount.customerId}`}>
                  {t('instantAccountMade')}
                </Link>
              ) : (
                t('instantAccountWaits', {
                  reason: t(`instantAccount_${r.instantAccount.outcome}`),
                })
              )}
            </dd>
          </>
        )}
        {r.otherSender && (
          <>
            <dt>{t('otherSender')}</dt>
            <dd>
              {r.otherSender.customerId ? (
                <Link href={`/customers/${r.otherSender.customerId}`}>{r.otherSender.name}</Link>
              ) : (
                r.otherSender.name
              )}{' '}
              <span dir="ltr">{r.otherSender.phone}</span>
            </dd>
          </>
        )}
        {r.receiverAccount && (
          <>
            <dt>{t('receiverAccount')}</dt>
            <dd>
              {r.receiverAccount.customerId ? (
                <Link href={`/customers/${r.receiverAccount.customerId}`}>
                  {t(`receiverAccount_${r.receiverAccount.outcome}`)}
                </Link>
              ) : (
                t(`receiverAccount_${r.receiverAccount.outcome}`)
              )}
            </dd>
          </>
        )}
        {r.internalNote && (
          <>
            <dt>{t('internalNote')}</dt>
            <dd className="pre">{r.internalNote}</dd>
          </>
        )}
      </dl>

      {r.items.length > 0 && (
        <div className="card stack">
          <h2>{t('itemsTitle')}</h2>
          {r.bookingId && r.items.some((i) => i.bookingItemId === null) && (
            <p className="error">{t('itemsIncomplete')}</p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('category')}</th>
                  <th>{t('quantity')}</th>
                  <th>{t('pieces')}</th>
                  <th>{t('dimensions')}</th>
                  <th>{t('weightKg')}</th>
                  <th>{t('approvedTotal')}</th>
                  {r.bookingId && <th>{t('bookingLine')}</th>}
                </tr>
              </thead>
              <tbody>
                {r.items.map((item) => {
                  const linked = r.bookingLines.find((l) => l.id === item.bookingItemId);
                  const free = r.bookingLines.filter(
                    (l) => !r.items.some((i) => i.bookingItemId === l.id),
                  );
                  return (
                    <tr key={item.id}>
                      <td dir="ltr">{item.lineNo}</td>
                      <td>
                        {item.isOther ? (
                          <span>
                            {t('otherItem')}: «{item.description}»
                          </span>
                        ) : (
                          <span dir="ltr">
                            {item.category ??
                              `${t('unmatched')}: «${named(item.botKind ?? undefined)}»`}
                          </span>
                        )}
                      </td>
                      <td dir="ltr">{item.quantity ?? '—'}</td>
                      <td dir="ltr">{item.pieces ?? '—'}</td>
                      <td dir="ltr">
                        {item.dimensions
                          ? `${item.dimensions.lengthCm}×${item.dimensions.widthCm}×${item.dimensions.heightCm}`
                          : '—'}
                      </td>
                      <td dir="ltr">{item.weightKg ?? '—'}</td>
                      <td dir="ltr">{item.approvedTotal ?? '—'}</td>
                      {r.bookingId && (
                        <td>
                          {linked ? (
                            <span dir="ltr">{linked.lineNo}</span>
                          ) : free.length > 0 ? (
                            <form
                              className="row"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void post(`items/${item.id}/resolve`, {
                                  bookingItemId: field(new FormData(e.currentTarget), 'line'),
                                });
                              }}
                            >
                              <select
                                name="line"
                                required
                                defaultValue=""
                                aria-label={t('bookingLine')}
                              >
                                <option value="" disabled>
                                  —
                                </option>
                                {free.map((l) => (
                                  <option key={l.id} value={l.id}>
                                    {l.lineNo} · {l.quantity} {l.description ?? ''}
                                  </option>
                                ))}
                              </select>
                              <button type="submit" disabled={busy}>
                                {t('resolveItem')}
                              </button>
                            </form>
                          ) : (
                            <span className="muted">{t('addBookingLine')}</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {r.photos.length > 0 && (
        <div className="card stack">
          <h2>{t('photosTitle', { count: r.photos.length })}</h2>
          <div className="row">
            {r.photos.map((p) => {
              const src = `/api/v1/cs-booking-requests/${r.id}/photos/${p.id}`;
              return (
                <a key={p.id} href={src} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- an API-served photo behind the session, not a static asset */}
                  <img
                    src={src}
                    alt={t('photoAlt')}
                    loading="lazy"
                    style={{ inlineSize: '8rem', blockSize: '8rem', objectFit: 'cover' }}
                  />
                </a>
              );
            })}
          </div>
        </div>
      )}

      <BotRequestEstimate
        request={r}
        master={master}
        busy={busy}
        onEstimate={(body) => void post('estimate', body)}
      />

      {r.actions.canSetDropOff && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            const dropOffId = field(new FormData(e.currentTarget), 'dropOffId');
            if (dropOffId) void post('drop-off', { version: r.version, dropOffId });
          }}
        >
          <h2>{t('dropOffTitle')}</h2>
          <p className="muted">{t('dropOffHint')}</p>
          <label className="field">
            {t('dropOff')}
            <select name="dropOffId" required defaultValue={r.dropOffId ?? ''}>
              <option value="" disabled>
                —
              </option>
              {r.dropOffChoices
                .filter((d) => d.branchId === r.branchId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {localName(d)} ({d.code})
                  </option>
                ))}
            </select>
          </label>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {t('dropOffAction')}
            </button>
          </div>
        </form>
      )}

      {r.actions.canCloseCancelRequest && (
        <div className="card stack">
          <h2>{t('cancelRequestTitle')}</h2>
          <p className="muted">{t('cancelRequestHint')}</p>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void post('cancel-request/close', { version: r.version })}
            >
              {t('cancelRequestCloseAction')}
            </button>
          </div>
        </div>
      )}

      {r.actions.canRoute && (
        <form className="card stack" onSubmit={route}>
          <h2>{t('routeTitle')}</h2>
          <label className="field">
            {t('branch')}
            <select name="branchId" required defaultValue="">
              <option value="" disabled>
                {t('chooseBranch')}
              </option>
              {routeTo.map((b) => (
                <option key={b} value={b}>
                  {branchName(b)}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('routeAction')}
            </button>
          </div>
        </form>
      )}

      {r.actions.canReject && (
        <form className="card stack" onSubmit={reject}>
          <h2>{t('rejectTitle')}</h2>
          <label className="field">
            {t('rejectReason')}
            <select name="reasonCode" required defaultValue="">
              <option value="" disabled>
                {t('chooseReason')}
              </option>
              {reasons.map((x) => (
                <option key={x.code} value={x.code}>
                  {locale === 'ar' ? x.textAr : x.textEn}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('internalNote')}
            <textarea name="internalNote" maxLength={1000} rows={2} />
            <span className="muted">{t('internalNoteHint')}</span>
          </label>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {t('rejectAction')}
            </button>
          </div>
        </form>
      )}
      {r.actions.canApprove && master && (
        <BotRequestApprove
          request={r}
          master={master}
          busy={busy}
          onApprove={(body) => void post('approve', body)}
        />
      )}
    </section>
  );
}
