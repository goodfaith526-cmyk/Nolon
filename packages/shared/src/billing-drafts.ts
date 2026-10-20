import type { CreateReceiptRequest, CustomerInvoiceInput } from './accounting.js';
import type { BookingService, RateUnit } from './commercial.js';
import type { CustomerDraftFields, DraftPriceSource, PriceSource } from './commercial-drafts.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type {
  DraftBranchChoice,
  DraftUpdateRequest,
  DraftValues,
  EntryDraftCheck,
  EntryDraftReviewFields,
  MissingFieldsReview,
} from './drafts.js';

/**
 * Invoice and receipt drafts proposed by the staff AI assistant (entry drafts, drafts.ts). A
 * person approves an invoice draft, which creates an ordinary DRAFT invoice (nothing is posted;
 * approving the invoice stays a separate step), or a receipt draft, which records and posts an
 * ordinary receipt; or rejects it. The fx rate is never the assistant's: it comes from the rate
 * table for the document date.
 */

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

/** An invoice line as a draft stores it: any value may be missing (null) until filled in. */
export interface InvoiceDraftLine {
  chargeTypeCode: string | null;
  description?: string | null;
  quantity: DecimalString | null;
  /** Null until priced: typed by the staff member, or the system price once it can be found. */
  unitPrice: DecimalString | null;
}

/**
 * An invoice draft's proposed values, as stored: the shipment, currency, dates and lines may be
 * missing (null) until a person fills them in.
 */
export type InvoiceDraftRequest = DraftValues<
  Omit<CustomerInvoiceInput, 'fxRate' | 'lines'>,
  'currency' | 'invoiceDate' | 'dueDate'
> & {
  shipmentId: string | null;
  lines: InvoiceDraftLine[];
};

/**
 * A proposed invoice line. Without a unit price NOLON prices it (the system price): from the
 * shipment's quotation line for that charge, else from the approved rate card that matches the
 * shipment, the charge and the invoice date, once the draft has the shipment, the currency, the
 * dates and each line's charge and quantity. The price found is stored in the draft.
 */
export interface InvoiceDraftLineInput {
  chargeTypeCode?: string | null;
  description?: string | null;
  quantity?: DecimalString | null;
  unitPrice?: DecimalString | null;
}

/**
 * POST /invoice-drafts: the assistant proposes an invoice for a shipment. No value is required;
 * with no shipment yet, the draft names its branch.
 */
export type InvoiceDraftCreateRequest = Omit<InvoiceDraftRequest, 'lines' | 'shipmentId'> &
  DraftBranchChoice & {
    shipmentId?: string | null;
    lines?: InvoiceDraftLineInput[];
    idempotencyKey: string;
  };

/**
 * PATCH /invoice-drafts/:id: `lines` replace the draft's lines as a whole. A line kept without a
 * typed price is priced again by NOLON once the draft can be priced.
 */
export type InvoiceDraftUpdateRequest = DraftUpdateRequest<
  Omit<InvoiceDraftRequest, 'lines'> & { lines: InvoiceDraftLineInput[] }
>;

/**
 * POST /invoice-drafts/suggest: what NOLON would put on an invoice for this shipment, read-only
 * (nothing is written). `currency` and `invoiceDate`, when given, are the ones to derive for;
 * otherwise NOLON's defaults. Access is the invoice's: the shipment's owning branch only.
 */
export interface InvoiceSuggestRequest {
  shipmentId: string;
  currency?: CurrencyCode;
  invoiceDate?: string;
}

/**
 * Why the suggestion is in its currency: the one asked for, the shipment's quotation's, the
 * customer's preferred currency, else the branch default.
 */
export const INVOICE_SUGGESTION_CURRENCY_SOURCES = [
  'REQUESTED',
  'QUOTATION',
  'CUSTOMER',
  'BRANCH',
] as const;
export type InvoiceSuggestionCurrencySource = (typeof INVOICE_SUGGESTION_CURRENCY_SOURCES)[number];

/**
 * FILL: the line is the invoice's (the quotation's line, or a rate card for a charge of a service
 * the shipment has, its quantity exact). OFFER: a line to propose, never to fill on its own.
 */
export type InvoiceSuggestionLineUse = 'FILL' | 'OFFER';

export interface InvoiceSuggestionLineDto {
  chargeTypeCode: string;
  description: string | null;
  /** The pricing unit (the quotation line's or the rate card's). */
  unit: RateUnit;
  /** Null when the unit's measure is missing or ambiguous on the shipment (`unresolved` says). */
  quantity: DecimalString | null;
  /** Null when no price applies in this currency (`unresolved` says). */
  unitPrice: DecimalString | null;
  priceSource: PriceSource;
  rateCardId: string | null;
  /** The charge's service (master data), or null when the charge has none. */
  service: BookingService | null;
  use: InvoiceSuggestionLineUse;
  /**
   * The unit price is part of the line: created without it, NOLON prices the line otherwise (a
   * minimum charge below the shipment's measure, invoiced as one unit at the minimum). A caller
   * filling the line sends this price with it.
   */
  fillPrice: boolean;
}

export const INVOICE_SUGGESTION_ISSUES = [
  /** The quotation prices the shipment in another currency. */
  'QUOTED_PRICE_OTHER_CURRENCY',
  /** Several approved rate cards match one charge: no line is suggested for it. */
  'RATE_SEVERAL',
  /** A measure the unit needs is missing or ambiguous: the quantity is left empty. */
  'QUANTITY_UNKNOWN',
  /** The charge has no service: a tariff is not proof the charge happened. */
  'SERVICE_NOT_MAPPED',
  /** The charge's service is not one of the shipment's services. */
  'SERVICE_NOT_ON_SHIPMENT',
] as const;
export type InvoiceSuggestionIssue = (typeof INVOICE_SUGGESTION_ISSUES)[number];

