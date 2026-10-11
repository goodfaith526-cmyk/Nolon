'use client';

import type { InvoiceDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';

/** An invoice the assistant proposed for a shipment: its lines as proposed, and the decision. */
export function InvoiceDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const ti = useTranslations('Invoices');
  const tc = useTranslations('Common');
  const { record: draft, notice, setRecord } = useRecord<InvoiceDraftDto>(`/invoice-drafts/${id}`);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const inv = draft.request;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/invoice-drafts"
      title={t('invoiceTitle', { shipment: draft.shipmentNumber, customer: draft.customerName })}
      approveHint={t('invoiceApproveHint')}
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
      <dl className="details">
        <dt>{ti('shipment')}</dt>
        <dd dir="ltr">
          <Link href={`/shipments/${inv.shipmentId}`}>{draft.shipmentNumber}</Link>
        </dd>
        <dt>{ti('customer')}</dt>
        <dd>{draft.customerName}</dd>
        <dt>{ti('currency')}</dt>
        <dd dir="ltr">{inv.currency}</dd>
        <dt>{ti('invoiceDate')}</dt>
        <dd dir="ltr">{inv.invoiceDate}</dd>
        <dt>{ti('dueDate')}</dt>
        <dd dir="ltr">{inv.dueDate}</dd>
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
                <td dir="ltr">{line.chargeTypeCode}</td>
                <td>{line.description ?? '—'}</td>
                <td dir="ltr">{line.quantity}</td>
                <td>
                  <Money value={line.unitPrice} currency={inv.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DraftFrame>
  );
}
