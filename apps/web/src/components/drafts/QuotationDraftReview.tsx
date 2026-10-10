'use client';

import type { QuotationDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';

/** A quotation the assistant proposed: its values as proposed, and the decision. */
export function QuotationDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tq = useTranslations('Quotations');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const locationName = useLocationName(master);
  const {
    record: draft,
    notice,
    setRecord,
  } = useRecord<QuotationDraftDto>(`/quotation-drafts/${id}`);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const q = draft.request;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/quotation-drafts"
      title={t('quotationTitle', { customer: draft.customerName })}
      approveHint={t('quotationApproveHint')}
      result={
        draft.quotationId
          ? { label: draft.quotationNumber ?? '', href: `/quotations/${draft.quotationId}` }
          : null
      }
      onChanged={setRecord}
    >
      <dl className="details">
        <dt>{tq('route')}</dt>
        <dd>
          {tc('route', {
            from: locationName(q.originLocationId),
            to: locationName(q.destinationLocationId),
          })}
        </dd>
        <dt>{tq('mode')}</dt>
        <dd>
          {te(`mode_${q.mode}`)}
          {q.loadType ? ` · ${q.loadType}` : ''} · {te(`cargo_${q.cargoType}`)}
        </dd>
        <dt>{tq('cargoDescription')}</dt>
        <dd>{q.cargoDescription ?? '—'}</dd>
        <dt>{tq('currency')}</dt>
        <dd dir="ltr">{q.currency}</dd>
        <dt>{tq('validUntil')}</dt>
        <dd dir="ltr">{q.validUntil}</dd>
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
            </tr>
          </thead>
          <tbody>
            {q.lines.map((line, i) => (
              <tr key={i}>
                <td>
                  {line.rateCardId ? tq('fromRate') : (line.chargeTypeCode ?? '—')}
                  {line.description ? ` · ${line.description}` : ''}
                </td>
                <td>{line.unit ? te(`unit_${line.unit}`) : '—'}</td>
                <td dir="ltr">{line.quantity}</td>
                <td>
                  {line.unitPrice ? <Money value={line.unitPrice} currency={q.currency} /> : '—'}
                </td>
                <td>
                  {line.discount ? <Money value={line.discount} currency={q.currency} /> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DraftFrame>
  );
}
