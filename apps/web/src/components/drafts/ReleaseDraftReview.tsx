'use client';

import type { GoodsReleaseDraftDto, WarehouseDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { useApiList } from '../finance/reports/ReportKit';
import { DraftFrame } from './DraftFrame';
import { MissingFields } from './MissingFields';

/** A goods release the assistant proposed: what leaves which warehouse, and the decision. */
export function ReleaseDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tw = useTranslations('Warehouse');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<GoodsReleaseDraftDto>(`/release-drafts/${id}`);
  const needsWarehouse = draft?.missingFields.includes('warehouseId') ?? false;
  const warehouses = useApiList<WarehouseDto>('/warehouses', needsWarehouse);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const release = draft.request;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const shipmentNumber = draft.shipmentNumber ?? '—';
  const warehouseChoices = (warehouses ?? [])
    .filter((w) => w.isActive && w.branchId === draft.branchId)
    .map((w) => ({ value: w.id, label: `${w.code} · ${locale === 'ar' ? w.nameAr : w.nameEn}` }));

  return (
    <DraftFrame
      draft={draft}
      apiPath="/release-drafts"
      title={t('releaseTitle', { shipment: shipmentNumber })}
      approveHint={t('releaseApproveHint')}
      result={
        draft.movementId && draft.shipmentId
          ? { label: draft.movementNumber ?? '', href: `/shipments/${draft.shipmentId}` }
          : null
      }
      onChanged={setRecord}
    >
      <MissingFields
        draft={draft}
        apiPath="/release-drafts"
        choices={{ warehouseId: warehouseChoices }}
        onChanged={setRecord}
      />
      <dl className="details">
        <dt>{t('shipment')}</dt>
        <dd dir="ltr">
          {draft.shipmentId ? (
            <Link href={`/shipments/${draft.shipmentId}`}>{shipmentNumber}</Link>
          ) : (
            '—'
          )}
        </dd>
        <dt>{tw('warehouse')}</dt>
        <dd dir="ltr">{draft.warehouseCode ?? '—'}</dd>
        <dt>{tw('packages')}</dt>
        <dd dir="ltr">{release.packages ?? '—'}</dd>
        <dt>{tw('weightKg')}</dt>
        <dd dir="ltr">{release.weightKg ?? '—'}</dd>
        <dt>{tw('collectedBy')}</dt>
        <dd>{release.partyName ?? '—'}</dd>
        <dt>{tw('note')}</dt>
        <dd>{release.note ?? '—'}</dd>
      </dl>
    </DraftFrame>
  );
}
