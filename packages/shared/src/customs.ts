import type { Permission } from './auth.js';
import type { DateString } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type { SupplierBillStatus } from './payables.js';

/**
 * Customs (scope 11): one customs file per shipment, inside the shipment page. Fees are recorded
 * with their currency only; they reach the books with the supplier bills (group 4b).
 */

export const CUSTOMS_STATUSES = ['PENDING', 'SUBMITTED', 'INSPECTION', 'HELD', 'CLEARED'] as const;
export type CustomsStatus = (typeof CUSTOMS_STATUSES)[number];

export interface CustomsClearanceDto {
  status: CustomsStatus;
  declarationNumber: string | null;
  brokerName: string | null;
  /** The broker as a supplier (group Z2), when linked: its bills show in costLines. */
  brokerSupplierId: string | null;
  brokerSupplierName: string | null;
  submittedOn: DateString | null;
  clearedOn: DateString | null;
  note: string | null;
  updatedByName: string;
  updatedAt: string;
}

export interface CustomsFeeDto {
  id: string;
  description: string;
  amount: DecimalString;
  currency: CurrencyCode;
  note: string | null;
  createdByName: string;
  createdAt: string;
}

/**
 * Supplier costs are Restricted (annex A "shipment profitability and costs"): only those who see
 * shipment profitability see the broker's bills on the customs file.
 */
export function seesCustomsCosts(has: (permission: Permission) => boolean): boolean {
  return has('shipment_profitability:view');
}

/**
 * A supplier bill line charged to the shipment that is a customs cost (group Z2): its charge is a
 * customs charge, or its bill is from the file's broker. Read only: it is the bill's own line,
 * posted (or not yet, while a draft) with its bill, never a second record of the cost.
 */
export interface CustomsCostLineDto {
  billId: string;
  /** Null while the bill is a draft. */
  billNumber: string | null;
  billStatus: Exclude<SupplierBillStatus, 'CANCELLED'>;
  billDate: DateString;
  supplierName: string;
  supplierReference: string | null;
  /** The bill is from the broker linked to the file. */
  fromBroker: boolean;
  lineNo: number;
  chargeTypeCode: string | null;
  description: string | null;
  amount: DecimalString;
  currency: CurrencyCode;
}

/** A broker the customs file can be linked to: an active supplier. */
export interface CustomsBrokerOptionDto {
  id: string;
  name: string;
}

export interface CustomsActionsDto {
  canEdit: boolean;
  canAddFee: boolean;
  canRemoveFee: boolean;
}

/** GET /shipments/:id/customs. */
export interface ShipmentCustomsDto {
  /** Null until the customs file is first saved. */
  clearance: CustomsClearanceDto | null;
  fees: CustomsFeeDto[];
  /** Fee totals per currency (no conversion). */
  totals: { currency: CurrencyCode; amount: DecimalString }[];
  /** Whether the user sees supplier costs (seesCustomsCosts); costLines and costTotals follow. */
  showsCost: boolean;
  /**
   * The supplier bill lines that are customs costs of this shipment, draft or approved (never
   * cancelled), in the user's branches. Kept apart from fees and totals: a fee is the operational
   * record, a bill line is the supplier's cost, and the two are never added together. Null when
   * showsCost is false.
   */
  costLines: CustomsCostLineDto[] | null;
  /** costLines of approved bills only, per currency (no conversion). Null when showsCost is false. */
  costTotals: { currency: CurrencyCode; amount: DecimalString }[] | null;
  actions: CustomsActionsDto;
}

/** PUT /shipments/:id/customs: the whole customs file. */
export interface CustomsClearanceRequest {
  status: CustomsStatus;
  declarationNumber?: string | null;
  brokerName?: string | null;
  /**
   * An active supplier (GET .../customs/brokers), or null for none. When set and brokerName is
   * empty, the broker name is the supplier's.
   */
  brokerSupplierId?: string | null;
  submittedOn?: DateString | null;
  clearedOn?: DateString | null;
  note?: string | null;
}

export interface CustomsFeeRequest {
  description: string;
  amount: DecimalString;
  currency: CurrencyCode;
  note?: string | null;
}
