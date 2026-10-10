import type {
  BookingFromQuotationRequest,
  CreateBookingRequest,
  CreateQuotationRequest,
} from './commercial.js';
import type { DecimalString } from './currencies.js';
import type { DraftActions, DraftStatus } from './drafts.js';

/**
 * Quotation and booking drafts proposed by the staff AI assistant (entry drafts, drafts.ts). The
 * assistant proposes the create request; a person reviews it and approves, which creates an
 * ordinary DRAFT quotation or booking (still editable, not sent or confirmed) through NOLON's own
 * service with that person's permissions and branches, or rejects it with a reason.
 */

/** What the assistant gets back: ids, status and counts, never the values it sent. */
export interface EntryDraftSummaryDto {
  id: string;
  status: DraftStatus;
  version: number;
  lineCount: number;
  expiresAt: string;
  createdAt: string;
}

/** Common to every draft a person reviews. */
export interface EntryDraftReviewFields {
  id: string;
  branchId: string;
  customerId: string;
  customerName: string;
  status: DraftStatus;
  version: number;
  expiresAt: string;
  createdAt: string;
  /** The staff member the assistant acted for. */
  createdByName: string;
  decidedByName: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  actions: DraftActions;
}

/**
 * Whether the draft would be accepted by NOLON now, worked out on every read by the same checks
 * an approval runs (nothing is written). `message` is NOLON's own refusal.
 */
export type EntryDraftCheck =
  | { ok: true; total: DecimalString | null; currency: string | null }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------------------------

/** POST /quotation-drafts: the assistant proposes a quotation. */
export interface QuotationDraftCreateRequest extends CreateQuotationRequest {
  /** Scoped to the assistant client and the user it acts for. */
  idempotencyKey: string;
}

export interface QuotationDraftDto extends EntryDraftReviewFields {
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

export interface BookingDraftDto extends EntryDraftReviewFields {
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

/** POST .../approve: the version the person reviewed. */
export interface EntryDraftApproveRequest {
  version: number;
}
