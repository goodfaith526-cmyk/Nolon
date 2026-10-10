'use client';

import { useTranslations } from 'next-intl';
import { BookingDraftReview } from './BookingDraftReview';
import { QuotationDraftReview } from './QuotationDraftReview';

/** The review screen of one draft, by entry type. */
export function DraftReviewPage({ kind, id }: { kind: string; id: string }) {
  const tc = useTranslations('Common');
  if (kind === 'quotations') return <QuotationDraftReview id={id} />;
  if (kind === 'bookings') return <BookingDraftReview id={id} />;
  return <p className="error">{tc('notFound')}</p>;
}
