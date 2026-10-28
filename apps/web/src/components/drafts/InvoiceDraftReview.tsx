'use client';

import type { InvoiceDraftDto, InvoiceDraftSuggestedValuesDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { OtherInvoicesCheck } from '../finance/OtherInvoicesCheck';
import { DraftFrame } from './DraftFrame';
import { DraftPriceSourceNote } from './DraftPriceSourceNote';
import { MissingFields } from './MissingFields';
import { NEW_INVOICE_LINE_FIELDS, type Value } from './missing-fields';
import { useOptionalRead } from './use-optional-read';

/** An invoice the assistant proposed for a shipment: its lines as proposed, and the decision. */
export function InvoiceDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const ti = useTranslations('Invoices');
  const tc = useTranslations('Common');
  const { record: draft, notice, setRecord } = useRecord<InvoiceDraftDto>(`/invoice-drafts/${id}`);
  const missingHeader =
    draft !== null &&
    draft.actions.canEdit &&
    draft.request.shipmentId !== null &&
    ['currency', 'invoiceDate', 'dueDate'].some((f) => draft.missingFields.includes(f));
  // NOLON's suggestion for the currency and dates the draft misses (the shipment's customer's
  // currency, today in the branch, the customer's payment terms), worked out by the API for this
  // version. The form opens with them filled in; nothing is saved until the person saves it.
  const suggestion = useOptionalRead<InvoiceDraftSuggestedValuesDto>(
    missingHeader ? `/invoice-drafts/${id}/suggested-values` : null,
    draft?.version,
  );
  // The shipment's other invoices, ticked as checked for the list read (Q3): once the list
  // changes (a refused approval reloads the draft), the tick is asked for again.
  const listed = (draft?.shipmentInvoices ?? []).map((i) => `${i.id}:${i.status}`).join(',');
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = confirmedFor === listed;
  const setConfirmed = (checked: boolean) => setConfirmedFor(checked ? listed : null);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const inv = draft.request;
  const systemPriced = draft.priceSources.some((p) => p.source !== 'TYPED');
  // A value the draft still misses shows as a dash (MissingFields names it).
  const shipmentNumber = draft.shipmentNumber ?? '—';
  const currency = inv.currency ?? undefined;
  const suggested: Record<string, Value> = {};
  const values = suggestion && suggestion.version === draft.version ? suggestion.values : null;
  if (values?.currency) suggested.currency = values.currency;
  if (values?.invoiceDate) suggested.invoiceDate = values.invoiceDate;
  if (values?.dueDate) suggested.dueDate = values.dueDate;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/invoice-drafts"
      title={t('invoiceTitle', { shipment: shipmentNumber, customer: draft.customerName ?? '—' })}
      approveHint={
        systemPriced
          ? `${t('invoiceApproveHint')} ${t('systemPriceHint')}`
          : t('invoiceApproveHint')
      }
      approveBody={
        draft.shipmentInvoices.length === 0
          ? {}
          : confirmed
            ? { acknowledgedInvoiceIds: draft.shipmentInvoices.map((i) => i.id) }
            : null
      }
      result={
        draft.invoiceId
          ? {
              label: draft.invoiceNumber ?? ti('draftNumber'),
              href: `/invoices/${draft.invoiceId}`,
            }
          : null
      }
      onChanged={setRecord}
    >
      {suggestion !== undefined && (
        <MissingFields
          // Opened again with the suggestion of each version read.
          key={`${draft.version}:${values ? 'suggested' : 'none'}`}
          draft={draft}
          apiPath="/invoice-drafts"
          newLineFields={NEW_INVOICE_LINE_FIELDS}
          suggested={suggested}
          // A due date follows the invoice date: a suggested one goes when the date is changed.
          dependents={{ invoiceDate: ['dueDate'] }}
          onChanged={setRecord}
        />
      )}
      {draft.actions.canDecide && (
        <OtherInvoicesCheck
          invoices={draft.shipmentInvoices}
          checked={confirmed}
          onChange={setConfirmed}
        />
      )}
      <dl className="details">
        <dt>{ti('shipment')}</dt>
        <dd dir="ltr">
          {inv.shipmentId ? (
            <Link href={`/shipments/${inv.shipmentId}`}>{shipmentNumber}</Link>
          ) : (
            '—'
          )}
        </dd>
        <dt>{ti('customer')}</dt>
        <dd>{draft.customerName ?? '—'}</dd>
        <dt>{ti('currency')}</dt>
        <dd dir="ltr">{inv.currency ?? '—'}</dd>
        <dt>{ti('invoiceDate')}</dt>
        <dd dir="ltr">{inv.invoiceDate ?? '—'}</dd>
        <dt>{ti('dueDate')}</dt>
        <dd dir="ltr">{inv.dueDate ?? '—'}</dd>
        <dt>{tc('notes')}</dt>
        <dd>{inv.notes ?? '—'}</dd>
      </dl>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{ti('chargeType')}</th>
              <th>{ti('description')}</th>
              <th>{ti('quantity')}</th>
              <th>{ti('unitPrice')}</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((line, i) => (
              <tr key={i}>
                <td dir="ltr">{line.chargeTypeCode ?? '—'}</td>
                <td>{line.description ?? '—'}</td>
                <td dir="ltr">{line.quantity ?? '—'}</td>
                <td>
                  {line.unitPrice ? <Money value={line.unitPrice} currency={currency} /> : '—'}
                  <DraftPriceSourceNote source={draft.priceSources[i]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DraftFrame>
  );
}
