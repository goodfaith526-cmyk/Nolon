'use client';

import { SHIPMENT_STATUSES, type ShipmentStatusDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { EvidenceChecklist, confirmedBody, useEvidenceTicks } from './EvidenceChecklist';
import { MissingFields } from './MissingFields';

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
  const [ticked, setTicked] = useEvidenceTicks(draft?.version);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const request = draft.request;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const shipmentNumber = draft.shipmentNumber ?? '—';
  const statusName = (s: string | null | undefined) => (s ? te(`shipment_${s}`) : '—');
  const statuses = SHIPMENT_STATUSES.map((s) => ({ value: s, label: te(`shipment_${s}`) }));

  return (
    <DraftFrame
      draft={draft}
      apiPath="/shipment-status-drafts"
      title={t('shipmentStatusTitle', { shipment: shipmentNumber })}
      approveHint={t('shipmentStatusApproveHint')}
      result={
        draft.status === 'APPROVED' && draft.shipmentId
          ? { label: shipmentNumber, href: `/shipments/${draft.shipmentId}` }
          : null
      }
      approveBody={confirmedBody(draft.evidence, ticked)}
      onChanged={setRecord}
    >
      <MissingFields
        draft={draft}
        apiPath="/shipment-status-drafts"
        choices={{ status: statuses }}
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
        <dt>{t('currentStatus')}</dt>
        <dd>{statusName(draft.currentStatus)}</dd>
        <dt>{ts('newStatus')}</dt>
        <dd>{statusName(request.status)}</dd>
        <dt>{ts('location')}</dt>
        <dd>{draft.locationName ?? '—'}</dd>
        <dt>{ts('note')}</dt>
        <dd>{request.note ?? '—'}</dd>
      </dl>
      <EvidenceChecklist
        evidence={draft.evidence}
        values={{
          shipmentId: { label: t('shipment'), value: shipmentNumber },
          status: { label: ts('newStatus'), value: statusName(request.status) },
          locationId: { label: ts('location'), value: draft.locationName ?? '—' },
        }}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}
