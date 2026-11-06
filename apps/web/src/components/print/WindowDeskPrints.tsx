'use client';

import type { WindowDeskBookingDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { useRecord } from '../finance/common';
import { ItemsTable } from './CommercialPrints';
import {
  DocFields,
  DocSection,
  DocumentSheet,
  PageStyle,
  PrintPending,
  PrintToolbar,
  SignatureBoxes,
  useDateTime,
} from './PrintKit';

/**
 * Plan 13 section 3: printout 6, the goods received note (GRN), of a receipt made at a window,
 * read from the window desk (the outlet cannot open the shipment): the same sections as the
 * staff printout, with the window's and the outlet's names.
 */
export function WindowReceiptPrint({
  bookingId,
  movementId,
}: {
  bookingId: string;
  movementId: string;
}) {
  const tw = useTranslations('Warehouse');
  const tp = useTranslations('Print');
  const td = useTranslations('WindowDesk');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const dateTime = useDateTime();
  const { record: r, notice } = useRecord<WindowDeskBookingDto>(
    `/window-desk/bookings/${bookingId}`,
  );
  if (!r) return <PrintPending notice={notice} />;
  const m = r.receipts.find((x) => x.id === movementId);
  if (!m) return <PrintPending notice={{ ok: false, text: tp('notFound') }} />;
  const windowName = locale === 'ar' ? r.window.name.ar : r.window.name.en;
  return (
    <>
      <PageStyle />
      <PrintToolbar back="/window-desk" ready={master !== null} />
      <DocumentSheet
        title={tp('grnTitle')}
        number={m.number}
        date={dateTime(m.occurredAt)}
        branchId={r.branchId}
      >
        <DocSection title={tp('shipmentDetails')}>
          <DocFields
            fields={[
              [tp('shipmentNumber'), <span dir="ltr">{r.shipmentNumber}</span>],
              [tp('bookingNumber'), <span dir="ltr">{r.bookingNumber}</span>],
              [td('sender'), r.sender.name],
              [td('receiver'), r.receiver?.name],
              [
                tp('route'),
                tp('routeNames', {
                  from: locationName(r.originLocationId),
                  to: locationName(r.destinationLocationId),
                }),
              ],
            ]}
          />
        </DocSection>
        <DocSection title={tw('receiptTitle')}>
          <DocFields
            fields={[
              [td('window'), `${r.window.code} · ${windowName}`],
              [td('outlet'), r.window.outletName],
              [tw('packages'), <span dir="ltr">{m.packages}</span>],
              [tw('weightKg'), m.weightKg && <span dir="ltr">{m.weightKg}</span>],
              [tw('condition'), m.condition && te(`condition_${m.condition}`)],
              [tw('deliveredBy'), m.partyName],
              [
                tw('partyId'),
                (m.partyIdType || m.partyIdNumber) &&
                  [m.partyIdType, m.partyIdNumber].filter(Boolean).join(' '),
              ],
              [tw('note'), m.note && <span className="pre">{m.note}</span>],
              [tp('recordedBy'), m.createdByName],
            ]}
          />
        </DocSection>
        <DocSection title={tp('shipmentCargo')}>
          <ItemsTable items={r.items} />
        </DocSection>
        <SignatureBoxes labels={[tp('signDeliveredBy'), tp('signWarehouseKeeper')]} />
      </DocumentSheet>
    </>
  );
}
