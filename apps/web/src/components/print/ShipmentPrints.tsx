'use client';

import type { ShipmentDto, ShipmentPodsDto, ShipmentWarehouseDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { Link } from '@/i18n/navigation';
import { packageLabels } from '@/lib/print';
import { useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { CustomerBlock, ItemsTable, PartyText, useCustomer } from './CommercialPrints';
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

/** Printout 3: shipment sheet, a summary of the shipment, its cargo and its parties. */
export function ShipmentSheetPrint({ id }: { id: string }) {
  const t = useTranslations('Shipments');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const { record: s, notice } = useRecord<ShipmentDto>(`/shipments/${id}`);
  const customer = useCustomer(s?.customerId ?? null);
  const qr = useQrSrc(s?.id ?? null);
  if (!s) return <PrintPending notice={notice} />;
  const list = new Intl.ListFormat(locale);
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/shipments/${id}`} ready={master !== null && qr !== null} />
      <DocumentSheet
        title={tp('shipmentSheetTitle')}
        number={s.number}
        date={<span dir="ltr">{s.createdAt.slice(0, 10)}</span>}
        branchId={s.branchId}
        qr={qr}
        meta={<p>{te(`shipment_${s.status}`)}</p>}
      >
        <div className="doc-columns">
          <CustomerBlock name={s.customerName} customer={customer} />
          <DocFields
            fields={[
              [tp('bookingNumber'), <span dir="ltr">{s.bookingNumber}</span>],
              [t('etd'), s.etd && <span dir="ltr">{s.etd}</span>],
              [t('eta'), s.eta && <span dir="ltr">{s.eta}</span>],
              [t('currentLocation'), s.currentLocationId && locationName(s.currentLocationId)],
            ]}
          />
        </div>
        <DocSection title={tp('shipmentDetails')}>
          <DocFields
            fields={[
              [tp('origin'), locationName(s.originLocationId)],
              [tp('destination'), locationName(s.destinationLocationId)],
              [
                t('mode'),
                `${te(`mode_${s.mode}`)}${s.loadType ? ` · ${s.loadType}` : ''} · ${te(`cargo_${s.cargoType}`)}`,
              ],
              [t('services'), list.format(s.services.map((x) => te(`service_${x}`)))],
              [
                t('carrierName'),
                [s.carrierName, s.vesselName, s.voyageNumber].filter(Boolean).join(' · '),
              ],
              [t('blNumber'), s.blNumber && <span dir="ltr">{s.blNumber}</span>],
              [tp('cargoDescription'), s.cargoDescription],
              [t('holdReason'), s.holdReason],
              [t('cancelReason'), s.cancelReason],
            ]}
          />
        </DocSection>
        <DocSection title={tp('parties')}>
          <DocFields
            fields={[
              [t('shipper'), <PartyText customer={customer} id={s.shipperId} />],
              [t('consignee'), <PartyText customer={customer} id={s.consigneeId} />],
              [tp('notifyParty'), <PartyText customer={customer} id={s.notifyPartyId} />],
            ]}
          />
        </DocSection>
        <DocSection title={t('items')}>
          <ItemsTable items={s.items} />
        </DocSection>
        {s.containers.length > 0 && (
          <DocSection title={t('containers')}>
            <table className="doc-table">
              <thead>
                <tr>
                  <th>{t('containerNumber')}</th>
                  <th>{t('containerType')}</th>
                  <th>{t('sealNumber')}</th>
                </tr>
              </thead>
              <tbody>
                {s.containers.map((c) => (
                  <tr key={c.id}>
                    <td dir="ltr">{c.containerNumber}</td>
                    <td dir="ltr">{c.containerTypeCode}</td>
                    <td dir="ltr">{c.sealNumber ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DocSection>
        )}
      </DocumentSheet>
    </>
  );
}

/**
 * Printout 4: package labels, one per package (pallet, barrel, piece) on a 100 × 150 mm label,
 * numbered across the shipment, with the tracking QR code. `line` prints one cargo line only.
 */
export function PackageLabelsPrint({
  id,
  line,
  from,
}: {
  id: string;
  line?: number;
  from?: number;
}) {
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const name = useLocalName();
  const { record: s, notice } = useRecord<ShipmentDto>(`/shipments/${id}`);
  const qr = useQrSrc(s?.id ?? null);
  if (!s) return <PrintPending notice={notice} />;
  const total = s.packages;
  const { labels, nextFrom } = packageLabels(s.items, total, { onlyLine: line, from });
  const nextHref =
    nextFrom === null
      ? null
      : `/print/shipments/${id}/labels?${new URLSearchParams({
          ...(line === undefined ? {} : { line: String(line) }),
          from: String(nextFrom),
        }).toString()}`;
  const location = (locationId: string) => {
    const l = master?.locations.find((x) => x.id === locationId);
    return l ? { code: l.code, name: name(l) } : { code: '…', name: '' };
  };
  const origin = location(s.originLocationId);
  const destination = location(s.destinationLocationId);
  return (
    <>
      <PageStyle size="100mm 150mm" margin="0" />
      <PrintToolbar back={`/shipments/${id}`} ready={master !== null && qr !== null}>
        <span>{tp('labelsCount', { count: labels.length, total })}</span>
      </PrintToolbar>
      {nextHref && (
        <p className="error no-print">
          {tp('labelsTruncated', { count: labels.length })}{' '}
          <Link href={nextHref}>{tp('labelsNext', { from: nextFrom ?? 0 })}</Link>
        </p>
      )}
      {labels.length === 0 && <p className="muted no-print">{tp('noPackages')}</p>}
      <div className="labels">
        {labels.map((label) => (
          <section key={label.index} className="label">
            <div className="label-head">
              <strong>NOLON</strong>
              <span dir="ltr">{s.number}</span>
            </div>
            <div className="label-route" dir="ltr">
              <span>{origin.code}</span>
              <span aria-hidden="true">→</span>
              <span>{destination.code}</span>
            </div>
            <div className="label-places">
              {tp('routeNames', { from: origin.name, to: destination.name })}
            </div>
            <div className="label-count">
              <span>{tp('package')}</span>
              <strong dir="ltr">
                {label.index} / {label.total}
              </strong>
            </div>
            <div className="label-body">
              <div>
                <div>{s.customerName}</div>
                <div>
                  {te(`cargo_${label.line.cargoType}`)}
                  {label.line.containerTypeCode && (
                    <span dir="ltr"> · {label.line.containerTypeCode}</span>
                  )}
                </div>
                {label.line.description && <div className="muted">{label.line.description}</div>}
                {label.line.weightKg && (
                  <div>
                    {tp('lineWeight', { line: label.line.lineNo })}{' '}
                    <span dir="ltr">{label.line.weightKg} kg</span>
                  </div>
                )}
              </div>
              <QrCode src={qr} size={34} />
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

/**
 * Printouts 6 and 7: the goods received note (GRN) or the goods release note of one warehouse
 * movement, with the shipment's QR code and boxes for the signatures on paper.
 */
export function MovementPrint({ id, movementId }: { id: string; movementId: string }) {
  const tw = useTranslations('Warehouse');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const locationName = useLocationName(master);
  const name = useLocalName();
  const dateTime = useDateTime();
  const { record: s, notice } = useRecord<ShipmentDto>(`/shipments/${id}`);
  const { record: w, notice: wNotice } = useRecord<ShipmentWarehouseDto>(
    `/shipments/${id}/warehouse`,
  );
  const qr = useQrSrc(s?.id ?? null);
  if (!s || !w) return <PrintPending notice={notice ?? wNotice} />;
  const m = w.movements.find((x) => x.id === movementId);
  if (!m) return <PrintPending notice={{ ok: false, text: tp('notFound') }} />;
  const warehouse = w.balances.find((b) => b.warehouseId === m.warehouseId);
  const receipt = m.kind === 'RECEIPT';
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/shipments/${id}`} ready={qr !== null} />
      <DocumentSheet
        title={receipt ? tp('grnTitle') : tp('releaseTitle')}
        number={m.number}
        date={dateTime(m.occurredAt)}
        branchId={s.branchId}
        qr={qr}
      >
        <DocSection title={tp('shipmentDetails')}>
          <DocFields
            fields={[
              [tp('shipmentNumber'), <span dir="ltr">{s.number}</span>],
              [tp('customer'), s.customerName],
              [
                tp('route'),
                tp('routeNames', {
                  from: locationName(s.originLocationId),
                  to: locationName(s.destinationLocationId),
                }),
              ],
              [tp('cargoDescription'), s.cargoDescription],
            ]}
          />
        </DocSection>
        <DocSection title={receipt ? tw('receiptTitle') : tw('releaseTitle')}>
          <DocFields
            fields={[
              [
                tw('warehouse'),
                warehouse ? `${warehouse.warehouseCode} · ${name(warehouse)}` : m.warehouseCode,
              ],
              [tw('storageLocation'), m.storageLocationCode],
              [tw('packages'), <span dir="ltr">{m.packages}</span>],
              [tw('weightKg'), m.weightKg && <span dir="ltr">{m.weightKg}</span>],
              [tw('condition'), m.condition && te(`condition_${m.condition}`)],
              [receipt ? tw('deliveredBy') : tw('collectedBy'), m.partyName],
              [tw('note'), m.note && <span className="pre">{m.note}</span>],
              [tp('recordedBy'), m.createdByName],
            ]}
          />
        </DocSection>
        <DocSection title={tp('shipmentCargo')}>
          <ItemsTable items={s.items} />
        </DocSection>
        <SignatureBoxes
          labels={
            receipt
              ? [tp('signDeliveredBy'), tp('signWarehouseKeeper')]
              : [tp('signWarehouseKeeper'), tp('signCollectedBy')]
          }
        />
      </DocumentSheet>
    </>
  );
}

