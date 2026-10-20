'use client';

import type { QuotationDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { MissingFields } from './MissingFields';
import { DraftPriceSourceNote } from './DraftPriceSourceNote';

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
  const pricing = draft.pricing;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const place = (id: string | null | undefined) => (id ? locationName(id) : '—');
  const currency = q.currency ?? undefined;
  // A line with neither a rate card nor a price takes the system price (the matching rate card).
  const systemPriced = q.lines.some((l) => !l.rateCardId && l.unitPrice === undefined);

  return (
    <DraftFrame
      draft={draft}
      apiPath="/quotation-drafts"
      title={t('quotationTitle', { customer: draft.customerName ?? '—' })}
      approveHint={
        systemPriced
          ? `${t('quotationApproveHint')} ${t('systemPriceHint')}`
          : t('quotationApproveHint')
      }
      result={
        draft.quotationId
          ? { label: draft.quotationNumber ?? '', href: `/quotations/${draft.quotationId}` }
          : null
      }
      approveBody={pricing ? { pricingKey: pricing.key } : null}
      onChanged={setRecord}
    >
      <MissingFields draft={draft} apiPath="/quotation-drafts" onChanged={setRecord} />
      <dl className="details">
        <dt>{tq('route')}</dt>
        <dd>
          {tc('route', {
            from: place(q.originLocationId),
            to: place(q.destinationLocationId),
          })}
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
    </DraftFrame>
  );
}
