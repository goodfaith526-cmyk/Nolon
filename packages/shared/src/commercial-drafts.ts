import type {
  BookingFromQuotationRequest,
  CreateBookingRequest,
  CreateQuotationRequest,
} from './commercial.js';
import type { EntryDraftCheck, EntryDraftReviewFields } from './drafts.js';

/**
 * Quotation and booking drafts proposed by the staff AI assistant (entry drafts, drafts.ts). The
 * assistant proposes the create request; a person reviews it and approves, which creates an
 * ordinary DRAFT quotation or booking (still editable, not sent or confirmed) through NOLON's own
 * service with that person's permissions and branches, or rejects it with a reason.
 */

// ---------------------------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------------------------

/** POST /quotation-drafts: the assistant proposes a quotation. */
export interface QuotationDraftCreateRequest extends CreateQuotationRequest {
  /** Scoped to the assistant client and the user it acts for. */
  idempotencyKey: string;
}

/** Drafts made for a customer: the customer is in the reviewer's branches. */
export interface CustomerDraftFields {
  customerId: string;
  customerName: string;
}

export interface QuotationDraftDto extends EntryDraftReviewFields, CustomerDraftFields {
  /** The proposed request, as stored. */
  request: CreateQuotationRequest;
  check: EntryDraftCheck | null;
  /** The quotation an approval created. */
  quotationId: string | null;
  quotationNumber: string | null;
}

export type QuotationDraftListItemDto = Omit<QuotationDraftDto, 'request' | 'check'> & {
  lineCount: number;
};

// ---------------------------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------------------------

/**
 * POST /booking-drafts: the assistant proposes a booking, either from an approved quotation
 * (quotationId; route and cargo come from it) or directly for a customer.
 */
export type BookingDraftCreateRequest =
  | (BookingFromQuotationRequest & { idempotencyKey: string; quotationId: string })
  | (CreateBookingRequest & { idempotencyKey: string });

/** A booking draft's proposed request, as stored. */
export type BookingDraftRequest =
  | (BookingFromQuotationRequest & { quotationId: string; quotationNumber: string })
  | (CreateBookingRequest & { quotationId?: undefined });

export interface BookingDraftDto extends EntryDraftReviewFields, CustomerDraftFields {
  request: BookingDraftRequest;
  check: EntryDraftCheck | null;
  /** The booking an approval created. */
  bookingId: string | null;
  bookingNumber: string | null;
}

export type BookingDraftListItemDto = Omit<BookingDraftDto, 'request' | 'check'> & {
  lineCount: number;
  sourceQuotationNumber: string | null;
};
