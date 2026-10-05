'use client';

import type { BookingDto, QuotationDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { failureStatus, useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { Money } from '../finance/common';
import { StatusBadge } from '../StatusBadge';
import { Notice, type NoticeState, useFailureText } from './Notice';
import { PrintLink } from '../print/PrintLink';

export function QuotationDetail({ id }: { id: string }) {
  const t = useTranslations('Quotations');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const name = useLocalName();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const router = useRouter();
  const [quotation, setQuotation] = useState<QuotationDto | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<QuotationDto>(`/quotations/${id}`)
      .then(setQuotation)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [id, failure]);

  useEffect(load, [load]);

  if (!quotation) {
    return notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function act(action: string, success: string, body?: unknown) {
    setNotice(null);
    try {
      setQuotation(
        await api<QuotationDto>(`/quotations/${id}/${action}`, { method: 'POST', body }),
      );
      setRejecting(false);
      setNotice({ ok: true, text: success });
    } catch (e) {
      // An approval after the validity date marks the quotation expired.
      if (failureStatus(e) === 409 && action !== 'expire') load();
      setNotice({ ok: false, text: failure(e) });
    }
  }

  async function toBooking() {
    setNotice(null);
    try {
      const booking = await api<BookingDto>(`/bookings/from-quotation/${id}`, {
        method: 'POST',
        body: {},
      });
      router.push(`/bookings/${booking.id}`);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  const chargeName = (code: string) => {
    const charge = master?.chargeTypes.find((c) => c.code === code);
    return charge ? name(charge) : code;
  };
  const status = quotation.status;

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('quotation')} <span dir="ltr">{quotation.number}</span>
        </h1>
        <StatusBadge kind="quotation" status={status} />
      </div>
      <Notice notice={notice} />
      <div className="actions">
        <PrintLink href={`/quotations/${id}`} />
        {status === 'DRAFT' && can(me, 'quotations:update') && (
          <>
            <Link href={`/quotations/${id}/edit`} className="button">
              {tc('edit')}
            </Link>
            <button type="button" className="primary" onClick={() => void act('send', t('sent'))}>
              {t('send')}
            </button>
          </>
        )}
        {status === 'SENT' && can(me, 'quotations:approve') && (
          <>
            <button
              type="button"
              className="primary"
              onClick={() => void act('approve', t('approvedNotice'))}
            >
              {t('approve')}
            </button>
            <button type="button" onClick={() => setRejecting(true)}>
              {t('reject')}
            </button>
          </>
        )}
        {(status === 'DRAFT' || status === 'SENT') && can(me, 'quotations:cancel') && (
          <button type="button" onClick={() => void act('expire', t('expiredNotice'))}>
            {t('expire')}
          </button>
        )}
        {status === 'APPROVED' && quotation.bookingId === null && can(me, 'bookings:create') && (
          <button type="button" className="primary" onClick={() => void toBooking()}>
            {t('toBooking')}
          </button>
        )}
        {quotation.bookingId && (
          <Link href={`/bookings/${quotation.bookingId}`} className="button">
            {t('openBooking')}
          </Link>
        )}
      </div>
      {rejecting && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act('reject', t('rejectedNotice'), { reason });
          }}
        >
          <label className="field">
            {t('rejectionReason')}
            <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="primary">
              {t('reject')}
            </button>
            <button type="button" onClick={() => setRejecting(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}

      <dl className="details">
        <dt>{t('customer')}</dt>
        <dd>
          <Link href={`/customers/${quotation.customerId}`}>{quotation.customerName}</Link>
        </dd>
        <dt>{t('route')}</dt>
        <dd>
          {tc('route', {
            from: locationName(quotation.originLocationId),
            to: locationName(quotation.destinationLocationId),
          })}
        </dd>
        <dt>{t('mode')}</dt>
        <dd>
          {te(`mode_${quotation.mode}`)}
          {quotation.loadType ? ` · ${quotation.loadType}` : ''} ·{' '}
          {te(`cargo_${quotation.cargoType}`)}
        </dd>
        <dt>{t('validUntil')}</dt>
        <dd dir="ltr">{quotation.validUntil}</dd>
        {quotation.cargoDescription && (
          <>
            <dt>{t('cargoDescription')}</dt>
            <dd>{quotation.cargoDescription}</dd>
          </>
        )}
        {quotation.rejectionReason && (
          <>
            <dt>{t('rejectionReason')}</dt>
            <dd>{quotation.rejectionReason}</dd>
          </>
        )}
      </dl>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('chargeType')}</th>
              <th>{t('quantity')}</th>
              <th className="num">{t('unitPrice')}</th>
              <th className="num">{t('discount')}</th>
              <th className="num">{t('lineTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {quotation.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.lineNo}</td>
                <td>
                  {chargeName(l.chargeTypeCode)}
                  {l.description ? <div className="muted">{l.description}</div> : null}
                </td>
                <td dir="ltr">
                  {l.quantity} × {te(`unit_${l.unit}`)}
                </td>
                <td dir="ltr" className="num">
                  <Money value={l.unitPrice} />
                  {l.minimumCharge !== '0' ? (
                    <div className="muted">
                      {t('minimum')}: <Money value={l.minimumCharge} />
                    </div>
                  ) : null}
                </td>
                <td dir="ltr" className="num">
                  <Money value={l.discount} />
                </td>
                <td dir="ltr" className="num">
                  <Money value={l.lineTotal} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>{t('subtotal')}</td>
              <td dir="ltr" className="num">
                <Money value={quotation.subtotal} />
              </td>
            </tr>
            <tr>
              <td colSpan={5}>{t('discountTotal')}</td>
              <td dir="ltr" className="num">
                <Money value={quotation.discountTotal} />
              </td>
            </tr>
            <tr>
              <th colSpan={5}>{t('total')}</th>
              <th dir="ltr" className="num">
                <Money value={quotation.total} currency={quotation.currency} />
              </th>
            </tr>
          </tfoot>
        </table>
      </div>
      {quotation.terms && <p className="pre">{quotation.terms}</p>}
    </section>
  );
}
