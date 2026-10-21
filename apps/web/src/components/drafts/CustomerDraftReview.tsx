'use client';

import { CUSTOMER_KINDS, type CustomerDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { EvidenceChecklist, confirmedBody, useEvidenceTicks } from './EvidenceChecklist';
import { MissingFields } from './MissingFields';

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
  const [ticked, setTicked] = useEvidenceTicks(draft?.version);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const customer = draft.request;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const kinds = CUSTOMER_KINDS.map((k) => ({ value: k, label: tcu(`kind_${k}`) }));

  return (
    <DraftFrame
      draft={draft}
      apiPath="/customer-drafts"
      title={t('customerTitle', { name: customer.name ?? '—' })}
      approveHint={t('customerApproveHint')}
      result={
        draft.customerId
          ? { label: draft.customerNumber ?? '', href: `/customers/${draft.customerId}` }
          : null
      }
      approveBody={confirmedBody(draft.evidence, ticked)}
      onChanged={setRecord}
    >
      <MissingFields
        draft={draft}
        apiPath="/customer-drafts"
        choices={{ kind: kinds }}
        onChanged={setRecord}
      />
      {draft.bookingDraftId && (
        <p>
          {t('bookingWithCustomer')}{' '}
          <Link href={`/drafts/new-customer-bookings/${draft.bookingDraftId}`}>
            {t('openBookingDraft')}
          </Link>
        </p>
      )}
      <CustomerRequestDetails branchCode={draft.branchCode} customer={customer} />
      <EvidenceChecklist
        evidence={draft.evidence}
        values={{
          branchId: { label: tcu('branch'), value: draft.branchCode },
          name: { label: tcu('name'), value: customer.name ?? '—' },
          phone: { label: tcu('phone'), value: customer.phone ?? '—' },
          whatsapp: { label: tcu('whatsapp'), value: customer.whatsapp ?? '—' },
        }}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}

/**
 * Every value a customer draft asks for, as its approval would create it. Shown wherever the
 * customer is approved, so nothing it creates is off screen (Codex F97-1).
 */
export function CustomerRequestDetails({
  branchCode,
  customer,
}: {
  branchCode: string;
  customer: CustomerDraftDto['request'];
}) {
  const tcu = useTranslations('Customers');
  return (
    <dl className="details">
      <dt>{tcu('branch')}</dt>
      <dd dir="ltr">{branchCode}</dd>
      <dt>{tcu('kind')}</dt>
      <dd>{customer.kind ? tcu(`kind_${customer.kind}`) : '—'}</dd>
      <dt>{tcu('name')}</dt>
      <dd>{customer.name ?? '—'}</dd>
      <dt>{tcu('companyName')}</dt>
      <dd>{customer.companyName ?? '—'}</dd>
      <dt>{tcu('phone')}</dt>
      <dd dir="ltr">{customer.phone ?? '—'}</dd>
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
  );
}
