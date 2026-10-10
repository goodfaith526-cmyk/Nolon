'use client';

import type { GoodsReleaseDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';

/** A goods release the assistant proposed: what leaves which warehouse, and the decision. */
export function ReleaseDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tw = useTranslations('Warehouse');
  const tc = useTranslations('Common');
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<GoodsReleaseDraftDto>(`/release-drafts/${id}`);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const release = draft.request;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/release-drafts"
      title={t('releaseTitle', { shipment: draft.shipmentNumber })}
      approveHint={t('releaseApproveHint')}
      result={
        draft.movementId
          ? { label: draft.movementNumber ?? '', href: `/shipments/${draft.shipmentId}` }
          : null
      }
      onChanged={setRecord}
    >
      <dl className="details">
        <dt>{t('shipment')}</dt>
        <dd dir="ltr">
          <Link href={`/shipments/${draft.shipmentId}`}>{draft.shipmentNumber}</Link>
        </dd>
        <dt>{tw('warehouse')}</dt>
        <dd dir="ltr">{draft.warehouseCode}</dd>
        <dt>{tw('packages')}</dt>
        <dd dir="ltr">{release.packages}</dd>
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
