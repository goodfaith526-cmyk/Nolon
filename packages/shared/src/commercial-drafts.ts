import type {
  BookingFromQuotationRequest,
  CreateBookingRequest,
  CreateQuotationRequest,
  DateString,
} from './commercial.js';
import type { ConsolidationStatus } from './consolidation.js';
import type { DecimalString } from './currencies.js';
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

/** Where a draft line's unit price comes from. */
export const PRICE_SOURCES = ['TYPED', 'QUOTATION', 'RATE_CARD'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/**
 * TYPED: the staff member gave it; QUOTATION: the shipment's quotation (its agreed price);
 * RATE_CARD: an approved rate card (`rateCardId`), the one the line named or the only one that
 * matches it.
 */
export interface DraftPriceSource {
  source: PriceSource;
  rateCardId: string | null;
}

/**
 * What approving would record now: every line priced as NOLON prices it (a rate card line at
 * the rate's current price). The person reviews these prices; the approval sends `key` back and
 * records exactly them, or is refused (409) when anything changed since, a rate card included.
 */
export interface QuotationDraftPricing {
  key: string;
  lines: {
    chargeTypeCode: string;
    unit: string;
    quantity: DecimalString;
    unitPrice: DecimalString;
    minimumCharge: DecimalString;
    discount: DecimalString;
    lineTotal: DecimalString;
  }[];
  subtotal: DecimalString;
  discountTotal: DecimalString;
  total: DecimalString;
}

/** POST /quotation-drafts/:id/approve: the version and the pricing the person reviewed. */
export interface QuotationDraftApproveRequest {
  version: number;
  pricingKey: string;
}

export interface QuotationDraftDto extends EntryDraftReviewFields, CustomerDraftFields {
  /** The proposed request, as stored. */
  request: CreateQuotationRequest;
  check: EntryDraftCheck | null;
  /** While open and accepted by NOLON: the prices an approval would record. */
  pricing: QuotationDraftPricing | null;
  /** With `pricing`: where each line's price comes from, in the lines' order. */
  priceSources: DraftPriceSource[] | null;
  /** The quotation an approval created. */
  quotationId: string | null;
  quotationNumber: string | null;
}

export type QuotationDraftListItemDto = Omit<
  QuotationDraftDto,
  'request' | 'check' | 'pricing' | 'priceSources'
> & {
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
  | (CreateBookingRequest & ContainerChoice & { idempotencyKey: string });

/**
 * An open LCL container a direct booking draft goes in (consolidation.ts). Approving such a draft
 * records the booking, confirms it (its shipment is created) and puts the shipment in the
 * container, in one transaction, as booking from the container's page does; NOLON checks again
 * then that the container is still open with room. Absent when the booking goes in no container.
 */
export interface ContainerChoice {
  consolidationId?: string | null;
}

/** The container a booking draft names, as its review screen shows it. */
export interface DraftContainer {
  id: string;
  number: string;
  status: ConsolidationStatus;
  containerTypeCode: string;
  containerNumber: string | null;
  etd: DateString | null;
}

/** A booking draft's proposed request, as stored (`consolidationId` only when it names one). */
export type BookingDraftRequest =
  | (BookingFromQuotationRequest & { quotationId: string; quotationNumber: string })
  | (CreateBookingRequest & ContainerChoice & { quotationId?: undefined });

export interface BookingDraftDto extends EntryDraftReviewFields, CustomerDraftFields {
  request: BookingDraftRequest;
  check: EntryDraftCheck | null;
  /** The container the booking goes in on approval (null when none, or when it no longer exists). */
  container: DraftContainer | null;
  /** The booking an approval created. */
  bookingId: string | null;
  bookingNumber: string | null;
}

export type BookingDraftListItemDto = Omit<BookingDraftDto, 'request' | 'check' | 'container'> & {
  lineCount: number;
  sourceQuotationNumber: string | null;
};
