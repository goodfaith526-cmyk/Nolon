'use client';

import { CUSTOMER_KINDS, type NewCustomerQuotationDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { DraftPriceSourceNote } from './DraftPriceSourceNote';
import { EvidenceChecklist, confirmedBody } from './EvidenceChecklist';
import { MissingFields } from './MissingFields';

const LINE_FIELD = /^lines\[(\d+)\]\.(quantity|unitPrice|discount)$/;

/**
 * A quotation the assistant proposed for a new customer: the customer, the quotation as NOLON
 * prices it now, the staff member's words, and the decision. Approving creates both at once.
 */
export function NewCustomerQuotationDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tq = useTranslations('Quotations');
  const tcu = useTranslations('Customers');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const locationName = useLocationName(master);
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<NewCustomerQuotationDraftDto>(`/new-customer-quotation-drafts/${id}`);
  const [ticked, setTicked] = useState<string[]>([]);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const q = draft.request;
  const customer = draft.customer;
  const pricing = draft.pricing;
  // A line with neither a rate card nor a price takes the system price (the matching rate card).
  const systemPriced = q.lines.some((l) => !l.rateCardId && l.unitPrice === undefined);
  const words = confirmedBody(draft.evidence, ticked);
  // A value the draft still misses shows as a dash (MissingFields names it).
  const place = (id: string | null | undefined) => (id ? locationName(id) : '—');
  const currency = q.currency ?? undefined;
  const kinds = CUSTOMER_KINDS.map((k) => ({ value: k, label: tcu(`kind_${k}`) }));

  const values: Record<string, { label: string; value: string }> = {
    branchId: { label: tcu('branch'), value: draft.branchCode },
    name: { label: tcu('name'), value: customer.name ?? '—' },
    phone: { label: tcu('phone'), value: customer.phone ?? '—' },
    whatsapp: { label: tcu('whatsapp'), value: customer.whatsapp ?? '—' },
    originLocationId: { label: tq('origin'), value: place(q.originLocationId) },
    destinationLocationId: { label: tq('destination'), value: place(q.destinationLocationId) },
    currency: { label: tq('currency'), value: q.currency ?? '—' },
  };
  for (const e of draft.evidence) {
    const match = LINE_FIELD.exec(e.field);
    const line = match ? q.lines[Number(match[1])] : undefined;
    if (!match || !line) continue;
    const field = match[2] as 'quantity' | 'unitPrice' | 'discount';
    values[e.field] = {
      label: t('lineValue', { line: Number(match[1]) + 1, field: tq(field) }),
      value: line[field] ?? '—',
    };
  }

  return (
    <DraftFrame
      draft={draft}
      apiPath="/new-customer-quotation-drafts"
      title={t('newCustomerQuotationTitle', { customer: customer.name ?? '—' })}
      approveHint={
        systemPriced
          ? `${t('newCustomerQuotationApproveHint')} ${t('systemPriceHint')}`
          : t('newCustomerQuotationApproveHint')
      }
      result={
        draft.quotationId
          ? { label: draft.quotationNumber ?? '', href: `/quotations/${draft.quotationId}` }
          : null
      }
      approveBody={pricing && words ? { ...words, pricingKey: pricing.key } : null}
      onChanged={setRecord}
    >
      <MissingFields
        draft={draft}
        apiPath="/new-customer-quotation-drafts"
        request={{ customer, quotation: q }}
        choices={{ kind: kinds }}
        onChanged={setRecord}
      />
      <div className="card stack">
        <h2>{t('newCustomer')}</h2>
        <dl className="details">
          <dt>{tcu('branch')}</dt>
          <dd dir="ltr">{draft.branchCode}</dd>
          <dt>{tcu('kind')}</dt>
          <dd>{customer.kind ? tcu(`kind_${customer.kind}`) : '—'}</dd>
          <dt>{tcu('name')}</dt>
          <dd>
            {draft.customerId ? (
              <Link href={`/customers/${draft.customerId}`}>
                {customer.name}
                {draft.customerNumber ? ` (${draft.customerNumber})` : ''}
              </Link>
            ) : (
              (customer.name ?? '—')
            )}
          </dd>
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
      </div>
      <dl className="details">
        <dt>{tq('route')}</dt>
        <dd>
          {tc('route', { from: place(q.originLocationId), to: place(q.destinationLocationId) })}
        </dd>
        <dt>{tq('mode')}</dt>
        <dd>
          {q.mode ? te(`mode_${q.mode}`) : '—'}
          {q.loadType ? ` · ${q.loadType}` : ''} · {q.cargoType ? te(`cargo_${q.cargoType}`) : '—'}
        </dd>
        <dt>{tq('cargoDescription')}</dt>
        <dd>{q.cargoDescription ?? '—'}</dd>
        <dt>{tq('currency')}</dt>
        <dd dir="ltr">{q.currency ?? '—'}</dd>
        <dt>{tq('validUntil')}</dt>
        <dd dir="ltr">{q.validUntil ?? '—'}</dd>
        <dt>{tq('terms')}</dt>
        <dd>{q.terms ?? '—'}</dd>
      </dl>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tq('chargeType')}</th>
              <th>{tq('unit')}</th>
              <th>{tq('quantity')}</th>
              <th>{tq('unitPrice')}</th>
              <th>{tq('discount')}</th>
              {pricing && <th>{tq('lineTotal')}</th>}
            </tr>
          </thead>
          <tbody>
            {q.lines.map((line, i) => {
              // While open, the prices an approval records (a rate card line at its price now).
              const priced = pricing?.lines[i];
              return (
                <tr key={i}>
                  <td>
                    {line.rateCardId ? `${t('rateLine')} · ` : ''}
                    {priced?.chargeTypeCode ?? line.chargeTypeCode ?? '—'}
                    {line.description ? ` · ${line.description}` : ''}
                  </td>
                  <td>
                    {(priced?.unit ?? line.unit) ? te(`unit_${priced?.unit ?? line.unit}`) : '—'}
                  </td>
                  <td dir="ltr">{line.quantity ?? '—'}</td>
                  <td>
                    {(priced?.unitPrice ?? line.unitPrice) ? (
                      <Money
                        value={priced?.unitPrice ?? line.unitPrice ?? ''}
                        currency={currency}
                      />
                    ) : (
                      '—'
                    )}
                    {!line.rateCardId && line.unitPrice === undefined && (
                      <DraftPriceSourceNote source={draft.priceSources?.[i]} />
                    )}
                  </td>
                  <td>
                    {(priced?.discount ?? line.discount) ? (
                      <Money value={priced?.discount ?? line.discount ?? ''} currency={currency} />
                    ) : (
                      '—'
                    )}
                  </td>
                  {pricing && (
                    <td>
                      <Money value={priced?.lineTotal ?? ''} currency={currency} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
