'use client';

import type { RateCardDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Notice } from '../commercial/Notice';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Money, useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { MissingFields } from './MissingFields';
import { EvidenceChecklist, confirmedBody, useEvidenceTicks } from './EvidenceChecklist';

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
  const [ticked, setTicked] = useEvidenceTicks(draft?.version);
  const master = useMasterData();
  const localName = useLocalName();
  // A rate card may also name a country as its scope (business model plan 5.3).
  const routeChoices = (master?.locations ?? [])
    .filter((l) => l.isActive)
    .map((l) => ({
      value: l.id,
      label: `${localName(l)} (${l.code})${l.kind === 'COUNTRY' ? ` · ${tr('countryScope')}` : ''}`,
    }));
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const rate = draft.request;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const dash = (value: string | null | undefined) => value ?? '—';
  const currency = rate.currency ?? undefined;
  const unit = rate.unit ? te(`unit_${rate.unit}`) : '—';
  const price = `${dash(rate.price)} ${dash(rate.currency)}`;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/rate-card-drafts"
      title={t('rateCardTitle', {
        origin: dash(draft.originCode),
        destination: dash(draft.destinationCode),
      })}
      approveHint={t('rateCardApproveHint')}
      result={draft.rateCardId ? { label: tr('title'), href: '/rates' } : null}
      approveBody={confirmedBody(draft.evidence, ticked)}
      onChanged={setRecord}
    >
      <MissingFields
        draft={draft}
        apiPath="/rate-card-drafts"
        choices={{ originLocationId: routeChoices, destinationLocationId: routeChoices }}
        onChanged={setRecord}
      />
      <dl className="details">
        <dt>{tr('branch')}</dt>
        <dd dir="ltr">{draft.branchCode}</dd>
        <dt>{tr('origin')}</dt>
        <dd dir="ltr">{dash(draft.originCode)}</dd>
        <dt>{tr('destination')}</dt>
        <dd dir="ltr">{dash(draft.destinationCode)}</dd>
        <dt>{tr('mode')}</dt>
        <dd>{rate.mode ? te(`mode_${rate.mode}`) : '—'}</dd>
        <dt>{tr('loadType')}</dt>
        <dd>{rate.loadType ?? '—'}</dd>
        <dt>{tr('cargo')}</dt>
        <dd>{rate.cargoType ? te(`cargo_${rate.cargoType}`) : '—'}</dd>
        <dt>{tr('containerType')}</dt>
        <dd dir="ltr">{rate.containerTypeCode ?? '—'}</dd>
        <dt>{tr('chargeType')}</dt>
        <dd dir="ltr">{rate.chargeTypeCode ?? 'FREIGHT'}</dd>
        <dt>{tr('price')}</dt>
        <dd>
          {rate.price ? <Money value={rate.price} currency={currency} /> : '—'} / {unit}
        </dd>
        <dt>{tr('minimum')}</dt>
        <dd>
          {rate.minimumCharge ? <Money value={rate.minimumCharge} currency={currency} /> : '—'}
        </dd>
        <dt>{tr('validFrom')}</dt>
        <dd dir="ltr">{dash(rate.validFrom)}</dd>
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
          branchId: { label: tr('branch'), value: draft.branchCode },
          originLocationId: { label: tr('origin'), value: dash(draft.originCode) },
          destinationLocationId: { label: tr('destination'), value: dash(draft.destinationCode) },
          price: { label: tr('price'), value: `${price} / ${unit}` },
          minimumCharge: {
            label: tr('minimum'),
            value: rate.minimumCharge ? `${rate.minimumCharge} ${dash(rate.currency)}` : '—',
          },
          currency: { label: tr('currency'), value: dash(rate.currency) },
          transitDays: { label: tr('transitDays'), value: String(rate.transitDays ?? '—') },
        }}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}
