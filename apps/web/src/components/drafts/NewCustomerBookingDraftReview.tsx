'use client';

import type { CustomerDraftDto, NewCustomerBookingDraftDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { CustomerRequestDetails } from './CustomerDraftReview';
import { DraftContainerDetails } from './DraftContainerDetails';
import { DraftFrame, DraftStatusBadge } from './DraftFrame';
import { EvidenceChecklist, confirmedBody } from './EvidenceChecklist';
import { MissingFields } from './MissingFields';
import { useOptionalRead } from './use-optional-read';

const LINE_FIELD = /^items\[(\d+)\]\.(quantity|weightKg|volumeCbm)$/;

/**
 * A booking the assistant proposed for a new customer: the customer draft it waits for, the
 * booking as proposed, the staff member's words, and the decision. While the customer draft is
 * open, a reviewer who may also approve it (NOLON says so on the customer draft) approves both
 * here in one step, ticking the customer's words too; anyone else approves the customer draft
 * first on its own screen (Approve stays off until then).
 */
export function NewCustomerBookingDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tb = useTranslations('Bookings');
  const tcu = useTranslations('Customers');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<NewCustomerBookingDraftDto>(`/new-customer-booking-drafts/${id}`);
  const [ticked, setTicked] = useState<string[]>([]);
  const [customerTicked, setCustomerTicked] = useState<string[]>([]);
  const customerOpen = draft?.status === 'DRAFT' && draft.customer.status === 'DRAFT';
  // The customer draft as its own screen reads it (its version, words and whether this person may
  // decide it); refused or not asked, the booking waits for it as before.
  const customerDraft = useOptionalRead<CustomerDraftDto>(
    customerOpen ? `/customer-drafts/${draft.customer.draftId}` : null,
  );
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const b = draft.request;
  const customer = draft.customer;
  const customerReady = customer.status === 'APPROVED' && customer.customerId !== null;
  const oneStep =
    customerOpen &&
    draft.actions.canDecide &&
    customerDraft?.status === 'DRAFT' &&
    customerDraft.actions.canDecide
      ? customerDraft
      : null;
  const words = confirmedBody(draft.evidence, ticked);
  const customerWords = oneStep ? confirmedBody(oneStep.evidence, customerTicked) : null;
  // One step: the customer draft's version on screen and its words ticked go with the approval.
  const approveBody = customerReady
    ? words
    : oneStep && words && customerWords
      ? { ...words, customer: { version: oneStep.version, ...customerWords } }
      : null;
  // A value the draft still misses shows as a dash (MissingFields names it). The booking's are
  // filled in here; the customer's on its customer draft.
  const place = (id: string | null | undefined) => (id ? locationName(id) : '—');
  const bookingMissing = draft.missingFields
    .filter((f) => f.startsWith('booking.'))
    .map((f) => f.slice('booking.'.length));

  const values: Record<string, { label: string; value: string }> = {
    originLocationId: { label: tb('origin'), value: place(b.originLocationId) },
    destinationLocationId: { label: tb('destination'), value: place(b.destinationLocationId) },
    consolidationId: {
      label: t('container'),
      value: draft.container?.number ?? t('containerHidden'),
    },
  };
  for (const e of draft.evidence) {
    const match = LINE_FIELD.exec(e.field);
    const item = match ? b.items[Number(match[1])] : undefined;
    if (!match || !item) continue;
    const line = Number(match[1]) + 1;
    const field = match[2] as 'quantity' | 'weightKg' | 'volumeCbm';
    values[e.field] = {
      label: t('lineValue', { line, field: tb(field) }),
      value: String(item[field] ?? '—'),
    };
  }

  return (
    <DraftFrame
      draft={draft}
      apiPath="/new-customer-booking-drafts"
      title={t('newCustomerBookingTitle', { customer: customer.name ?? '—' })}
      approveHint={
        oneStep
          ? t('newCustomerBookingWithCustomerApproveHint')
          : b.consolidationId
            ? t('newCustomerContainerBookingApproveHint')
            : t('newCustomerBookingApproveHint')
      }
      result={
        draft.bookingId
          ? { label: draft.bookingNumber ?? '', href: `/bookings/${draft.bookingId}` }
          : null
      }
      approveBody={approveBody}
      onChanged={setRecord}
    >
      <MissingFields
        draft={draft}
        apiPath="/new-customer-booking-drafts"
        missingFields={bookingMissing}
        onChanged={setRecord}
      />
      <div className="card stack">
        <div className="row">
          <h2>{t('newCustomer')}</h2>
          <DraftStatusBadge status={customer.status} />
        </div>
        <dl className="details">
          <dt>{t('customer')}</dt>
          <dd>
            {customer.customerId ? (
              <Link href={`/customers/${customer.customerId}`}>
                {customer.name}
                {customer.customerNumber ? ` (${customer.customerNumber})` : ''}
              </Link>
            ) : (
              (customer.name ?? '—')
            )}
          </dd>
          <dt>{t('phone')}</dt>
          <dd dir="ltr">{customer.phone ?? '—'}</dd>
        </dl>
        <p>
          <Link href={`/drafts/customers/${customer.draftId}`}>{t('openCustomerDraft')}</Link>
        </p>
        {draft.status === 'DRAFT' &&
          customer.status === 'DRAFT' &&
          (oneStep ? (
            <p className="notice">{t('approveWithCustomer')}</p>
          ) : (
            <p className="notice">{t('approveCustomerFirst')}</p>
          ))}
        {draft.status === 'DRAFT' &&
          (customer.status === 'REJECTED' || customer.status === 'EXPIRED') && (
            <p className="error">{t('customerNotApproved')}</p>
          )}
      </div>
      <dl className="details">
        <dt>{tcu('branch')}</dt>
        <dd dir="ltr">{draft.branchCode}</dd>
        <dt>{tb('route')}</dt>
        <dd>
          {tc('route', { from: place(b.originLocationId), to: place(b.destinationLocationId) })}
        </dd>
        <dt>{tb('mode')}</dt>
        <dd>
          {b.mode ? te(`mode_${b.mode}`) : '—'}
          {b.loadType ? ` · ${b.loadType}` : ''} · {b.cargoType ? te(`cargo_${b.cargoType}`) : '—'}
        </dd>
        <dt>{tb('cargoDescription')}</dt>
        <dd>{b.cargoDescription ?? '—'}</dd>
        <DraftContainerDetails id={b.consolidationId} container={draft.container} />
        <dt>{tb('services')}</dt>
        <dd>{new Intl.ListFormat(locale).format(b.services.map((s) => te(`service_${s}`)))}</dd>
        <dt>{tb('requestedDeparture')}</dt>
        <dd dir="ltr">{b.requestedDeparture ?? '—'}</dd>
        <dt>{tb('specialInstructions')}</dt>
        <dd>{b.specialInstructions ?? '—'}</dd>
      </dl>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tb('cargoType')}</th>
              <th>{tb('itemDescription')}</th>
              <th>{tb('quantity')}</th>
              <th>{tb('weightKg')}</th>
              <th>{tb('volumeCbm')}</th>
            </tr>
          </thead>
          <tbody>
            {b.items.map((item, i) => (
              <tr key={i}>
                <td>
                  {item.cargoType ? te(`cargo_${item.cargoType}`) : '—'}
                  {item.containerTypeCode ? ` ${item.containerTypeCode}` : ''}
                </td>
                <td>{item.description ?? '—'}</td>
                <td dir="ltr">{item.quantity ?? '—'}</td>
                <td dir="ltr">{item.weightKg ?? '—'}</td>
                <td dir="ltr">{item.volumeCbm ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {oneStep && (
        <div className="card stack">
          <h2>{t('customerToCreate')}</h2>
          <CustomerRequestDetails branchCode={oneStep.branchCode} customer={oneStep.request} />
        </div>
      )}
      {oneStep && (
        <EvidenceChecklist
          evidence={oneStep.evidence}
          values={{
            branchId: { label: tcu('branch'), value: oneStep.branchCode },
            name: { label: tcu('name'), value: oneStep.request.name ?? '—' },
            phone: { label: tcu('phone'), value: oneStep.request.phone ?? '—' },
            whatsapp: { label: tcu('whatsapp'), value: oneStep.request.whatsapp ?? '—' },
          }}
          ticked={customerTicked}
          onChange={setCustomerTicked}
          editable
        />
      )}
      <EvidenceChecklist
        evidence={draft.evidence}
        values={values}
        ticked={ticked}
        onChange={setTicked}
        editable={draft.actions.canDecide}
      />
    </DraftFrame>
  );
}
