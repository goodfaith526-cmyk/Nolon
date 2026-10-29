import type { CommissionBasis, CommissionEvent } from './partner-contracts.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type { SupplierBillStatus } from './payables.js';

/** A partner's place on a shipment that earns a commission (plan 07, 3.2). */
export const COMMISSION_ROLES = ['SALES_OUTLET', 'ORIGIN_CONSOLIDATOR', 'DISTRIBUTOR'] as const;
export type CommissionRole = (typeof COMMISSION_ROLES)[number];

/**
 * ACCRUAL: a slot's first row. ADJUSTMENT: a later change. REVERSAL: back to zero (the event undone,
 * the shipment cancelled, the partner taken off). MANUAL: entered by a person, with a reason.
 */
export const COMMISSION_ACCRUAL_KINDS = ['ACCRUAL', 'ADJUSTMENT', 'REVERSAL', 'MANUAL'] as const;
export type CommissionAccrualKind = (typeof COMMISSION_ACCRUAL_KINDS)[number];

/** Why a commission could not be computed (plan 07, 4.5). The write that asked still succeeds. */
export const COMMISSION_HOLD_CODES = [
  /** Lines of more than one price category (or one without), and no contract for every category. */
  'COMMISSION_MIXED_CATEGORIES',
  /** A fixed amount in a currency with no exchange rate on the event's day. */
  'COMMISSION_NO_FX_RATE',
  /** The contract's unit cannot be counted exactly on the shipment's cargo lines. */
  'COMMISSION_UNIT_UNKNOWN',
  /** Two approved contracts, on different events, both apply. */
  'COMMISSION_CONTRACT_AMBIGUOUS',
  /** The change rounds to 0.00 USD: nothing can be posted yet. */
  'COMMISSION_TOO_SMALL',
] as const;
export type CommissionHoldCode = (typeof COMMISSION_HOLD_CODES)[number];

export interface CommissionRowDto {
  id: string;
  shipmentId: string;
  shipmentNumber: string;
  branchCode: string;
  role: CommissionRole;
  kind: CommissionAccrualKind;
  currency: CurrencyCode;
  /** Positive accrues, negative reduces. */
  amount: DecimalString;
  amountUsd: DecimalString;
  /** Percentages: the base it was computed on. */
  base: DecimalString | null;
  /** Fixed amounts: the quantity in the contract's unit. */
  quantity: DecimalString | null;
  entryNumber: string;
  /** Null while open. */
  statementId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface CommissionHoldDto {
  shipmentId: string;
  shipmentNumber: string;
  role: CommissionRole;
  code: CommissionHoldCode;
  detail: string | null;
  updatedAt: string;
  /** The user may compute it again in the shipment's branch. */
  canRecompute: boolean;
}

/** What is open for the partner in one branch and currency: the rows not in a statement yet. */
export interface CommissionBalanceDto {
  branchId: string;
  branchCode: string;
  currency: CurrencyCode;
  open: DecimalString;
  openUsd: DecimalString;
  /** The user may make a statement of these rows (plan 07, 5.1). */
  canStatement: boolean;
}

/** A partner's commissions in the user's branches, newest rows first (at most 200). */
export interface PartnerCommissionsDto {
  partnerId: string;
  balances: CommissionBalanceDto[];
  rows: CommissionRowDto[];
  holds: CommissionHoldDto[];
  /** The partner's statements in the user's branches, newest first. */
  statements: PartnerStatementSummaryDto[];
  /** The user may enter a manual adjustment in at least one of these branches. */
  canAdjust: boolean;
}

/** A manual adjustment (plan 07, 4.6): on a shipment the partner holds `role` on. */
export interface ManualCommissionInput {
  shipmentId: string;
  role: CommissionRole;
  currency: CurrencyCode;
  /** Positive accrues, negative reduces; not zero. */
  amount: DecimalString;
  reason: string;
}

/**
 * DRAFT: its rows are taken. BILLED: its supplier bill is a draft or waits for approval. SETTLED:
 * the bill was approved (rule 16a). CANCELLED: its rows were released.
 */
export const PARTNER_STATEMENT_STATUSES = ['DRAFT', 'BILLED', 'SETTLED', 'CANCELLED'] as const;
export type PartnerStatementStatus = (typeof PARTNER_STATEMENT_STATUSES)[number];

/** A partner's open rows of one branch and currency up to a day (plan 07, 5.1). */
export interface CreatePartnerStatementInput {
  branchId: string;
  currency: CurrencyCode;
  /** The last entry date taken, YYYY-MM-DD. */
  periodTo: string;
}

/** The supplier bill made from a statement (plan 07, 5.2). `requestId` makes a retry safe. */
export interface PartnerStatementBillInput {
  requestId: string;
  billDate: string;
  /** Else the bill date plus the supplier's payment terms. */
  dueDate?: string;
  /** The partner's own invoice number, if it sent one. */
  supplierReference?: string;
}

export interface PartnerStatementSummaryDto {
  id: string;
  number: string;
  partnerId: string;
  branchId: string;
  branchCode: string;
  currency: CurrencyCode;
  periodTo: string;
  total: DecimalString;
  totalUsd: DecimalString;
  status: PartnerStatementStatus;
  billId: string | null;
  billNumber: string | null;
  billStatus: SupplierBillStatus | null;
  createdAt: string;
}

/** One row of a statement: a commission row it settles. */
export interface PartnerStatementLineDto {
  shipmentId: string;
  shipmentNumber: string;
  role: CommissionRole;
  kind: CommissionAccrualKind;
  /** The day of its entry. */
  date: string;
  /** The contract's event, basis and value; null for a manual row. */
  event: CommissionEvent | null;
  basis: CommissionBasis | null;
  value: DecimalString | null;
  base: DecimalString | null;
  quantity: DecimalString | null;
  amount: DecimalString;
  amountUsd: DecimalString;
  reason: string | null;
}

export interface PartnerStatementDto extends PartnerStatementSummaryDto {
  partnerNumber: string;
  partnerName: string;
  lines: PartnerStatementLineDto[];
  actions: {
    /** Make its supplier bill (a DRAFT statement). */
    canBill: boolean;
    /** Cancel it (a DRAFT statement; a BILLED one after its bill is cancelled). */
    canCancel: boolean;
  };
}

/** Report z4 (plan 07, 7): the commissions not settled yet, by partner, branch and currency. */
export interface CommissionsDueRowDto {
  partnerId: string;
  partnerNumber: string;
  partnerName: string;
  branchId: string;
  branchCode: string;
  currency: CurrencyCode;
  /** Not in a statement yet. */
  open: DecimalString;
  /** In a statement whose bill is not approved yet. */
  inStatement: DecimalString;
  /** open + inStatement, in the currency and in USD. */
  unsettled: DecimalString;
  unsettledUsd: DecimalString;
  /** The unsettled amount by the age of its entry, in days: 0-30, 31-60, 61-90, over 90. */
  ages: [DecimalString, DecimalString, DecimalString, DecimalString];
  /** The partner owes NOLON on balance (plan 07, 5.4). */
  owesNolon: boolean;
  /** The partner's commissions that could not be computed, in this branch. */
  holds: number;
}

export interface CommissionsDueDto {
  asOf: string;
  rows: CommissionsDueRowDto[];
  /** Per branch: the sub-ledger in USD and the accrued commissions account, which match. */
  branches: {
    branchId: string;
    branchCode: string;
    subLedgerUsd: DecimalString;
    ledgerUsd: DecimalString;
    matches: boolean;
  }[];
}
