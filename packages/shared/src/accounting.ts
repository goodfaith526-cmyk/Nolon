import type { CurrencyCode, DecimalString } from './currencies.js';
import type { DateString } from './commercial.js';

// The reporting currency every journal entry balances in is BASE_CURRENCY (currencies.ts).

/**
 * Accounting (scope section 13, annex C): chart of accounts, exchange rates, periods, journal
 * entries, customer invoices and receipts. Amounts are decimal strings; every journal line also
 * carries its USD amount, the reporting currency the entries balance on.
 */

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** The accounts automatic entries post to (annex C section 4). */
export const POSTING_ROLES = [
  'RECEIVABLE',
  'PAYABLE',
  'CUSTOMER_ADVANCES',
  'DEFAULT_REVENUE',
  'DEFAULT_COST',
  'TRANSPORT_COST',
  'REIMBURSABLE',
  'CONSOLIDATION_CLEARING',
  'ACCRUED_TRANSPORT',
  'FX_GAIN',
  'FX_LOSS',
  'ROUNDING',
  'OPENING_EQUITY',
] as const;
export type PostingRole = (typeof POSTING_ROLES)[number];

/**
 * The account type each posting role must map to, so automatic entries land in the right section
 * of the statements. Clearing accounts are balance-sheet accounts: reimbursable costs and the
 * consolidated container are assets until recharged, accrued transport is a liability until billed.
 */
export const ROLE_ACCOUNT_TYPES: Readonly<Record<PostingRole, AccountType>> = {
  RECEIVABLE: 'ASSET',
  PAYABLE: 'LIABILITY',
  CUSTOMER_ADVANCES: 'LIABILITY',
  DEFAULT_REVENUE: 'REVENUE',
  DEFAULT_COST: 'EXPENSE',
  TRANSPORT_COST: 'EXPENSE',
  REIMBURSABLE: 'ASSET',
  CONSOLIDATION_CLEARING: 'ASSET',
  ACCRUED_TRANSPORT: 'LIABILITY',
  FX_GAIN: 'REVENUE',
  FX_LOSS: 'EXPENSE',
  ROUNDING: 'EXPENSE',
  OPENING_EQUITY: 'EQUITY',
};

/** Subledger accounts: only invoices, receipts and payments post to them, never manual entries. */
export const CONTROL_ROLES: readonly PostingRole[] = ['RECEIVABLE', 'PAYABLE', 'CUSTOMER_ADVANCES'];

