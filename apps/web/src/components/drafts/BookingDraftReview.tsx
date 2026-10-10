'use client';

import type { BookingDraftDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';

/** A booking the assistant proposed: its values as proposed, and the decision. */
export function BookingDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tb = useTranslations('Bookings');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const { record: draft, notice, setRecord } = useRecord<BookingDraftDto>(`/booking-drafts/${id}`);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const b = draft.request;

  return (
    <DraftFrame
      draft={draft}
      apiPath="/booking-drafts"
      title={t('bookingTitle', { customer: draft.customerName })}
      approveHint={t('bookingApproveHint')}
      result={
        draft.bookingId
          ? { label: draft.bookingNumber ?? '', href: `/bookings/${draft.bookingId}` }
          : null
      }
      onChanged={setRecord}
    >
      <dl className="details">
        {b.quotationId !== undefined ? (
          <>
            <dt>{t('fromQuotation')}</dt>
            <dd dir="ltr">
              <Link href={`/quotations/${b.quotationId}`}>{b.quotationNumber}</Link>
            </dd>
          </>
        ) : (
          <>
            <dt>{tb('route')}</dt>
            <dd>
              {tc('route', {
                from: locationName(b.originLocationId),
                to: locationName(b.destinationLocationId),
              })}
            </dd>
            <dt>{tb('mode')}</dt>
            <dd>
              {te(`mode_${b.mode}`)}
              {b.loadType ? ` · ${b.loadType}` : ''} · {te(`cargo_${b.cargoType}`)}
            </dd>
            <dt>{tb('cargoDescription')}</dt>
            <dd>{b.cargoDescription ?? '—'}</dd>
          </>
        )}
        <dt>{tb('services')}</dt>
        <dd>
          {new Intl.ListFormat(locale).format((b.services ?? []).map((s) => te(`service_${s}`)))}
        </dd>
        <dt>{tb('requestedDeparture')}</dt>
        <dd dir="ltr">{b.requestedDeparture ?? '—'}</dd>
        <dt>{tb('specialInstructions')}</dt>
        <dd>{b.specialInstructions ?? '—'}</dd>
      </dl>
      {(b.items ?? []).length === 0 ? (
        <p className="muted">{tb('noItems')}</p>
      ) : (
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
              {(b.items ?? []).map((item, i) => (
                <tr key={i}>
                  <td>
                    {te(`cargo_${item.cargoType}`)}
                    {item.containerTypeCode ? ` ${item.containerTypeCode}` : ''}
                  </td>
                  <td>{item.description ?? '—'}</td>
                  <td dir="ltr">{item.quantity}</td>
                  <td dir="ltr">{item.weightKg ?? '—'}</td>
                  <td dir="ltr">{item.volumeCbm ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DraftFrame>
  );
}
