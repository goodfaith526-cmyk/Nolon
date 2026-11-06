'use client';

import type { WindowDeskBookingDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Money, useRecord } from '../finance/common';
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

/**
 * Plan 13-5 (owner, 2026-11-06): the waybill the window hands the customer for the parcel, as
 * soon as it is received, read from the window desk: the shipment's number (the waybill's), the
 * sender and receiver, the route, what was received and the cargo lines. No prices.
 */
export function WindowWaybillPrint({ bookingId }: { bookingId: string }) {
  const tp = useTranslations('Print');
  const tw = useTranslations('Warehouse');
  const td = useTranslations('WindowDesk');
  const locale = useLocale();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const dateTime = useDateTime();
  const { record: r, notice } = useRecord<WindowDeskBookingDto>(
    `/window-desk/bookings/${bookingId}`,
  );
  if (!r) return <PrintPending notice={notice} />;
  const first = r.receipts[0];
  if (!first) return <PrintPending notice={{ ok: false, text: tp('notFound') }} />;
  const windowName = locale === 'ar' ? r.window.name.ar : r.window.name.en;
  const weights = r.receipts.flatMap((m) => (m.weightKg ? [Number(m.weightKg)] : []));
  return (
    <>
      <PageStyle />
      <PrintToolbar back="/window-desk" ready={master !== null} />
      <DocumentSheet
        title={tp('waybillTitle')}
        number={r.shipmentNumber}
        date={dateTime(first.occurredAt)}
        branchId={r.branchId}
      >
        <DocSection title={tp('shipmentDetails')}>
          <DocFields
            fields={[
              [tp('bookingNumber'), <span dir="ltr">{r.bookingNumber}</span>],
              [td('sender'), r.sender.name],
              [tp('phone'), r.sender.phone && <span dir="ltr">{r.sender.phone}</span>],
              [td('receiver'), r.receiver?.name],
              [tp('phone'), r.receiver?.phone && <span dir="ltr">{r.receiver.phone}</span>],
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
              [
                tw('packages'),
                <span dir="ltr">{r.receipts.reduce((sum, m) => sum + m.packages, 0)}</span>,
              ],
              [
                tw('weightKg'),
                weights.length > 0 && (
                  <span dir="ltr">{weights.reduce((sum, w) => sum + w, 0)}</span>
                ),
              ],
            ]}
          />
        </DocSection>
        <DocSection title={tp('shipmentCargo')}>
          <ItemsTable items={r.items} />
        </DocSection>
        <p className="muted">{tp('waybillNote')}</p>
        <SignatureBoxes labels={[tp('signDeliveredBy'), tp('signWarehouseKeeper')]} />
      </DocumentSheet>
    </>
  );
}

/**
 * Plan 13 section 4: printout 11, the receipt voucher, of a payment taken at a window, read from
 * the window desk (the outlet cannot open the receipt): the amount, the invoices it paid, and the
 * window's and the outlet's names. The window hands it to the customer.
 */
export function WindowPaymentPrint({
  bookingId,
  receiptId,
}: {
  bookingId: string;
  receiptId: string;
}) {
  const tr = useTranslations('Receipts');
  const tp = useTranslations('Print');
  const td = useTranslations('WindowDesk');
  const locale = useLocale();
  const { record: r, notice } = useRecord<WindowDeskBookingDto>(
    `/window-desk/bookings/${bookingId}`,
  );
  if (!r) return <PrintPending notice={notice} />;
  const p = r.payments.find((x) => x.id === receiptId);
  if (!p) return <PrintPending notice={{ ok: false, text: tp('notFound') }} />;
  const windowName = locale === 'ar' ? r.window.name.ar : r.window.name.en;
  return (
    <>
      <PageStyle />
      <PrintToolbar back="/window-desk" ready />
      <DocumentSheet
        title={tp('receiptTitle')}
        number={p.number}
        date={<span dir="ltr">{p.receiptDate}</span>}
        branchId={r.branchId}
      >
        <DocFields
          fields={[
            [td('sender'), r.sender.name],
            [tp('bookingNumber'), <span dir="ltr">{r.bookingNumber}</span>],
            [tp('shipmentNumber'), <span dir="ltr">{r.shipmentNumber}</span>],
            [td('window'), `${r.window.code} · ${windowName}`],
            [td('outlet'), r.window.outletName],
            [tr('reference'), p.reference && <span dir="ltr">{p.reference}</span>],
            [tp('recordedBy'), p.createdByName],
          ]}
        />
        <div className="doc-amount">
          <span>{tr('amount')}</span>
          <strong>
            <Money value={p.amount} currency={p.currency} />
          </strong>
        </div>
        <DocSection title={tr('allocations')}>
          <table className="doc-table">
            <thead>
              <tr>
                <th>{tr('invoice')}</th>
                <th className="num">{tr('allocatedAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {p.invoices.map((a, i) => (
                <tr key={`${a.number ?? ''}-${i}`}>
                  <td dir="ltr">{a.number}</td>
                  <td className="num">
                    <Money value={a.amount} currency={p.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DocSection>
        <SignatureBoxes labels={[tp('signCashier'), tp('signPayer')]} />
      </DocumentSheet>
    </>
  );
}