export interface InvoiceSuggestionUnresolved {
  /** The field it concerns: `lines.<i>.quantity`, `lines.<i>.unitPrice`, `lines.<i>` or `lines`. */
  path: string;
  code: InvoiceSuggestionIssue;
  message: string;
}

export interface InvoiceSuggestionDto {
  shipmentId: string;
  /** The shipment's owning branch, where the invoice belongs. */
  branchId: string;
  currency: CurrencyCode;
  currencySource: InvoiceSuggestionCurrencySource;
  invoiceDate: string;
  /** The invoice date plus the customer's payment terms. */
  dueDate: string;
  lines: InvoiceSuggestionLineDto[];
  unresolved: InvoiceSuggestionUnresolved[];
  /**
   * sha256 over what the suggestion was derived from: the shipment, its owning branch, the
   * currency, the pricing date, the source revision (the quotation's or the rate cards' ids and
   * `updatedAt`) and each line's charge, unit and service. Equal fingerprints, same suggestion.
   */
  fingerprint: string;
}

/**
 * GET /invoice-drafts/:id/suggested-values: NOLON's suggestion (suggestForShipment) for the
 * currency and dates an open invoice draft for a shipment misses, for the review screen's form.
 * Only the values the draft misses (null otherwise); `values` is null when there is nothing to
 * suggest. Nothing is saved: the person sees the values, may change them, and saves them with the
 * draft's PATCH at `version`, which moves the version (and what the assistant's card shows) on.
 */
export interface InvoiceDraftSuggestedValuesDto {
  /** The draft's version these were worked out for. */
  version: number;
  values: {
    currency: CurrencyCode | null;
    invoiceDate: string | null;
    dueDate: string | null;
  } | null;
  currencySource: InvoiceSuggestionCurrencySource | null;
}

export interface InvoiceDraftDto
  extends EntryDraftReviewFields, CustomerDraftFields, MissingFieldsReview {
  /** Null while the draft names no shipment yet. */
  shipmentNumber: string | null;
  request: InvoiceDraftRequest;
  /** Where each line's unit price came from, in the lines' order. */
  priceSources: DraftPriceSource[];
  /** The total NOLON computes now (lines rounded to the currency). */
  check: EntryDraftCheck | null;
  invoiceId: string | null;
  /** Null until the created invoice is itself approved and numbered. */
  invoiceNumber: string | null;
}

export type InvoiceDraftListItemDto = Omit<
  InvoiceDraftDto,
  'request' | 'check' | 'priceSources'
> & {
  lineCount: number;
};

// ---------------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------------

/** An allocation of a receipt draft: its invoice and amount may be missing until filled in. */
export interface ReceiptDraftAllocation {
  invoiceId?: string | null;
  amount?: DecimalString | null;
}

/**
 * A receipt draft's proposed values, as stored: the customer, date, currency, amount, cash
 * account and each allocation's values may be missing (null) until a person fills them in.
 */
export type ReceiptDraftRequest = DraftValues<
  Omit<CreateReceiptRequest, 'fxRate' | 'allocations'>,
  'customerId' | 'receiptDate' | 'currency' | 'amount' | 'cashAccountId'
> & { allocations: ReceiptDraftAllocation[] };

/**
 * POST /receipt-drafts: the assistant proposes a receipt. No value is required; with no customer
 * yet, the draft names its branch.
 */
export type ReceiptDraftCreateRequest = Omit<ReceiptDraftRequest, 'allocations'> &
  DraftBranchChoice & {
    allocations?: ReceiptDraftAllocation[];
    idempotencyKey: string;
  };

/** PATCH /receipt-drafts/:id: `allocations` replace the draft's as a whole. */
export type ReceiptDraftUpdateRequest = DraftUpdateRequest<ReceiptDraftRequest>;

/** A cash or bank account a receipt for a customer may use (GET /receipt-drafts/cash-accounts). */
export interface ReceiptCashAccountDto {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  currency: CurrencyCode;
  isActive: boolean;
}

/** An approved invoice of the customer with something left to pay (GET /receipt-drafts/open-invoices). */
export interface ReceiptOpenInvoiceDto {
  id: string;
  number: string | null;
  currency: CurrencyCode;
  total: DecimalString;
  /** Total less payments and credit notes. */
  outstanding: DecimalString;
  invoiceDate: string;
  dueDate: string;
}

/** Most open invoices GET /receipt-drafts/open-invoices returns, oldest due first. */
export const RECEIPT_OPEN_INVOICES_MAX = 40;

export interface ReceiptDraftDto
  extends EntryDraftReviewFields, CustomerDraftFields, MissingFieldsReview {
  request: ReceiptDraftRequest;
  /** Null while the draft names no cash account yet. */
  cashAccountCode: string | null;
  cashAccountNameEn: string | null;
  cashAccountNameAr: string | null;
  /** The invoices' numbers, in the allocations' order. */
  invoiceNumbers: string[];
  check: EntryDraftCheck | null;
  receiptId: string | null;
  receiptNumber: string | null;
}

export type ReceiptDraftListItemDto = Omit<
  ReceiptDraftDto,
  'request' | 'check' | 'invoiceNumbers'
> & {
  lineCount: number;
  amount: DecimalString | null;
  currency: string | null;
};
