'use client';

import type { CustomerDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { EvidenceChecklist, confirmedBody } from './EvidenceChecklist';

/** A new customer the assistant proposed: their contact details, and the decision. */
export function CustomerDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tcu = useTranslations('Customers');
  const tc = useTranslations('Common');
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<CustomerDraftDto>(`/customer-drafts/${id}`);
  const [ticked, setTicked] = useState<string[]>([]);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const customer = draft.request;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/customer-drafts"
      title={t('customerTitle', { name: customer.name })}
      approveHint={t('customerApproveHint')}
      result={
        draft.customerId
          ? { label: draft.customerNumber ?? '', href: `/customers/${draft.customerId}` }
          : null
      }
      approveBody={confirmedBody(draft.evidence, ticked)}
      onChanged={setRecord}
    >
      <dl className="details">
        <dt>{tcu('branch')}</dt>
        <dd dir="ltr">{draft.branchCode}</dd>
        <dt>{tcu('kind')}</dt>
        <dd>{tcu(`kind_${customer.kind}`)}</dd>
        <dt>{tcu('name')}</dt>
        <dd>{customer.name}</dd>
        <dt>{tcu('companyName')}</dt>
        <dd>{customer.companyName ?? '—'}</dd>
        <dt>{tcu('phone')}</dt>
        <dd dir="ltr">{customer.phone}</dd>
        <dt>{tcu('whatsapp')}</dt>
        <dd dir="ltr">{customer.whatsapp ?? '—'}</dd>
        <dt>{tcu('email')}</dt>
        <dd dir="ltr">{customer.email ?? '—'}</dd>
        <dt>{tcu('city')}</dt>
        <dd>{customer.city ?? '—'}</dd>
        <dt>{tcu('address')}</dt>
        <dd>{customer.address ?? '—'}</dd>
        <dt>{tcu('notes')}</dt>
        <dd>{customer.notes ?? '—'}</dd>
      </dl>
      <EvidenceChecklist
        evidence={draft.evidence}
        values={{
          branchId: { label: tcu('branch'), value: draft.branchCode },
          name: { label: tcu('name'), value: customer.name },
          phone: { label: tcu('phone'), value: customer.phone },
          whatsapp: { label: tcu('whatsapp'), value: customer.whatsapp ?? '—' },
        }}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}
