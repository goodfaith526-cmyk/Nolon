'use client';

import type { RateCardDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { EvidenceChecklist, confirmedBody } from './EvidenceChecklist';

/** A selling rate the assistant proposed: the route, the price, its validity, and the decision. */
export function RateCardDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tr = useTranslations('Rates');
  const te = useTranslations('Enums');
  const tc = useTranslations('Common');
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<RateCardDraftDto>(`/rate-card-drafts/${id}`);
  const [ticked, setTicked] = useState<string[]>([]);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const rate = draft.request;
  const price = `${rate.price} ${rate.currency}`;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/rate-card-drafts"
      title={t('rateCardTitle', { origin: draft.originCode, destination: draft.destinationCode })}
      approveHint={t('rateCardApproveHint')}
      result={draft.rateCardId ? { label: tr('title'), href: '/rates' } : null}
      approveBody={confirmedBody(draft.evidence, ticked)}
      onChanged={setRecord}
    >
      <dl className="details">
        <dt>{tr('branch')}</dt>
        <dd dir="ltr">{draft.branchCode}</dd>
        <dt>{tr('origin')}</dt>
        <dd dir="ltr">{draft.originCode}</dd>
        <dt>{tr('destination')}</dt>
        <dd dir="ltr">{draft.destinationCode}</dd>
        <dt>{tr('mode')}</dt>
        <dd>{te(`mode_${rate.mode}`)}</dd>
        <dt>{tr('loadType')}</dt>
        <dd>{rate.loadType ?? '—'}</dd>
        <dt>{tr('cargo')}</dt>
        <dd>{te(`cargo_${rate.cargoType}`)}</dd>
        <dt>{tr('containerType')}</dt>
        <dd dir="ltr">{rate.containerTypeCode ?? '—'}</dd>
        <dt>{tr('chargeType')}</dt>
        <dd dir="ltr">{rate.chargeTypeCode ?? 'FREIGHT'}</dd>
        <dt>{tr('price')}</dt>
        <dd>
          <Money value={rate.price} currency={rate.currency} /> / {te(`unit_${rate.unit}`)}
        </dd>
        <dt>{tr('minimum')}</dt>
        <dd>
          {rate.minimumCharge ? <Money value={rate.minimumCharge} currency={rate.currency} /> : '—'}
        </dd>
        <dt>{tr('validFrom')}</dt>
        <dd dir="ltr">{rate.validFrom}</dd>
        <dt>{t('rateValidTo')}</dt>
        <dd dir="ltr">{rate.validTo ?? '—'}</dd>
        <dt>{tr('transitDays')}</dt>
        <dd>{rate.transitDays ?? '—'}</dd>
        <dt>{t('notes')}</dt>
        <dd>{rate.notes ?? '—'}</dd>
      </dl>
      <EvidenceChecklist
        evidence={draft.evidence}
        values={{
          originLocationId: { label: tr('origin'), value: draft.originCode },
          destinationLocationId: { label: tr('destination'), value: draft.destinationCode },
          mode: { label: tr('mode'), value: te(`mode_${rate.mode}`) },
          containerTypeCode: { label: tr('containerType'), value: rate.containerTypeCode ?? '—' },
          unit: { label: tr('unit'), value: te(`unit_${rate.unit}`) },
          price: { label: tr('price'), value: price },
          minimumCharge: {
            label: tr('minimum'),
            value: rate.minimumCharge ? `${rate.minimumCharge} ${rate.currency}` : '—',
          },
          currency: { label: tr('currency'), value: rate.currency },
          validFrom: { label: tr('validFrom'), value: rate.validFrom },
          validTo: { label: t('rateValidTo'), value: rate.validTo ?? '—' },
        }}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}
