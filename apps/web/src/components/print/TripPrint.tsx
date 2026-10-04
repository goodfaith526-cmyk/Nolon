'use client';

import type { TripDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { useRecord } from '../finance/common';
import {
  DocFields,
  DocSection,
  DocumentSheet,
  PageStyle,
  PrintPending,
  PrintToolbar,
  QrCode,
  SignatureBoxes,
  useDateTime,
  useQrSrc,
} from './PrintKit';

/** The tracking QR code of one shipment on the trip sheet. */
function ShipmentQr({ shipmentId }: { shipmentId: string }) {
  return <QrCode src={useQrSrc(shipmentId)} size={16} />;
}

/** Printout 8: trip sheet, the trip's route, vehicle, driver and shipments (each with its QR). */
export function TripPrint({ id }: { id: string }) {
  const t = useTranslations('Transport');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const locationName = useLocationName(master);
  const dateTime = useDateTime();
  const { record: trip, notice } = useRecord<TripDto>(`/trips/${id}`);
  if (!trip) return <PrintPending notice={notice} />;
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/trips/${id}`} ready={master !== null} />
      <DocumentSheet
        title={tp('tripSheetTitle')}
        number={trip.number}
        date={dateTime(trip.actualDeparture ?? trip.plannedDeparture)}
        branchId={trip.branchId}
        meta={<p>{te(`trip_${trip.status}`)}</p>}
        watermark={trip.status === 'CANCELLED' ? te('trip_CANCELLED') : null}
      >
        <DocSection title={tp('tripDetails')}>
          <DocFields
            fields={[
              [t('kind'), t(`kind_${trip.kind}`)],
              [t('origin'), locationName(trip.originLocationId)],
              [t('destination'), locationName(trip.destinationLocationId)],
              [t('vehicle'), trip.vehicleLabel && <span dir="ltr">{trip.vehicleLabel}</span>],
              [t('driver'), trip.driverLabel],
              [t('carrier'), trip.carrierName],
              [t('plannedDeparture'), trip.plannedDeparture && dateTime(trip.plannedDeparture)],
              [t('plannedArrival'), trip.plannedArrival && dateTime(trip.plannedArrival)],
              [t('actualDeparture'), trip.actualDeparture && dateTime(trip.actualDeparture)],
              [t('actualArrival'), trip.actualArrival && dateTime(trip.actualArrival)],
              [t('completedAt'), trip.completedAt && dateTime(trip.completedAt)],
              [t('note'), trip.notes && <span className="pre">{trip.notes}</span>],
              [t('cancelReason'), trip.cancelReason],
            ]}
          />
        </DocSection>
        <DocSection title={t('shipmentsN', { count: trip.shipmentCount })}>
          <table className="doc-table compact">
            <thead>
              <tr>
                <th>{t('shipment')}</th>
                <th>{t('customer')}</th>
                <th>{t('destination')}</th>
                <th>{tp('status')}</th>
                <th className="num">{t('packages')}</th>
                <th className="num">{t('weightKg')}</th>
                <th className="num">{t('volumeCbm')}</th>
                <th>{tp('qr')}</th>
                <th>{tp('receivedSignature')}</th>
              </tr>
            </thead>
            <tbody>
              {trip.shipments.map((s) => (
                <tr key={s.shipmentId}>
                  <td dir="ltr">{s.shipmentNumber}</td>
                  <td>{s.customerName}</td>
                  <td>{locationName(s.destinationLocationId)}</td>
                  <td>{te(`shipment_${s.status}`)}</td>
                  <td className="num" dir="ltr">
                    {s.packages}
                  </td>
                  <td className="num" dir="ltr">
                    {s.weightKg ?? '—'}
                  </td>
                  <td className="num" dir="ltr">
                    {s.volumeCbm ?? '—'}
                  </td>
                  <td className="qr-cell">
                    <ShipmentQr shipmentId={s.shipmentId} />
                  </td>
                  <td className="sign-cell" />
                </tr>
              ))}
            </tbody>
          </table>
        </DocSection>
        <SignatureBoxes labels={[tp('signDispatcher'), tp('signDriver')]} />
      </DocumentSheet>
    </>
  );
}
