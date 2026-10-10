'use client';

import { useTranslations } from 'next-intl';
import { BookingDraftReview } from './BookingDraftReview';
import { QuotationDraftReview } from './QuotationDraftReview';
import { ReleaseDraftReview } from './ReleaseDraftReview';
import { TripDraftReview } from './TripDraftReview';

/** The review screen of one draft, by entry type. */
export function DraftReviewPage({ kind, id }: { kind: string; id: string }) {
  const tc = useTranslations('Common');
  if (kind === 'quotations') return <QuotationDraftReview id={id} />;
  if (kind === 'bookings') return <BookingDraftReview id={id} />;
  if (kind === 'trips') return <TripDraftReview id={id} />;
  if (kind === 'releases') return <ReleaseDraftReview id={id} />;
  return <p className="error">{tc('notFound')}</p>;
}
