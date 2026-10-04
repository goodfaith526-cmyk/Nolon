import type { AccountType, JournalSource, ReceiptStatus } from './accounting.js';
import type { CurrencyCode, DecimalString } from './currencies.js';

/**
 * Financial reports (annex D section 4). Every figure comes from POSTED journal entries (or from
 * approved invoices and posted receipts, whose entries are posted with them), in the user's
 * branches, in USD (BASE_CURRENCY) unless a field names another currency. Amounts are decimal
 * strings. Each report is also exported to Excel (.xlsx) by the same path with `/export`.
 */

/** The reports, as they appear in the API path (`/reports/<id>`) and in the web app. */
export const FINANCIAL_REPORTS = [
  'income-statement',
  'balance-sheet',
  'general-ledger',
  'ar-aging',
  'ap-aging',
  'shipment-profitability',
  'invoices-receipts',
  'cash-movement',
  'open-accruals',
] as const;
export type FinancialReport = (typeof FINANCIAL_REPORTS)[number];

export interface ReportBranchDto {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
}

export interface ReportAccountDto {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
}

/** An account the report filters offer (postable accounts of the chart). */
export interface ReportAccountOptionDto extends ReportAccountDto {
  type: AccountType;
  isCash: boolean;
  isActive: boolean;
}

/** One amount per branch of `branches`, in the same order, and their total. */
export interface BranchAmountsDto {
  byBranch: DecimalString[];
  total: DecimalString;
}

// ---- 1. Income statement ----------------------------------------------------------------------

export interface IncomeStatementRowDto extends ReportAccountDto, BranchAmountsDto {
  type: Extract<AccountType, 'REVENUE' | 'EXPENSE'>;
}

/**
 * Revenue (credit - debit) and expenses (debit - credit) of the period, per account and branch.
 * `branches` lists the branches reported (one, or every branch of the user).
 */
export interface IncomeStatementDto {
  from: string;
  to: string;
  branchId: string | null;
  branches: ReportBranchDto[];
  revenue: IncomeStatementRowDto[];
  expenses: IncomeStatementRowDto[];
  totalRevenue: BranchAmountsDto;
  totalExpenses: BranchAmountsDto;
  /** Revenue - expenses. */
  netIncome: BranchAmountsDto;
}

// ---- 2. Balance sheet -------------------------------------------------------------------------

export interface BalanceSheetRowDto extends ReportAccountDto {
  /** In the account's natural sign: assets debit - credit, liabilities and equity credit - debit. */
  balanceUsd: DecimalString;
}

export interface BalanceSheetDto {
  asOf: string;
  branchId: string | null;
  assets: BalanceSheetRowDto[];
  liabilities: BalanceSheetRowDto[];
  equity: BalanceSheetRowDto[];
  /** Revenue - expenses of every posted entry up to the date: profit not yet closed to equity. */
  unclosedEarningsUsd: DecimalString;
  totalAssetsUsd: DecimalString;
  totalLiabilitiesUsd: DecimalString;
  /** Equity accounts plus the unclosed earnings. */
  totalEquityUsd: DecimalString;
  totalLiabilitiesAndEquityUsd: DecimalString;
  /** Assets = liabilities + equity. */
  balanced: boolean;
}

// ---- 3. General ledger ------------------------------------------------------------------------

export interface LedgerLineDto {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  source: JournalSource;
  description: string;
  branchCode: string;
  currency: CurrencyCode;
  debit: DecimalString;
  credit: DecimalString;
  debitUsd: DecimalString;
  creditUsd: DecimalString;
  /** Running balance after this line, debit - credit, from the opening balance. */
  balanceUsd: DecimalString;
}

export interface LedgerAccountDto extends ReportAccountDto {
  type: AccountType;
  /** Debit - credit of every posted line before `from`. */
  openingUsd: DecimalString;
  lines: LedgerLineDto[];
  totalDebitUsd: DecimalString;
  totalCreditUsd: DecimalString;
  closingUsd: DecimalString;
}

export interface GeneralLedgerDto {
  from: string;
  to: string;
  branchId: string | null;
  accounts: LedgerAccountDto[];
}

/** At most this many accounts in one general ledger request. */
export const LEDGER_MAX_ACCOUNTS = 20;

// ---- 4. AR aging ------------------------------------------------------------------------------

/** Days past the due date: not yet due (or due today), 1-30, 31-60, 61-90, over 90. */
export const AGING_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export type AgingAmountsDto = Record<AgingBucket | 'total', DecimalString>;

