'use client';

import type { PalletDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRecord } from '../finance/common';
import {
  DocFields,
  DocSection,
  DocumentSheet,
  PageStyle,
  PrintPending,
  PrintToolbar,
  QrCode,
  useDateTime,
  useSvgSrc,
} from './PrintKit';

/**
 * Plan 15-3: the pallet label. Its QR code opens the pallet's page on a phone (signed-in staff of
 * its branch only), where the pallet is put in a container or on a trip.
 */
export function PalletPrint({ id }: { id: string }) {
  const t = useTranslations('Pallets');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const dateTime = useDateTime();
  const { record: pallet, notice } = useRecord<PalletDto>(`/pallets/${id}`);
  const qr = useSvgSrc(`/pallets/${id}/qr.svg`);
  if (!pallet) return <PrintPending notice={notice} />;
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/pallets/${id}`} ready={qr !== null} />
      <DocumentSheet
        title={tp('palletLabelTitle')}
        number={pallet.number}
        date={dateTime(pallet.closedAt ?? pallet.createdAt)}
        branchId={pallet.branchId}
        meta={<p>{te(`pallet_${pallet.status}`)}</p>}
        watermark={pallet.status === 'CANCELLED' ? te('pallet_CANCELLED') : null}
      >
        <DocSection>
          <QrCode src={qr} size={50} caption={t('qrCaption')} />
          <DocFields
            fields={[
              [t('warehouse'), locale === 'ar' ? pallet.warehouseName.ar : pallet.warehouseName.en],
              [t('shipmentsCount'), String(pallet.shipmentCount)],
            ]}
          />
        </DocSection>
        <DocSection title={t('shipments')}>
          <table className="doc-table compact">
            <thead>
              <tr>
                <th>{t('shipment')}</th>
                <th>{t('customer')}</th>
              </tr>
            </thead>
            <tbody>
              {pallet.shipments.map((s) => (
                <tr key={s.shipmentId}>
                  <td dir="ltr">{s.number}</td>
                  <td>{s.customerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DocSection>
      </DocumentSheet>
    </>
  );
}
