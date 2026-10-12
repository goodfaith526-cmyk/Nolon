'use client';

import type { ShipmentStatusDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { EvidenceChecklist, confirmedBody } from './EvidenceChecklist';

/** A shipment status change the assistant proposed: the move, where, and the decision. */
export function ShipmentStatusDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const ts = useTranslations('Shipments');
  const te = useTranslations('Enums');
  const tc = useTranslations('Common');
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<ShipmentStatusDraftDto>(`/shipment-status-drafts/${id}`);
  const [ticked, setTicked] = useState<string[]>([]);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const request = draft.request;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/shipment-status-drafts"
      title={t('shipmentStatusTitle', { shipment: draft.shipmentNumber })}
      approveHint={t('shipmentStatusApproveHint')}
      result={
        draft.status === 'APPROVED'
          ? { label: draft.shipmentNumber, href: `/shipments/${draft.shipmentId}` }
          : null
      }
      approveBody={confirmedBody(draft.evidence, ticked)}
      onChanged={setRecord}
    >
      <dl className="details">
        <dt>{t('shipment')}</dt>
        <dd dir="ltr">
          <Link href={`/shipments/${draft.shipmentId}`}>{draft.shipmentNumber}</Link>
        </dd>
        <dt>{t('currentStatus')}</dt>
        <dd>{te(`shipment_${draft.currentStatus}`)}</dd>
        <dt>{ts('newStatus')}</dt>
        <dd>{te(`shipment_${request.status}`)}</dd>
        <dt>{ts('location')}</dt>
        <dd>{draft.locationName ?? '—'}</dd>
        <dt>{ts('note')}</dt>
        <dd>{request.note ?? '—'}</dd>
      </dl>
      <EvidenceChecklist
        evidence={draft.evidence}
        values={{
          shipmentId: { label: t('shipment'), value: draft.shipmentNumber },
          status: { label: ts('newStatus'), value: te(`shipment_${request.status}`) },
          locationId: { label: ts('location'), value: draft.locationName ?? '—' },
        }}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}
