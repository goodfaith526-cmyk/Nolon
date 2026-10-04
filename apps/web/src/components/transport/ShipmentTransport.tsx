'use client';

import type { PodDto, ShipmentDto, ShipmentPodsDto, ShipmentTripDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { StatusBadge } from '../StatusBadge';
import { PodForm } from './PodForm';
import { TripKindLabel, useDateTime } from './common';
import { PrintLink } from '../print/PrintLink';

/** The shipment's trips: one per road leg, in order. */
export function ShipmentTrips({ shipmentId }: { shipmentId: string }) {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const master = useMasterData();
  const locationName = useLocationName(master);
  const dateTime = useDateTime();
  const failure = useFailureText();
  const [trips, setTrips] = useState<ShipmentTripDto[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ShipmentTripDto[]>(`/shipments/${shipmentId}/trips`)
      .then((list) => {
        if (!cancelled) setTrips(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [shipmentId, failure]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('shipmentTrips')}</h2>
      </div>
      <Notice notice={notice} />
      {trips === null ? (
        !notice && <p className="empty">{tc('loading')}</p>
      ) : trips.length === 0 ? (
        <p className="empty">{t('noShipmentTrips')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('route')}</th>
                <th>{t('kind')}</th>
                <th>{t('vehicle')}</th>
                <th>{t('actualDeparture')}</th>
                <th>{t('actualArrival')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((trip) => (
                <tr key={trip.id} className={trip.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td dir="ltr">
                    <Link href={`/trips/${trip.id}`}>{trip.number}</Link>
                  </td>
                  <td>
                    {tc('route', {
                      from: locationName(trip.originLocationId),
                      to: locationName(trip.destinationLocationId),
                    })}
                  </td>
                  <td>
                    <TripKindLabel kind={trip.kind} />
                  </td>
                  <td>
                    <bdi dir="ltr">{trip.vehicleLabel ?? '—'}</bdi>
                    {trip.driverLabel && <div className="muted">{trip.driverLabel}</div>}
                  </td>
                  <td>{dateTime(trip.actualDeparture)}</td>
                  <td>{dateTime(trip.actualArrival)}</td>
                  <td>
                    <StatusBadge kind="trip" status={trip.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Proofs of delivery of the shipment, and the form to record one. */
export function ShipmentPods({
  shipment,
  onShipmentChanged,
}: {
  shipment: ShipmentDto;
  onShipmentChanged: () => void;
}) {
  const t = useTranslations('Transport');
  const tp = useTranslations('Print');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const dateTime = useDateTime();
  const failure = useFailureText();
  const [data, setData] = useState<ShipmentPodsDto | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const shipmentId = shipment.id;

  const load = useCallback(() => {
    api<ShipmentPodsDto>(`/shipments/${shipmentId}/pods`)
      .then(setData)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [shipmentId, failure]);

  useEffect(load, [load]);

  function onSaved(pod: PodDto) {
    setOpen(false);
    setNotice({
      ok: true,
      text: pod.statusApplied
        ? t('podSavedMoved', { number: pod.number, status: te(`shipment_${pod.statusApplied}`) })
        : t('podSaved', { number: pod.number }),
    });
    load();
    if (pod.statusApplied) onShipmentChanged();
  }

  const fileUrl = (documentId: string) =>
    `/api/v1/shipments/${shipmentId}/documents/${documentId}/file`;

  return (
    <div className="panel" id="pod">
      <div className="panel-head">
        <h2>{t('podSection')}</h2>
        {data?.actions.canRecord && !open && (
          <button type="button" className="primary" onClick={() => setOpen(true)}>
            {t('recordPod')}
          </button>
        )}
      </div>
      <div className="panel-body stack">
        <Notice notice={notice} />
        {open && data && (
          <PodForm
            shipmentId={shipmentId}
            actions={data.actions}
            onSaved={onSaved}
            onCancel={() => setOpen(false)}
          />
        )}
      </div>
      {data === null ? (
        !notice && <p className="empty">{tc('loading')}</p>
      ) : data.pods.length === 0 ? (
        <p className="empty">{t('noPods')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('deliveredAt')}</th>
                <th>{t('recipientName')}</th>
                <th>{t('podPackages')}</th>
                <th>{t('trip')}</th>
                <th>{t('files')}</th>
              </tr>
            </thead>
            <tbody>
              {[...data.pods].reverse().map((p) => (
                <tr key={p.id}>
                  <td>
                    <span dir="ltr" className="nowrap">
                      {p.number}
                    </span>
                    {p.statusApplied && (
                      <div>
                        <StatusBadge kind="shipment" status={p.statusApplied} />
                      </div>
                    )}
                    <PrintLink
                      href={`/shipments/${shipmentId}/pods/${p.id}`}
                      label={tp('printDeliveryNote')}
                      small
                    />
                  </td>
                  <td>
                    {dateTime(p.deliveredAt)}
                    <div className="muted">{p.createdByName}</div>
                  </td>
                  <td>
                    {p.recipientName}
                    <div className="muted">{p.recipientCapacity}</div>
                    {p.note && <div className="pre">{p.note}</div>}
                  </td>
                  <td>{p.packages ?? '—'}</td>
                  <td dir="ltr">{p.tripNumber ?? '—'}</td>
                  <td>
                    <div className="stack tight">
                      <a href={fileUrl(p.signatureDocumentId)}>{t('signature')}</a>
                      {p.photos.map((ph) => (
                        <a key={ph.documentId} href={fileUrl(ph.documentId)}>
                          {ph.fileName}
                        </a>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