export interface ArAgingInvoiceDto {
  invoiceId: string;
  number: string;
  branchCode: string;
  customerId: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  currency: CurrencyCode;
  total: DecimalString;
  /** In the invoice currency: total less the receipts allocated to it up to the date. */
  outstanding: DecimalString;
  /** USD carrying value still open: total USD less the USD the allocations relieved. */
  outstandingUsd: DecimalString;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface ArAgingCustomerDto {
  customerId: string;
  customerName: string;
  amounts: AgingAmountsDto;
  /** Unapplied advances (receipts not allocated to an invoice), USD, as of the date. */
  advancesUsd: DecimalString;
  /** Open invoices less advances. */
  netUsd: DecimalString;
}

/** Open approved invoices as of a date, per customer and bucket, in USD. */
export interface ArAgingDto {
  asOf: string;
  branchId: string | null;
  customerId: string | null;
  customers: ArAgingCustomerDto[];
  invoices: ArAgingInvoiceDto[];
  totals: AgingAmountsDto;
  totalAdvancesUsd: DecimalString;
  netUsd: DecimalString;
}

// ---- 6. AP aging -------------------------------------------------------------------------------

export interface ApAgingBillDto {
  billId: string;
  number: string;
  supplierReference: string | null;
  branchCode: string;
  supplierId: string;
  supplierName: string;
  billDate: string;
  dueDate: string;
  currency: CurrencyCode;
  total: DecimalString;
  /** In the bill currency: total less the payments allocated to it up to the date. */
  outstanding: DecimalString;
  /** USD carrying value still open. */
  outstandingUsd: DecimalString;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface ApAgingSupplierDto {
  supplierId: string;
  supplierName: string;
  amounts: AgingAmountsDto;
}

/** Open approved supplier bills as of a date, per supplier and bucket, in USD. */
export interface ApAgingDto {
  asOf: string;
  branchId: string | null;
  supplierId: string | null;
  suppliers: ApAgingSupplierDto[];
  bills: ApAgingBillDto[];
  totals: AgingAmountsDto;
}

// ---- 5. Shipment profitability ----------------------------------------------------------------

export interface ProfitFiguresDto {
  /** Revenue accounts, credit - debit, of lines carrying the shipment. */
  revenueUsd: DecimalString;
  /** Expense accounts, debit - credit, of lines carrying the shipment. */
  costUsd: DecimalString;
  marginUsd: DecimalString;
  /** Margin / revenue x 100, to 2 places; null when there is no revenue. */
  marginPercent: DecimalString | null;
}

export interface ReportLocationDto {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
}

export interface ShipmentProfitDto extends ProfitFiguresDto {
  shipmentId: string;
  number: string;
  branchCode: string;
  customerId: string;
  customerName: string;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
}

export interface CustomerProfitDto extends ProfitFiguresDto {
  customerId: string;
  customerName: string;
  shipments: number;
}

export interface RouteProfitDto extends ProfitFiguresDto {
  origin: ReportLocationDto;
  destination: ReportLocationDto;
  shipments: number;
}

export interface ShipmentProfitabilityDto {
  from: string;
  to: string;
  branchId: string | null;
  customerId: string | null;
  shipments: ShipmentProfitDto[];
  customers: CustomerProfitDto[];
  routes: RouteProfitDto[];
  totals: ProfitFiguresDto;
}

// ---- 6. Invoices and receipts -----------------------------------------------------------------

export interface PeriodInvoiceDto {
  invoiceId: string;
  number: string;
  invoiceDate: string;
  dueDate: string;
  branchCode: string;
  customerId: string;
  customerName: string;
  shipmentNumber: string;
  currency: CurrencyCode;
  total: DecimalString;
  totalUsd: DecimalString;
}

export interface PeriodReceiptDto {
  receiptId: string;
  number: string;
  receiptDate: string;
  branchCode: string;
  customerId: string;
  customerName: string;
  currency: CurrencyCode;
  amount: DecimalString;
  amountUsd: DecimalString;
  cashAccountCode: string;
  status: ReceiptStatus;
}

export interface InvoicesReceiptsDto {
  from: string;
  to: string;
  branchId: string | null;
  customerId: string | null;
  invoices: PeriodInvoiceDto[];
  receipts: PeriodReceiptDto[];
  totalInvoicedUsd: DecimalString;
  /** Receipts not cancelled. */
  totalReceivedUsd: DecimalString;
}

// ---- 7. Cash and bank movement ----------------------------------------------------------------

export interface CashAccountMovementDto extends ReportAccountDto {
  currency: CurrencyCode | null;
  /** In the account's currency. */
  opening: DecimalString;
  inflow: DecimalString;
  outflow: DecimalString;
  closing: DecimalString;
  openingUsd: DecimalString;
  inflowUsd: DecimalString;
  outflowUsd: DecimalString;
  closingUsd: DecimalString;
}

export interface FxDifferenceLineDto {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  branchCode: string;
  /** Positive: a gain; negative: a loss. */
  amountUsd: DecimalString;
}

export interface CashMovementDto {
  from: string;
  to: string;
  branchId: string | null;
  accounts: CashAccountMovementDto[];
  totals: {
    openingUsd: DecimalString;
    inflowUsd: DecimalString;
    outflowUsd: DecimalString;
    closingUsd: DecimalString;
  };
  /** Realized exchange differences of the period (FX_GAIN and FX_LOSS accounts). */
  fx: {
    gainUsd: DecimalString;
    lossUsd: DecimalString;
    /** Gain - loss. */
    netUsd: DecimalString;
    lines: FxDifferenceLineDto[];
  };
}

// ---- 8. Open accruals -------------------------------------------------------------------------

export interface AccrualTripDto {
  tripId: string;
  tripNumber: string;
  branchCode: string;
  carrierName: string | null;
  completedAt: string | null;
  currency: CurrencyCode;
  /** Still accrued, in the trip currency (credit - debit). */
  balance: DecimalString;
  balanceUsd: DecimalString;
}

export interface OpenAccrualsDto {
  asOf: string;
  branchId: string | null;
  /** The ACCRUED_TRANSPORT account, or null when the role is not mapped. */
  accruedAccount: ReportAccountDto | null;
  trips: AccrualTripDto[];
  /** The trips' accrued balances added up. */
  tripsTotalUsd: DecimalString;
  /** What else sits on the accrued transport account mapped today (manual entries). */
  otherAccruedUsd: DecimalString;
  /** The trips' accruals plus the other accrued balance. */
  accruedTotalUsd: DecimalString;
  /** The CONSOLIDATION_CLEARING account, or null when the role is not mapped. */
  clearingAccount: ReportAccountDto | null;
  /** Debit - credit of the consolidation clearing account. */
  clearingBalanceUsd: DecimalString;
}
