'use client';

import type { BookingDto, CustomerDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { Notice, type NoticeState, useFailureText } from './Notice';

export function BookingDetail({ id }: { id: string }) {
  const t = useTranslations('Bookings');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const [booking, setBooking] = useState<BookingDto | null>(null);
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<BookingDto>(`/bookings/${id}`)
      .then((b) => {
        setBooking(b);
        if (can(me, 'customers:view')) {
          api<CustomerDto>(`/customers/${b.customerId}`)
            .then(setCustomer)
            .catch(() => undefined);
        }
      })
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [id, failure, me]);

  useEffect(load, [load]);

  if (!booking) {
    return notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function act(action: string, success: string, body?: unknown) {
    setNotice(null);
    try {
      setBooking(await api<BookingDto>(`/bookings/${id}/${action}`, { method: 'POST', body }));
      setCancelling(false);
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  const party = (partyId: string | null) =>
    partyId ? (customer?.parties.find((p) => p.id === partyId)?.name ?? '…') : '—';
  const status = booking.status;

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('booking')} <span dir="ltr">{booking.number}</span>
        </h1>
        <StatusBadge kind="booking" status={status} />
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {status === 'DRAFT' && can(me, 'bookings:update') && (
          <Link href={`/bookings/${id}/edit`} className="button">
            {tc('edit')}
          </Link>
        )}
        {status === 'DRAFT' && can(me, 'bookings:approve') && (
          <button
            type="button"
            className="primary"
            onClick={() => void act('confirm', t('confirmedNotice'))}
          >
            {t('confirm')}
          </button>
        )}
        {(status === 'DRAFT' || status === 'CONFIRMED') && can(me, 'bookings:cancel') && (
          <button type="button" onClick={() => setCancelling(true)}>
            {t('cancel')}
          </button>
        )}
        {booking.quotationId && (
          <Link href={`/quotations/${booking.quotationId}`} className="button">
            {t('openQuotation')}
          </Link>
        )}
        {booking.shipmentId && can(me, 'shipments:view') && (
          <Link href={`/shipments/${booking.shipmentId}`} className="button">
            {t('openShipment')} <span dir="ltr">{booking.shipmentNumber}</span>
          </Link>
        )}
      </div>
      {cancelling && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act('cancel', t('cancelledNotice'), { reason });
          }}
        >
          <label className="field">
            {t('cancelReason')}
            <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="primary">
              {t('cancel')}
            </button>
            <button type="button" onClick={() => setCancelling(false)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}

      <dl className="details">
        <dt>{t('customer')}</dt>
        <dd>{booking.customerName}</dd>
        <dt>{t('route')}</dt>
        <dd>
          {tc('route', {
            from: locationName(booking.originLocationId),
            to: locationName(booking.destinationLocationId),
          })}
        </dd>
        <dt>{t('mode')}</dt>
        <dd>
          {te(`mode_${booking.mode}`)}
          {booking.loadType ? ` · ${booking.loadType}` : ''} · {te(`cargo_${booking.cargoType}`)}
        </dd>
        <dt>{t('services')}</dt>
        <dd>
          {new Intl.ListFormat(locale).format(booking.services.map((s) => te(`service_${s}`)))}
        </dd>
        <dt>{t('shipperId')}</dt>
        <dd>{party(booking.shipperId)}</dd>
        <dt>{t('consigneeId')}</dt>
        <dd>{party(booking.consigneeId)}</dd>
        <dt>{t('notifyPartyId')}</dt>
        <dd>{party(booking.notifyPartyId)}</dd>
        <dt>{t('requestedDeparture')}</dt>
        <dd dir="ltr">{booking.requestedDeparture ?? '—'}</dd>
        {booking.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd>{booking.cancelReason}</dd>
          </>
        )}
      </dl>

      <h2>{t('items')}</h2>
      {booking.items.length === 0 ? (
        <p className="muted">{t('noItems')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('cargoType')}</th>
                <th>{t('quantity')}</th>
                <th>{t('dimensions')}</th>
                <th>{t('weightKg')}</th>
                <th>{t('volumeCbm')}</th>
              </tr>
            </thead>
            <tbody>
              {booking.items.map((i) => (
                <tr key={i.lineNo}>
                  <td>{i.lineNo}</td>
                  <td>
                    {te(`cargo_${i.cargoType}`)}
                    {i.containerTypeCode ? ` · ${i.containerTypeCode}` : ''}
                    {i.description ? <div className="muted">{i.description}</div> : null}
                  </td>
                  <td>{i.quantity}</td>
                  <td dir="ltr">
                    {i.lengthCm ? `${i.lengthCm} × ${i.widthCm ?? ''} × ${i.heightCm ?? ''}` : '—'}
                  </td>
                  <td dir="ltr">{i.weightKg ?? '—'}</td>
                  <td dir="ltr">{i.volumeCbm ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
