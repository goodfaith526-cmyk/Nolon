'use client';

import { TRIP_STATUSES, type Page, type TripStatus, type TripSummaryDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useBranchCode } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { TripKindLabel, useDateTime } from './common';

/**
 * Trips of the user's branches (a driver: the trips assigned to them). A table on wide screens,
 * cards on a phone.
 */
export function Trips() {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const branchCode = useBranchCode(me);
  const dateTime = useDateTime();
  const failure = useFailureText();
  const [status, setStatus] = useState<TripStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<TripSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<TripSummaryDto>>(`/trips?pageSize=50${filter}&q=${encodeURIComponent(query)}`)
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'transport_trips:view')) return <p className="error">{tc('noAccess')}</p>;

  const route = (trip: TripSummaryDto) =>
    tc('route', {
      from: locationName(trip.originLocationId),
      to: locationName(trip.destinationLocationId),
    });

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('tripsTitle')}</h1>
          <p className="muted">{t('tripsHint')}</p>
        </div>
        {can(me, 'transport_trips:create') && can(me, 'transport_fleet:view') && (
          <Link href="/trips/new" className="button primary">
            {t('newTrip')}
          </Link>
        )}
      </div>
      <Notice notice={notice} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          load(q);
        }}
      >
        <input
          type="search"
          value={q}
          placeholder={t('tripSearch')}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as TripStatus | '')}>
          <option value="">{tc('all')}</option>
          {TRIP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`trip_${s}`)}
            </option>
          ))}
        </select>
        <button type="submit">{tc('search')}</button>
      </form>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="empty">{t('noTrips')}</p>
      ) : (
        <>
          <div className="table-wrap wide-only">
            <table>
              <thead>
                <tr>
                  <th>{t('number')}</th>
                  <th>{t('route')}</th>
                  <th>{t('kind')}</th>
                  <th>{t('vehicle')}</th>
                  <th>{t('driver')}</th>
                  <th>{t('shipmentsCount')}</th>
                  <th>{t('departure')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((trip) => (
                  <tr key={trip.id} className={trip.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td dir="ltr">
                      <Link href={`/trips/${trip.id}`}>{trip.number}</Link>
                      <div className="muted">{branchCode(trip.branchId)}</div>
                    </td>
                    <td>{route(trip)}</td>
                    <td>
                      <TripKindLabel kind={trip.kind} />
                      {trip.carrierName && <div className="muted">{trip.carrierName}</div>}
                    </td>
                    <td dir="ltr">{trip.vehicleLabel ?? '—'}</td>
                    <td>{trip.driverLabel ?? '—'}</td>
                    <td>{trip.shipmentCount}</td>
                    <td>{dateTime(trip.actualDeparture ?? trip.plannedDeparture)}</td>
                    <td>
                      <StatusBadge kind="trip" status={trip.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="trip-cards narrow-only">
            {page.items.map((trip) => (
              <li key={trip.id}>
                <Link href={`/trips/${trip.id}`} className="trip-card">
                  <div className="row">
                    <strong dir="ltr">{trip.number}</strong>
                    <StatusBadge kind="trip" status={trip.status} />
                  </div>
                  <div>{route(trip)}</div>
                  <div className="muted">
                    <bdi dir="ltr">{trip.vehicleLabel ?? '—'}</bdi>
                    {' · '}
                    {trip.driverLabel ?? '—'}
                  </div>
                  <div className="muted">
                    {t('departure')}: {dateTime(trip.actualDeparture ?? trip.plannedDeparture)}
                    {' · '}
                    {t('shipmentsN', { count: trip.shipmentCount })}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
