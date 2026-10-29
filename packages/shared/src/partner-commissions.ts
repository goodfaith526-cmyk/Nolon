import type { CurrencyCode, DecimalString } from './currencies.js';

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
}

/** A partner's commissions in the user's branches, newest rows first (at most 200). */
export interface PartnerCommissionsDto {
  partnerId: string;
  balances: CommissionBalanceDto[];
  rows: CommissionRowDto[];
  holds: CommissionHoldDto[];
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
