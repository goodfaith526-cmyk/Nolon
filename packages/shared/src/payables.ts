import type { FxRateString } from './accounting.js';
import type { CurrencyCode, DecimalString } from './currencies.js';

/**
 * Payables (scope 13, annex C rules 7, 9, 11a and 12): suppliers, their bills and the payments made
 * to them. Suppliers are master data shared by all branches; bills and payments belong to one
 * branch. Amounts are decimal strings in the document currency unless a field says USD.
 */

export interface SupplierSummaryDto {
  id: string;
  number: string;
  name: string;
  phone: string | null;
  isActive: boolean;
}

export interface SupplierDto extends SupplierSummaryDto {
  email: string | null;
  taxNumber: string | null;
  paymentTermsDays: number;
  notes: string | null;
  /** Carriers whose trips this supplier bills (rule 11a). */
  carriers: { id: string; name: string }[];
  actions: { canEdit: boolean };
}

export interface SupplierInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  taxNumber?: string | null;
  paymentTermsDays?: number;
  notes?: string | null;
}

export interface SupplierUpdateRequest extends Partial<SupplierInput> {
  isActive?: boolean;
}

export const SUPPLIER_BILL_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type SupplierBillStatus = (typeof SUPPLIER_BILL_STATUSES)[number];

/**
 * SHIPMENT_COST: a cost of one shipment by charge type (rule 7, reimbursable charges rule 8).
 * TRIP: a carrier's charge for a completed external trip; it clears the trip's accrual (rule 11a).
 * EXPENSE: a general expense by category (rule 12).
 * CONSOLIDATION: a container's cost, shared out when the container closes (rules 7a and 13).
 * COMMISSION: a partner statement's line (plan 07, rule 16a), written only by the statement's own
 * route, never entered on a bill (F152-1).
 */
export const SUPPLIER_BILL_LINE_KINDS = [
  'SHIPMENT_COST',
  'TRIP',
  'EXPENSE',
  'CONSOLIDATION',
  'COMMISSION',
] as const;
export type SupplierBillLineKind = (typeof SUPPLIER_BILL_LINE_KINDS)[number];

/** The kinds a person enters on a supplier bill: every kind but COMMISSION. */
export const ENTERED_BILL_LINE_KINDS = [
  'SHIPMENT_COST',
  'TRIP',
  'EXPENSE',
  'CONSOLIDATION',
] as const satisfies readonly SupplierBillLineKind[];
export type EnteredBillLineKind = (typeof ENTERED_BILL_LINE_KINDS)[number];

export interface SupplierBillLineInput {
  kind: EnteredBillLineKind;
  chargeTypeCode?: string | null;
  shipmentId?: string | null;
  tripId?: string | null;
  expenseCategoryCode?: string | null;
  /** A container cost (CONSOLIDATION): the container; with chargeTypeCode. */
  consolidationId?: string | null;
  description?: string | null;
  /** In the bill currency. */
  amount: DecimalString;
}

export interface SupplierBillLineDto {
  lineNo: number;
  kind: SupplierBillLineKind;
  chargeTypeCode: string | null;
  shipmentId: string | null;
  shipmentNumber: string | null;
  tripId: string | null;
  tripNumber: string | null;
  expenseCategoryCode: string | null;
  consolidationId: string | null;
  consolidationNumber: string | null;
  description: string | null;
  amount: DecimalString;
}

export interface SupplierBillSummaryDto {
  id: string;
  number: string | null;
  branchId: string;
  supplierId: string;
  supplierName: string;
  supplierReference: string | null;
  /** An open bill brought in at go-live (rule 15). */
  isOpening: boolean;
  currency: CurrencyCode;
  billDate: string;
  dueDate: string;
  status: SupplierBillStatus;
  total: DecimalString;
  paidAmount: DecimalString;
  balance: DecimalString;
}

export interface SupplierBillPaymentDto {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  amount: DecimalString;
  cancelled: boolean;
}

/** Another bill of the supplier, in the same branch, carrying the same supplier reference. */
export interface SupplierBillRefDto {
  id: string;
  number: string | null;
  status: SupplierBillStatus;
  billDate: string;
  currency: CurrencyCode;
  total: DecimalString;
}

/**
 * The most bill ids an approval may acknowledge. A reference on more bills that are not cancelled
 * takes no further approval until some are cancelled.
 */
export const MAX_ACKNOWLEDGED_BILLS = 1000;

export interface ApproveSupplierBillRequest {
  /**
   * The bills carrying the same supplier reference that the person checked (`duplicateBills`).
   * The approval is refused (409 `SUPPLIER_REFERENCE_DUPLICATE`) unless these are exactly the
   * bills that carry it now; omitted, the reference must be on no other bill (B1-4).
   */
  acknowledgedDuplicateBillIds?: string[];
}