export const PERIOD_STATUSES = ['OPEN', 'CLOSED'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const JOURNAL_STATUSES = ['DRAFT', 'POSTED'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export const JOURNAL_SOURCES = [
  'MANUAL',
  'CUSTOMER_INVOICE',
  'RECEIPT',
  'REVERSAL',
  'TRIP_EXPENSE',
  'TRIP_ACCRUAL',
  'CREDIT_NOTE',
  'SUPPLIER_BILL',
  'SUPPLIER_PAYMENT',
  'EXPENSE',
  'OPENING_BALANCE',
  'CONSOLIDATION_ALLOCATION',
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export const INVOICE_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const RECEIPT_STATUSES = ['POSTED', 'CANCELLED'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Units of a currency per 1 USD, e.g. "600" for SDG. Up to 8 decimal places. */
export type FxRateString = string;

export interface AccountDto {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  isCash: boolean;
  currency: CurrencyCode | null;
  branchId: string | null;
  isActive: boolean;
  /** Mapped to a control role (receivable, payable, advances): no manual entries. */
  isControl: boolean;
}

export interface AccountInput {
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  parentId?: string | null;
  isPostable: boolean;
  isCash?: boolean;
  currency?: CurrencyCode | null;
  branchId?: string | null;
  isActive?: boolean;
}

export interface AccountMappingDto {
  role: PostingRole;
  accountId: string;
}

export interface ChargeTypePostingDto {
  chargeTypeCode: string;
  /** null: the DEFAULT_REVENUE account (or REIMBURSABLE when isReimbursable). */
  revenueAccountId: string | null;
  /** Cost account on supplier bills (rule 7). null: DEFAULT_COST (or REIMBURSABLE). */
  costAccountId?: string | null;
  isReimbursable: boolean;
}

export interface AccountingSettingsDto {
  mappings: AccountMappingDto[];
  chargeTypes: ChargeTypePostingDto[];
}

export interface FxRateDto {
  id: string;
  currency: CurrencyCode;
  rateDate: string;
  rate: FxRateString;
}

export interface FxRateInput {
  currency: CurrencyCode;
  rateDate: string;
  rate: FxRateString;
}

/** The rate a document dated `date` uses: the latest on or before it. */
export interface FxRateLookupDto {
  currency: CurrencyCode;
  rate: FxRateString;
  rateDate: string;
}

export interface FiscalPeriodDto {
  id: string;
  year: number;
  month: number;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  closedAt: string | null;
}

export interface JournalLineDto {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountNameEn: string;
  accountNameAr: string;
  branchId: string;
  shipmentId: string | null;
  shipmentNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  description: string | null;
  currency: CurrencyCode;
  fxRate: FxRateString;
  debit: DecimalString;
  credit: DecimalString;
  debitUsd: DecimalString;
  creditUsd: DecimalString;
}

export interface JournalEntrySummaryDto {
  id: string;
  number: string;
  branchId: string;
  entryDate: string;
  description: string;
  source: JournalSource;
  sourceId: string | null;
  status: JournalStatus;
  totalUsd: DecimalString;
  reversalOfId: string | null;
  reversedById: string | null;
}

export interface JournalEntryDto extends JournalEntrySummaryDto {
  /** Number of the invoice or receipt the entry came from. */
  sourceNumber: string | null;
  reversalOfNumber: string | null;
  reversedByNumber: string | null;
  createdByName: string;
  postedByName: string | null;
  postedAt: string | null;
  lines: JournalLineDto[];
  actions: { canEdit: boolean; canPost: boolean; canReverse: boolean; canDelete: boolean };
}

export interface ManualJournalLineInput {
  accountId: string;
  currency: CurrencyCode;
  /** Omitted: the rate table's rate for the entry date. Ignored for USD. */
  fxRate?: FxRateString | null;
  debit?: DecimalString;
  credit?: DecimalString;
  description?: string | null;
}

export interface ManualJournalInput {
  entryDate: string;
  description: string;
  lines: ManualJournalLineInput[];
}

export interface CreateManualJournalRequest extends ManualJournalInput {
  branchId: string;
}

export interface ReverseJournalRequest {
  /** Defaults to today in the entry's branch. Must fall in an open period. */
  entryDate?: string;
  reason: string;
}

export interface CustomerInvoiceLineDto {
  lineNo: number;
  chargeTypeCode: string;
  description: string | null;
  quantity: DecimalString;
  unitPrice: DecimalString;
  lineTotal: DecimalString;
}

export interface CustomerInvoiceLineInput {
  chargeTypeCode: string;
  description?: string | null;
  quantity: DecimalString;
  unitPrice: DecimalString;
}

export interface CustomerInvoiceSummaryDto {
  id: string;
  number: string | null;
  branchId: string;
  customerId: string;
  customerName: string;
  /** Null only for an opening item (isOpening). */
  shipmentId: string | null;
  shipmentNumber: string | null;
  /** An open invoice brought in at go-live (annex C rule 15). */
  isOpening: boolean;
  /** Opening items: the invoice's number in the previous system. */
  reference: string | null;
  currency: CurrencyCode;
  invoiceDate: string;
  dueDate: string;
  status: InvoiceStatus;
  total: DecimalString;
  paidAmount: DecimalString;
  /** Approved credit notes. */
  creditedAmount: DecimalString;
  /** Total less payments and credit notes. */
  balance: DecimalString;
  /** PAID once payments and credit notes cover the total. */
  paymentStatus: PaymentStatus;
}

export interface InvoicePaymentDto {
  receiptId: string;
  receiptNumber: string;
  receiptDate: string;
  amount: DecimalString;
  cancelled: boolean;
}

export interface CustomerInvoiceDto extends CustomerInvoiceSummaryDto {
  fxRate: FxRateString;
  totalUsd: DecimalString;
  notes: string | null;
  lines: CustomerInvoiceLineDto[];
  payments: InvoicePaymentDto[];
  creditNotes: InvoiceCreditNoteDto[];
  journalEntryId: string | null;
  journalEntryNumber: string | null;
  approvedAt: string | null;
  cancelReason: string | null;
  actions: {
    canEdit: boolean;
    canApprove: boolean;
    canCancel: boolean;
    /** Approved with a balance left, and the user may create credit notes. */
    canCreditNote: boolean;
  };
}

export interface InvoiceCreditNoteDto {
  creditNoteId: string;
  number: string | null;
  creditDate: string;
  amount: DecimalString;
  status: CreditNoteStatus;
}

export interface CustomerInvoiceInput {
  currency: CurrencyCode;
  /** Omitted: the rate table's rate for the invoice date. Ignored for USD. */
  fxRate?: FxRateString | null;
  invoiceDate: string;
  dueDate: string;
  notes?: string | null;
  lines: CustomerInvoiceLineInput[];
}

/** A draft for the shipment, prefilled from its quotation when it has one. */
export interface CreateCustomerInvoiceRequest {
  shipmentId: string;
}

export interface ReceiptAllocationDto {
  invoiceId: string;
  invoiceNumber: string;
  amount: DecimalString;
  relievedUsd: DecimalString;
}

export interface ReceiptSummaryDto {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  customerName: string;
  receiptDate: string;
  currency: CurrencyCode;
  amount: DecimalString;
  allocated: DecimalString;
  /** Held as a customer advance. */
  unallocated: DecimalString;
  status: ReceiptStatus;
}

export interface ReceiptDto extends ReceiptSummaryDto {
  fxRate: FxRateString;
  cashAccountId: string;
  cashAccountCode: string;
  cashAccountNameEn: string;
  cashAccountNameAr: string;
  reference: string | null;
  notes: string | null;
  allocations: ReceiptAllocationDto[];
  journalEntryId: string;
  journalEntryNumber: string;
  cancelJournalEntryId: string | null;
  cancelJournalEntryNumber: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  actions: { canCancel: boolean };
}

export interface CreateReceiptRequest {
  customerId: string;
  receiptDate: string;
  currency: CurrencyCode;
  fxRate?: FxRateString | null;
  amount: DecimalString;
  cashAccountId: string;
  reference?: string | null;
  notes?: string | null;
  /** Each in the receipt currency, to an approved invoice of the same customer and currency. */
  allocations: { invoiceId: string; amount: DecimalString }[];
}

export interface TrialBalanceRowDto {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  debitUsd: DecimalString;
  creditUsd: DecimalString;
  /** debit - credit: positive is a debit balance. */
  balanceUsd: DecimalString;
}

export interface TrialBalanceDto {
  asOf: string;
  branchId: string | null;
  rows: TrialBalanceRowDto[];
  totalDebitUsd: DecimalString;
  totalCreditUsd: DecimalString;
}

// ---------------------------------------------------------------------------------------------
// Customer statement of account (annex D printout 12)
// ---------------------------------------------------------------------------------------------

/**
 * What a statement line is: an approved invoice, a receipt, a receipt's cancellation (its
 * reversing entry), a credit note, an open invoice brought in at go-live, another reversal, or any
 * other posted entry on the customer's accounts.
 */
export const STATEMENT_LINE_KINDS = [
  'INVOICE',
  'RECEIPT',
  'RECEIPT_CANCELLATION',
  'CREDIT_NOTE',
  'OPENING_BALANCE',
  'REVERSAL',
  'OTHER',
] as const;
export type StatementLineKind = (typeof STATEMENT_LINE_KINDS)[number];

/** One posted entry on the customer's receivable and advance accounts, in one currency. */
export interface CustomerStatementLineDto {
  /**
   * The journal entry. Null, with `detailsHidden`, for an entry with no invoice or receipt behind
   * it (a manual entry or its reversal) when the user may not view journal entries.
   */
  entryId: string | null;
  entryNumber: string | null;
  date: DateString;
  kind: StatementLineKind;
  /**
   * The invoice, receipt, credit note or opening item the entry came from (or that it reversed),
   * when there is one.
   */
  documentId: string | null;
  documentNumber: string | null;
  /** The entry's description, or a fixed generic one when `detailsHidden`. */
  description: string;
  /** The entry's number, id and text are withheld; its amounts are shown. */
  detailsHidden: boolean;
  debit: DecimalString;
  credit: DecimalString;
  /** Running balance after this line: debit - credit, positive when the customer owes. */
  balance: DecimalString;
}

/** The statement in one currency: amounts are in that currency. */
export interface CustomerStatementSectionDto {
  currency: CurrencyCode;
  /** Balance of the posted lines dated before `from`. */
  openingBalance: DecimalString;
  totalDebit: DecimalString;
  totalCredit: DecimalString;
  closingBalance: DecimalString;
  /** USD carrying value of the closing balance. */
  closingBalanceUsd: DecimalString;
  lines: CustomerStatementLineDto[];
}

/** GET /customer-statements/:customerId?from&to[&branchId]. */
export interface CustomerStatementDto {
  customerId: string;
  customerNumber: string;
  customerName: string;
  customerBranchId: string;
  branchId: string | null;
  from: DateString;
  to: DateString;
  /** One per currency the customer dealt in, by currency code. */
  sections: CustomerStatementSectionDto[];
}

// ---- Credit notes (annex C rule 6) -------------------------------------------------------------

export const CREDIT_NOTE_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

export interface CreditNoteSummaryDto {
  id: string;
  number: string | null;
  branchId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  creditDate: string;
  /** The invoice's currency. */
  currency: CurrencyCode;
  amount: DecimalString;
  status: CreditNoteStatus;
}

export interface CreditNoteDto extends CreditNoteSummaryDto {
  /** The invoice's rate, which the credit note posts at. */
  fxRate: FxRateString;
  /** USD carrying value of the invoice it cleared; set on approval. */
  amountUsd: DecimalString | null;
  reason: string;
  /** What the invoice still has open (total less payments and approved credit notes). */
  invoiceBalance: DecimalString;
  journalEntryId: string | null;
  journalEntryNumber: string | null;
  approvedAt: string | null;
  cancelReason: string | null;
  actions: { canEdit: boolean; canApprove: boolean; canCancel: boolean };
}

export interface CreditNoteInput {
  creditDate: string;
  /** In the invoice currency, at most its open amount. */
  amount: DecimalString;
  reason: string;
}

export interface CreateCreditNoteRequest extends CreditNoteInput {
  /** Client-generated UUID: a retry of the same request returns the first draft. */
  requestId: string;
  invoiceId: string;
}

// ---- Opening balances (annex C rule 15) --------------------------------------------------------

/**
 * Opening balances of general ledger accounts at go-live, in one entry: each line a debit or a
 * credit; the difference goes to the OPENING_EQUITY account. Receivable, payable and advances
 * accounts are not entered here: their balances come from the customers' and suppliers' open
 * items, which also post against opening equity.
 */
export interface OpeningAccountsRequest {
  requestId: string;
  branchId: string;
  entryDate: string;
  description?: string | null;
  lines: ManualJournalLineInput[];
}

/** A customer's open invoice at go-live. It is approved and posted when recorded. */
export interface OpeningCustomerItemRequest {
  requestId: string;
  customerId: string;
  /** The day the opening balances are entered (the journal date). */
  entryDate: string;
  /** The invoice's own number and dates in the previous system. */
  reference: string;
  invoiceDate: string;
  dueDate: string;
  currency: CurrencyCode;
  fxRate?: FxRateString | null;
  /** Still open, in `currency`. */
  amount: DecimalString;
}
