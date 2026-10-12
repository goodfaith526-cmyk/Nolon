'use client';

import { useTranslations } from 'next-intl';
import { BookingDraftReview } from './BookingDraftReview';
import { CustomerDraftReview } from './CustomerDraftReview';
import { InvoiceDraftReview } from './InvoiceDraftReview';
import { QuotationDraftReview } from './QuotationDraftReview';
import { ReceiptDraftReview } from './ReceiptDraftReview';
import { ReleaseDraftReview } from './ReleaseDraftReview';
import { ShipmentStatusDraftReview } from './ShipmentStatusDraftReview';
import { TripDraftReview } from './TripDraftReview';

/** The review screen of one draft, by entry type. */
export function DraftReviewPage({ kind, id }: { kind: string; id: string }) {
  const tc = useTranslations('Common');
  if (kind === 'customers') return <CustomerDraftReview id={id} />;
  if (kind === 'quotations') return <QuotationDraftReview id={id} />;
  if (kind === 'bookings') return <BookingDraftReview id={id} />;
  if (kind === 'trips') return <TripDraftReview id={id} />;
  if (kind === 'releases') return <ReleaseDraftReview id={id} />;
  if (kind === 'shipment-statuses') return <ShipmentStatusDraftReview id={id} />;
  if (kind === 'invoices') return <InvoiceDraftReview id={id} />;
  if (kind === 'receipts') return <ReceiptDraftReview id={id} />;
  return <p className="error">{tc('notFound')}</p>;
}
