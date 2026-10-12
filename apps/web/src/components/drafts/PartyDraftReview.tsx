'use client';

import type { PartyDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { EvidenceChecklist, confirmedBody } from './EvidenceChecklist';

/** A party (shipper, consignee, notify party) the assistant proposed for a customer. */
export function PartyDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tcu = useTranslations('Customers');
  const tc = useTranslations('Common');
  const { record: draft, notice, setRecord } = useRecord<PartyDraftDto>(`/party-drafts/${id}`);
  const [ticked, setTicked] = useState<string[]>([]);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const party = draft.request;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/party-drafts"
      title={t('partyTitle', { name: party.name, customer: draft.customerName })}
      approveHint={t('partyApproveHint')}
      result={
        draft.partyId
          ? { label: draft.customerNumber, href: `/customers/${draft.customerId}` }
          : null
      }
      approveBody={confirmedBody(draft.evidence, ticked)}
      onChanged={setRecord}
    >
      <dl className="details">
        <dt>{t('customer')}</dt>
        <dd>
          <Link href={`/customers/${draft.customerId}`}>{draft.customerName}</Link>{' '}
          <span dir="ltr">{draft.customerNumber}</span>
        </dd>
        <dt>{tcu('name')}</dt>
        <dd>{party.name}</dd>
        <dt>{tcu('companyName')}</dt>
        <dd>{party.companyName ?? '—'}</dd>
        <dt>{t('phone')}</dt>
        <dd dir="ltr">{party.phone ?? '—'}</dd>
        <dt>{tcu('email')}</dt>
        <dd dir="ltr">{party.email ?? '—'}</dd>
        <dt>{t('country')}</dt>
        <dd dir="ltr">{party.countryCode ?? '—'}</dd>
        <dt>{tcu('city')}</dt>
        <dd>{party.city ?? '—'}</dd>
        <dt>{tcu('address')}</dt>
        <dd>{party.address ?? '—'}</dd>
      </dl>
      <EvidenceChecklist
        evidence={draft.evidence}
        values={{
          customerId: { label: t('customer'), value: draft.customerName },
          name: { label: tcu('name'), value: party.name },
          phone: { label: t('phone'), value: party.phone ?? '—' },
        }}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}
