'use client';

import type { GoodsReleaseDraftDto, ReleaseDraftWarehouseOptionsDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { MissingFields } from './MissingFields';
import type { Value } from './missing-fields';
import { useOptionalRead } from './use-optional-read';

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
  const needsChoice =
    draft !== null &&
    draft.actions.canEdit &&
    draft.shipmentId !== null &&
    (draft.missingFields.includes('warehouseId') || draft.missingFields.includes('packages'));
  // The warehouses holding the shipment's goods in the reviewer's branches, and NOLON's
  // suggestion for a missing warehouse and packages (worked out by the API on each read).
  const options = useOptionalRead<ReleaseDraftWarehouseOptionsDto>(
    needsChoice ? `/release-drafts/${id}/warehouse-options` : null,
    draft?.version,
  );
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const release = draft.request;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const shipmentNumber = draft.shipmentNumber ?? '—';
  const warehouseChoices = (options?.options ?? []).map((w) => ({
    value: w.warehouseId,
    label: tw('heldIn', {
      warehouse: `${w.code} · ${locale === 'ar' ? w.nameAr : w.nameEn}`,
      packages: w.onHandPackages,
    }),
  }));
  // Only for the version the options were worked out for; the form opens with them filled in.
  const current = options && options.version === draft.version ? options : null;
  const suggested: Record<string, Value> = {};
  if (current?.suggested?.warehouseId) suggested.warehouseId = current.suggested.warehouseId;
  if (typeof current?.suggested?.packages === 'number') {
    suggested.packages = String(current.suggested.packages);
  }

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
      {options !== undefined && (
        <MissingFields
          // Opened again with the suggestion of each version read.
          key={`${draft.version}:${current ? 'options' : 'none'}`}
          draft={draft}
          apiPath="/release-drafts"
          choices={{ warehouseId: warehouseChoices }}
          suggested={suggested}
          dependents={{ warehouseId: ['packages'] }}
          onChanged={setRecord}
        />
      )}
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