export interface SupplierBillDto extends SupplierBillSummaryDto {
  fxRate: FxRateString;
  /**
   * The rate the user entered on the document, which it keeps; null when the rate is the FX
   * table's for the document's date (an edit then sends none, and the table's rate applies).
   */
  enteredFxRate: FxRateString | null;
  totalUsd: DecimalString;
  notes: string | null;
  lines: SupplierBillLineDto[];
  payments: SupplierBillPaymentDto[];
  journalEntryId: string | null;
  journalEntryNumber: string | null;
  cancelJournalEntryId: string | null;
  cancelJournalEntryNumber: string | null;
  approvedAt: string | null;
  cancelReason: string | null;
  /**
   * The supplier's other bills in the same branch with the same reference (any case), not
   * cancelled: a possible double entry of one supplier invoice. Empty without a reference.
   */
  duplicateBills: SupplierBillRefDto[];
  actions: { canEdit: boolean; canApprove: boolean; canCancel: boolean };
}

export interface SupplierBillInput {
  branchId: string;
  supplierReference?: string | null;
  currency: CurrencyCode;
  /** Omitted: the rate table's rate for the bill date. Ignored for USD. */
  fxRate?: FxRateString | null;
  billDate: string;
  /**
   * On an edit, omitted or null: the bill date plus the supplier's payment terms
   * (`paymentTermsDays`), generated by the API when the draft is saved (functional review C1).
   * Required on create (see `CreateSupplierBillRequest`).
   */
  dueDate?: string | null;
  notes?: string | null;
  lines: SupplierBillLineInput[];
}

export interface CreateSupplierBillRequest extends Omit<SupplierBillInput, 'dueDate'> {
  /** Client-generated UUID: a retry of the same request returns the first draft. */
  requestId: string;
  supplierId: string;
  /**
   * Always sent on create, so a retry under the same `requestId` is compared with what the first
   * request asked for, never with terms that changed since (Codex F94-3).
   * `GET /supplier-bills/due-date` suggests it from the supplier's terms.
   */
  dueDate: string;
}

/** `GET /supplier-bills/due-date`: the bill date plus the supplier's payment terms (C1). */
export interface SupplierBillDueDateDto {
  supplierId: string;
  billDate: string;
  paymentTermsDays: number;
  dueDate: string;
}

/** A supplier's open bill at go-live; approved and posted when recorded. */
export interface OpeningSupplierItemRequest {
  requestId: string;
  supplierId: string;
  branchId: string;
  /** The day the opening balances are entered (the journal date). */
  entryDate: string;
  /** The bill's own number and dates. */
  reference: string;
  billDate: string;
  dueDate: string;
  currency: CurrencyCode;
  fxRate?: FxRateString | null;
  /** Still open, in `currency`. */
  amount: DecimalString;
}

/** A completed external trip of a carrier linked to the supplier, whose accrual is still open. */
export interface BillableTripDto {
  tripId: string;
  tripNumber: string;
  branchId: string;
  carrierName: string;
  completedOn: string | null;
  currency: CurrencyCode;
  /** The accrued (agreed) cost. */
  agreedCost: DecimalString;
}

export const SUPPLIER_PAYMENT_STATUSES = ['POSTED', 'CANCELLED'] as const;
export type SupplierPaymentStatus = (typeof SUPPLIER_PAYMENT_STATUSES)[number];

export interface SupplierPaymentSummaryDto {
  id: string;
  number: string;
  branchId: string;
  supplierId: string;
  supplierName: string;
  paymentDate: string;
  currency: CurrencyCode;
  amount: DecimalString;
  status: SupplierPaymentStatus;
}

export interface SupplierPaymentAllocationDto {
  billId: string;
  billNumber: string;
  amount: DecimalString;
  relievedUsd: DecimalString;
}

export interface SupplierPaymentDto extends SupplierPaymentSummaryDto {
  fxRate: FxRateString;
  cashAccountId: string;
  cashAccountCode: string;
  cashAccountNameEn: string;
  cashAccountNameAr: string;
  reference: string | null;
  notes: string | null;
  allocations: SupplierPaymentAllocationDto[];
  journalEntryId: string;
  journalEntryNumber: string;
  cancelJournalEntryId: string | null;
  cancelJournalEntryNumber: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  actions: { canCancel: boolean };
}

/**
 * A payment from a cash or bank account, allocated in full to approved bills of the supplier in
 * one branch and in the payment's currency. The amount is the sum of the allocations.
 */
export interface CreateSupplierPaymentRequest {
  /** Client-generated UUID: a retry of the same request returns the first payment. */
  requestId: string;
  supplierId: string;
  branchId: string;
  paymentDate: string;
  currency: CurrencyCode;
  fxRate?: FxRateString | null;
  cashAccountId: string;
  reference?: string | null;
  notes?: string | null;
  allocations: { billId: string; amount: DecimalString }[];
}
