import type { DateString } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';

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
  actions: CustomsActionsDto;
}

/** PUT /shipments/:id/customs: the whole customs file. */
export interface CustomsClearanceRequest {
  status: CustomsStatus;
  declarationNumber?: string | null;
  brokerName?: string | null;
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
