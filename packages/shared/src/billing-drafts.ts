import type { CreateReceiptRequest, CustomerInvoiceInput } from './accounting.js';
import type { CustomerDraftFields, DraftPriceSource } from './commercial-drafts.js';
import type { DecimalString } from './currencies.js';
import type { EntryDraftCheck, EntryDraftReviewFields } from './drafts.js';

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

/** An invoice draft's proposed values, as stored. */
export interface InvoiceDraftRequest extends Omit<CustomerInvoiceInput, 'fxRate'> {
  shipmentId: string;
}

/**
 * A proposed invoice line. Without a unit price NOLON prices it (the system price): from the
 * shipment's quotation line for that charge, else from the approved rate card that matches the
 * shipment, the charge and the invoice date. The price found is stored in the draft.
 */
export interface InvoiceDraftLineInput {
  chargeTypeCode: string;
  description?: string | null;
  quantity: DecimalString;
  unitPrice?: DecimalString;
}

/** POST /invoice-drafts: the assistant proposes an invoice for a shipment. */
export interface InvoiceDraftCreateRequest extends Omit<InvoiceDraftRequest, 'lines'> {
  lines: InvoiceDraftLineInput[];
  idempotencyKey: string;
}

export interface InvoiceDraftDto extends EntryDraftReviewFields, CustomerDraftFields {
  shipmentNumber: string;
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

/** A receipt draft's proposed values, as stored. */
export type ReceiptDraftRequest = Omit<CreateReceiptRequest, 'fxRate'>;

/** POST /receipt-drafts: the assistant proposes a receipt. */
export interface ReceiptDraftCreateRequest extends ReceiptDraftRequest {
  idempotencyKey: string;
}

export interface ReceiptDraftDto extends EntryDraftReviewFields, CustomerDraftFields {
  request: ReceiptDraftRequest;
  cashAccountCode: string;
  cashAccountNameEn: string;
  cashAccountNameAr: string;
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
  amount: DecimalString;
  currency: string;
};
