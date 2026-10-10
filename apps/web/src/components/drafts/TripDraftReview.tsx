'use client';

import type { TripDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { TripKindLabel, useDateTime } from '../transport/common';
import { DraftFrame } from './DraftFrame';

/** A trip the assistant proposed: its route, fleet and shipments as proposed, and the decision. */
export function TripDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tt = useTranslations('Transport');
  const tc = useTranslations('Common');
  const master = useMasterData();
  const locationName = useLocationName(master);
  const dateTime = useDateTime();
  const { record: draft, notice, setRecord } = useRecord<TripDraftDto>(`/trip-drafts/${id}`);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const trip = draft.request;
  const from = locationName(trip.originLocationId);
  const to = locationName(trip.destinationLocationId);

  return (
    <DraftFrame
      draft={draft}
      apiPath="/trip-drafts"
      title={t('tripTitle', { route: tc('route', { from, to }) })}
      approveHint={t('tripApproveHint')}
      result={
        draft.tripId ? { label: draft.tripNumber ?? '', href: `/trips/${draft.tripId}` } : null
      }
      onChanged={setRecord}
    >
      <dl className="details">
        <dt>{tt('kind')}</dt>
        <dd>
          <TripKindLabel kind={trip.kind} />
        </dd>
        <dt>{tt('route')}</dt>
        <dd>{tc('route', { from, to })}</dd>
        <dt>{tt('plannedDeparture')}</dt>
        <dd>{dateTime(trip.plannedDeparture ?? null)}</dd>
        <dt>{tt('plannedArrival')}</dt>
        <dd>{dateTime(trip.plannedArrival ?? null)}</dd>
        {trip.kind === 'OWN' ? (
          <>
            <dt>{tt('vehicle')}</dt>
            <dd dir="ltr">{draft.vehiclePlate ?? '—'}</dd>
            <dt>{tt('driver')}</dt>
            <dd>{draft.driverName ?? '—'}</dd>
          </>
        ) : (
          <>
            <dt>{tt('carrier')}</dt>
            <dd>{draft.carrierName ?? '—'}</dd>
            <dt>{tt('externalVehicle')}</dt>
            <dd dir="ltr">{trip.externalVehicle ?? '—'}</dd>
            <dt>{tt('externalDriver')}</dt>
            <dd>{trip.externalDriver ?? '—'}</dd>
            {trip.agreedCost && trip.currency ? (
              <>
                <dt>{tt('agreedCost')}</dt>
                <dd>
                  <Money value={trip.agreedCost} currency={trip.currency} />
                </dd>
              </>
            ) : null}
          </>
        )}
        <dt>{tt('note')}</dt>
        <dd>{trip.notes ?? '—'}</dd>
        <dt>{tt('shipmentsSection')}</dt>
        <dd dir="ltr">
          {trip.shipmentIds.map((shipmentId, i) => {
            const number = draft.shipmentNumbers[i] ?? '—';
            return (
              <span key={shipmentId}>
                {i > 0 ? ' · ' : ''}
                {/* A shipment the reviewer cannot see shows as a dash. */}
                {number === '—' ? number : <Link href={`/shipments/${shipmentId}`}>{number}</Link>}
              </span>
            );
          })}
        </dd>
      </dl>
    </DraftFrame>
  );
}
