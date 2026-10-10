import type { CreateReceiptRequest, CustomerInvoiceInput } from './accounting.js';
import type { CustomerDraftFields } from './commercial-drafts.js';
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

/** POST /invoice-drafts: the assistant proposes an invoice for a shipment. */
export interface InvoiceDraftCreateRequest extends InvoiceDraftRequest {
  idempotencyKey: string;
}

export interface InvoiceDraftDto extends EntryDraftReviewFields, CustomerDraftFields {
  shipmentNumber: string;
  request: InvoiceDraftRequest;
  /** The total NOLON computes now (lines rounded to the currency). */
  check: EntryDraftCheck | null;
  invoiceId: string | null;
  /** Null until the created invoice is itself approved and numbered. */
  invoiceNumber: string | null;
}

export type InvoiceDraftListItemDto = Omit<InvoiceDraftDto, 'request' | 'check'> & {
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
