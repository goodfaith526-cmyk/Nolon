import type { RateUnit } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type { PartnerKind } from './partners.js';

/**
 * A partner's commission contract (business model plan 3.4). It is read for the expected
 * commission inside a rate card's expected margin, and (plan 07) for the commission accrued on a
 * shipment when its event happens. An approved contract is never edited: it is cancelled and a new
 * one is made.
 */
export const COMMISSION_BASES = ['PERCENT_OF_PRICE', 'FIXED_PER_UNIT'] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

export const PARTNER_CONTRACT_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type PartnerContractStatus = (typeof PARTNER_CONTRACT_STATUSES)[number];

/**
 * When the commission is accrued (plan 07, 3.1): the shipment's first approved invoice, its
 * departure, or a full proof of delivery.
 */
export const COMMISSION_EVENTS = ['INVOICED', 'DEPARTED', 'DELIVERED'] as const;
export type CommissionEvent = (typeof COMMISSION_EVENTS)[number];

/** The event a new contract suggests for a partner of each kind (plan 07, decision 2). */
export const DEFAULT_COMMISSION_EVENT: Readonly<Record<PartnerKind, CommissionEvent>> = {
  SALES_OUTLET: 'INVOICED',
  ORIGIN_CONSOLIDATOR: 'DEPARTED',
  OVERSEAS_AGENT: 'INVOICED',
  DISTRIBUTOR: 'DELIVERED',
};

export interface PartnerContractDto {
  id: string;
  partnerId: string;
  /** Null: every category. A contract of the card's own category beats one for every category. */
  priceCategoryCode: string | null;
  basis: CommissionBasis;
  /** The percentage (7.5 = 7.5%) or the fixed amount per unit. */
  value: DecimalString;
  /** Fixed amounts only; null for a percentage. */
  unit: RateUnit | null;
  currency: CurrencyCode | null;
  validFrom: string;
  validTo: string | null;
  accrualEvent: CommissionEvent;
  notes: string | null;
  status: PartnerContractStatus;
  approvedAt: string | null;
  createdAt: string;
  actions: { canEdit: boolean; canApprove: boolean; canCancel: boolean };
}

export interface PartnerContractInput {
  priceCategoryCode?: string | null;
  basis: CommissionBasis;
  value: DecimalString;
  unit?: RateUnit | null;
  currency?: CurrencyCode | null;
  validFrom: string;
  validTo?: string | null;
  /** Omitted on a create: the default for the partner's kind (DEFAULT_COMMISSION_EVENT). */
  accrualEvent?: CommissionEvent;
  notes?: string | null;
}
