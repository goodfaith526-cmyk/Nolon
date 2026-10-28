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
        {r.internalNote && (
          <>
            <dt>{t('internalNote')}</dt>
            <dd className="pre">{r.internalNote}</dd>
          </>
        )}
      </dl>

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
