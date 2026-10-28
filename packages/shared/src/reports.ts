import type { AccountType, JournalSource, ReceiptStatus } from './accounting.js';
import type { BookingService, RateUnit } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type { ExpectedMarginDto } from './rate-costs.js';

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

/**
 * Why a shipment's actual profit may not be final yet (business model plan 6.2): a booked service
 * without any cost recorded for it (`missingCosts` names them), a transport accrual still open on
 * one of its trips, or not closed yet.
 */
export const PROFIT_INCOMPLETE_REASONS = ['MISSING_COST', 'OPEN_ACCRUAL', 'NOT_CLOSED'] as const;
export type ProfitIncompleteReason = (typeof PROFIT_INCOMPLETE_REASONS)[number];

/**
 * The price category a shipment's profit counts under (plan 6.3, F105-3): the one category of
 * all its lines, MIXED for more than one, UNSPECIFIED when a line has none. Never split.
 */
export type ProfitCategoryDto =
  | { kind: 'SINGLE'; code: string; nameEn: string; nameAr: string }
  | { kind: 'MIXED' }
  | { kind: 'UNSPECIFIED' };

export interface ReportCountryDto {
  /** ISO 3166-1 alpha-2. */
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
  /** The sales outlet it was sold through; null: none. */
  salesOutlet: { id: string; name: string } | null;
  originCountry: ReportCountryDto;
  category: ProfitCategoryDto;
  /** Empty when the figures are final. */
  incompleteReasons: ProfitIncompleteReason[];
  /** The booked services with no cost recorded for them yet (MISSING_COST). */
  missingCosts: BookingService[];
  /** Days from first receipt at origin to proof of delivery, to 1 place; null: not measured. */
  cycleDays: DecimalString | null;
}

/** A group's profit, with how many of its shipments are not final yet. */
export interface ProfitGroupFiguresDto extends ProfitFiguresDto {
  shipments: number;
  incompleteShipments: number;
}

export interface OutletProfitDto extends ProfitGroupFiguresDto {
  /** Null: shipments sold without an outlet ("unspecified"). */
  salesOutlet: { id: string; name: string } | null;
}

export interface CountryProfitDto extends ProfitGroupFiguresDto {
  originCountry: ReportCountryDto;
}

export interface CategoryProfitDto extends ProfitGroupFiguresDto {
  category: ProfitCategoryDto;
  /** A single category's unit (its default unit); null for MIXED and UNSPECIFIED. */
  unit: RateUnit | null;
  /** The group's units in `unit`; null when not every line has the measure. */
  units: DecimalString | null;
  /** Margin per unit; null without units. */
  marginPerUnitUsd: DecimalString | null;
}

/** Days from first receipt at origin to proof of delivery, over the route's measured shipments. */
export interface CycleTimeDto {
  measured: number;
  averageDays: DecimalString | null;
  minDays: DecimalString | null;
  maxDays: DecimalString | null;
}

export interface CustomerProfitDto extends ProfitGroupFiguresDto {
  customerId: string;
  customerName: string;
}

export interface RouteProfitDto extends ProfitGroupFiguresDto {
  origin: ReportLocationDto;
  destination: ReportLocationDto;
  cycle: CycleTimeDto;
}

export interface ShipmentProfitabilityDto {
  from: string;
  to: string;
  branchId: string | null;
  customerId: string | null;
  shipments: ShipmentProfitDto[];
  customers: CustomerProfitDto[];
  routes: RouteProfitDto[];
  outlets: OutletProfitDto[];
  countries: CountryProfitDto[];
  /** Every shipment in exactly one column: the columns add up to `totals` exactly. */
  categories: CategoryProfitDto[];
  totals: ProfitGroupFiguresDto;
}

/** A charge of the shipment's pricing that gives no expected figure, and why (plan 6.2). */
export interface ExpectedGapDto {
  chargeTypeCode: string;
  /** NO_CARD: priced by hand, not from a rate card; QUANTITY_UNKNOWN: the cargo does not give it. */
  reason: 'NO_CARD' | 'QUANTITY_UNKNOWN';
}

/**
 * The shipment's expected margin from the rate cards it is priced from (plan 6.2): its
 * quotation's cards while the quotation still prices it, else the cards its invoice suggestion
 * fills. A planning figure: never moved into the actual one.
 */
export interface ShipmentExpectedDto {
  source: 'QUOTATION' | 'RATE_CARDS';
  /** Each card at the quantity the shipment is priced at, with its own gaps. */
  cards: (ExpectedMarginDto & { chargeTypeCode: string })[];
  gaps: ExpectedGapDto[];
  /** The cards' currency when they share one; null otherwise. */
  currency: CurrencyCode | null;
  /** The sum of the cards' margins; null while any card or charge is incomplete, or currencies differ. */
  expectedMargin: DecimalString | null;
}

/**
 * GET /reports/shipment-profitability/shipments/:id (plan 6.2): the shipment's finance tab, two
 * separate columns. Only a shipment of the user's branches (its owning branch).
 */
export interface ShipmentProfitViewDto {
  shipmentId: string;
  /** From the books: every posted line to date; null while nothing is posted on it. */
  actual: ShipmentProfitDto | null;
  /**
   * From the rate cards; null without rate_costs:view in the shipment's branch (the costs are
   * internal), or for a cancelled shipment.
   */
  expected: ShipmentExpectedDto | null;
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
