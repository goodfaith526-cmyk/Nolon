import type {
  DraftPriceSource,
  QuotationDraftLine,
  QuotationDraftPricing,
  QuotationDraftQuotation,
} from './commercial-drafts.js';
import type { CustomerDraftRequest } from './customer-drafts.js';
import type {
  DraftEvidence,
  EntryDraftCheck,
  EntryDraftReviewFields,
  EntryDraftSummaryDto,
  EvidenceReviewFields,
  MissingFieldsReview,
} from './drafts.js';

/**
 * A quotation the staff assistant proposes for someone not in NOLON yet (entry drafts, drafts.ts),
 * from one form with the new customer's details and the quotation's. Unlike a booking for a new
 * customer, the customer is not a draft of its own: a person approves this one draft on the review
 * screen, which creates the customer and an ordinary DRAFT quotation for it in one transaction.
 * A line given no rate card and no price takes the system price (the one approved rate card of the
 * branch that matches), as on a quotation draft.
 */

/**
 * The words the assistant may give for the customer; every other field it gives words for is the
 * quotation's (`originLocationId`, `destinationLocationId`, `currency`, `lines[N].quantity`,
 * `lines[N].unitPrice`, `lines[N].discount`).
 */
export const NEW_CUSTOMER_QUOTATION_CUSTOMER_FIELDS = [
  'branchId',
  'name',
  'phone',
  'whatsapp',
] as const;

/** The quotation part of a create request: any value may be left out, lines included. */
export type NewCustomerQuotationDraftQuotationInput = Omit<QuotationDraftQuotation, 'lines'> & {
  lines?: QuotationDraftLine[];
};

/**
 * POST /new-customer-quotation-drafts: the branch is one of the user's branches (security
 * context, required). No business value is required: the customer and the quotation may each be
 * left out, or hold only some values, until a person fills them in (owner decision, 2026-10-17).
 */
export interface NewCustomerQuotationDraftCreateRequest {
  idempotencyKey: string;
  branchId: string;
  customer?: CustomerDraftRequest;
  /** The quotation without its customer, priced in `branchId`. */
  quotation?: NewCustomerQuotationDraftQuotationInput;
  evidence?: DraftEvidence[];
}

/**
 * PATCH /new-customer-quotation-drafts/:id: a person fills in or changes values of an open draft
 * at the version they read. Each part's values given replace the stored ones (null clears one,
 * `quotation.lines` replace the lines as a whole); the branch stays.
 */
export interface NewCustomerQuotationDraftUpdateRequest {
  version: number;
  customer?: CustomerDraftRequest;
  quotation?: Partial<QuotationDraftQuotation>;
}

/** POST /new-customer-quotation-drafts/:id/approve: what the person reviewed and ticked. */
export interface NewCustomerQuotationDraftApproveRequest {
  version: number;
  /** The pricing the person reviewed (`pricing.key`). */
  pricingKey: string;
  /** Each value ticked against the staff member's words. */
  confirmed?: string[];
}

export interface NewCustomerQuotationDraftDto
  extends EntryDraftReviewFields, EvidenceReviewFields, MissingFieldsReview {
  branchCode: string;
  customer: CustomerDraftRequest;
  /** The proposed quotation, as stored (a missing value null). */
  request: QuotationDraftQuotation;
  /** NOLON's checks of the customer and the quotation now. */
  check: EntryDraftCheck | null;
  /** While open and accepted by NOLON: the prices an approval would record. */
  pricing: QuotationDraftPricing | null;
  /** With `pricing`: where each line's price comes from, in the lines' order. */
  priceSources: DraftPriceSource[] | null;
  /** The customer and the DRAFT quotation the approval created. */
  customerId: string | null;
  customerNumber: string | null;
  quotationId: string | null;
  quotationNumber: string | null;
}

export type NewCustomerQuotationDraftListItemDto = Omit<
  NewCustomerQuotationDraftDto,
  'request' | 'check' | 'evidence' | 'pricing' | 'priceSources' | 'customer'
> & {
  lineCount: number;
  phone: string | null;
};

/** What the assistant gets back: ids, status and counts. */
export type NewCustomerQuotationDraftSummaryDto = EntryDraftSummaryDto;