/**
 * Printout 7 with its proof of delivery: the delivery note of one POD, with the recipient, their
 * capacity and the signature they gave on screen.
 */
export function DeliveryNotePrint({ id, podId }: { id: string; podId: string }) {
  const tt = useTranslations('Transport');
  const tp = useTranslations('Print');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const dateTime = useDateTime();
  const { record: s, notice } = useRecord<ShipmentDto>(`/shipments/${id}`);
  const { record: pods, notice: podNotice } = useRecord<ShipmentPodsDto>(`/shipments/${id}/pods`);
  const customer = useCustomer(s?.customerId ?? null);
  const qr = useQrSrc(s?.id ?? null);
  const [signatureFailed, setSignatureFailed] = useState(false);
  if (!s || !pods) return <PrintPending notice={notice ?? podNotice} />;
  const pod = pods.pods.find((p) => p.id === podId);
  if (!pod) return <PrintPending notice={{ ok: false, text: tp('notFound') }} />;
  const showSignature = can(me, 'documents:view') && !signatureFailed;
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/shipments/${id}`} ready={qr !== null} />
      <DocumentSheet
        title={tp('deliveryNoteTitle')}
        number={pod.number}
        date={dateTime(pod.deliveredAt)}
        branchId={s.branchId}
        qr={qr}
      >
        <DocSection title={tp('shipmentDetails')}>
          <DocFields
            fields={[
              [tp('shipmentNumber'), <span dir="ltr">{s.number}</span>],
              [tp('customer'), s.customerName],
              [tp('consignee'), <PartyText customer={customer} id={s.consigneeId} />],
              [tp('destination'), locationName(s.destinationLocationId)],
              [tt('trip'), pod.tripNumber && <span dir="ltr">{pod.tripNumber}</span>],
            ]}
          />
        </DocSection>
        <DocSection title={tp('shipmentCargo')}>
          <ItemsTable items={s.items} />
        </DocSection>
        <DocSection title={tp('proofOfDelivery')}>
          <DocFields
            fields={[
              [tt('recipientName'), pod.recipientName],
              [tt('recipientCapacity'), pod.recipientCapacity],
              [tt('deliveredAt'), dateTime(pod.deliveredAt)],
              [tt('podPackages'), pod.packages !== null && <span dir="ltr">{pod.packages}</span>],
              [tt('note'), pod.note && <span className="pre">{pod.note}</span>],
              [tp('recordedBy'), pod.createdByName],
            ]}
          />
          <div className="signature-capture">
            <strong>{tp('recipientSignature')}</strong>
            {showSignature ? (
              /* eslint-disable-next-line @next/next/no-img-element -- the signature file the API serves */
              <img
                src={`/api/v1/shipments/${s.id}/documents/${pod.signatureDocumentId}/file`}
                alt={tt('signature')}
                onError={() => setSignatureFailed(true)}
              />
            ) : (
              <span className="muted">{tp('signatureOnFile')}</span>
            )}
          </div>
        </DocSection>
        <SignatureBoxes labels={[tp('signDriver')]} />
      </DocumentSheet>
    </>
  );
}
