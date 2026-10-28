import type {
  BookingFromQuotationRequest,
  BookingItemInput,
  BookingService,
  CreateBookingRequest,
  CreateQuotationRequest,
  DateString,
  QuotationLineInput,
} from './commercial.js';
import type { ConsolidationStatus } from './consolidation.js';
import type { DecimalString } from './currencies.js';
import type {
  DraftBranchChoice,
  DraftValues,
  EntryDraftCheck,
  EntryDraftReviewFields,
  MissingFieldsReview,
} from './drafts.js';

/**
 * Quotation and booking drafts proposed by the staff AI assistant (entry drafts, drafts.ts). The
 * assistant proposes the create request; a person reviews it and approves, which creates an
 * ordinary DRAFT quotation or booking (still editable, not sent or confirmed) through NOLON's own
 * service with that person's permissions and branches, or rejects it with a reason.
 */

// ---------------------------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------------------------

/** A quotation line as a draft holds it: its quantity may be missing. */
export type QuotationDraftLine = DraftValues<
  Omit<QuotationLineInput, 'priceCategoryCode'>,
  'quantity'
>;

/**
 * A quotation as a quotation draft holds it (no required business fields): the customer, route,
 * cargo, currency, validity and lines may all be missing until a person fills them in.
 */
export type QuotationDraftValues = DraftValues<
  Omit<CreateQuotationRequest, 'lines'>,
  | 'customerId'
  | 'originLocationId'
  | 'destinationLocationId'
  | 'mode'
  | 'cargoType'
  | 'currency'
  | 'validUntil'
> & { lines: QuotationDraftLine[] };

/** A quotation draft's values without its customer (the quotation part of a new customer's). */
export type QuotationDraftQuotation = Omit<QuotationDraftValues, 'customerId'>;

/** POST /quotation-drafts: the assistant proposes a quotation (lines may be left out). */
export type QuotationDraftCreateRequest = Omit<QuotationDraftValues, 'lines'> &
  DraftBranchChoice & {
    /** Scoped to the assistant client and the user it acts for. */
    idempotencyKey: string;
    lines?: QuotationDraftLine[];
  };

/**
 * PATCH /quotation-drafts/:id: a person fills in or changes values of an open draft (null clears
 * a value, `lines` replace the draft's lines as a whole). A customer named must be of the
 * draft's branch; the branch stays.
 */
export type QuotationDraftUpdateRequest = Partial<QuotationDraftValues> & {
  version: number;
};

/**
 * Drafts made for a customer: the customer is in the reviewer's branches. Null while the draft
 * names no customer yet.
 */
export interface CustomerDraftFields {
  customerId: string | null;
  customerName: string | null;
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

export interface QuotationDraftDto
  extends EntryDraftReviewFields, CustomerDraftFields, MissingFieldsReview {
  /** The proposed request, as stored (a missing value is null). */
  request: QuotationDraftValues;
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

/** A cargo line as a booking draft holds it: its cargo type and quantity may be missing. */
export type BookingDraftItem = DraftValues<BookingItemInput, 'cargoType' | 'quantity'>;

/** A booking made from an approved quotation, as its draft holds it. */
export type BookingDraftFromQuotation = Omit<BookingFromQuotationRequest, 'items'> & {
  items?: BookingDraftItem[];
};

/**
 * A direct booking as its draft holds it (no required business fields): the customer, route,
 * cargo, services and lines may all be missing.
 */
export type BookingDraftDirect = DraftValues<
  Omit<CreateBookingRequest, 'items' | 'services'>,
  'customerId' | 'originLocationId' | 'destinationLocationId' | 'mode' | 'cargoType'
> &
  ContainerChoice & { services?: BookingService[]; items?: BookingDraftItem[] };

/**
 * POST /booking-drafts: the assistant proposes a booking, either from an approved quotation
 * (quotationId; route and cargo come from it) or directly for a customer.
 */
export type BookingDraftCreateRequest =
  | (BookingDraftFromQuotation &
      DraftBranchChoice & { idempotencyKey: string; quotationId: string })
  | (BookingDraftDirect & DraftBranchChoice & { idempotencyKey: string });

/**
 * PATCH /booking-drafts/:id: a person fills in or changes values of an open draft (null clears a
 * value, `items` and `services` as a whole). The quotation and the branch stay; a direct draft's
 * customer may be named, of the draft's branch; a draft made from a quotation takes no customer,
 * route or cargo (they come from the quotation).
 */
export type BookingDraftUpdateRequest = Partial<BookingDraftDirect> & {
  version: number;
};

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
  | (BookingDraftFromQuotation & { quotationId: string; quotationNumber: string })
  | (BookingDraftDirect & { quotationId?: undefined });

export interface BookingDraftDto
  extends EntryDraftReviewFields, CustomerDraftFields, MissingFieldsReview {
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
