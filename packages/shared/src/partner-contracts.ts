import type { RateUnit } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';

/**
 * A partner's commission contract (business model plan 3.4): settings only in batch 1. It is read
 * for the expected commission inside a rate card's expected margin; nothing accrues, posts or
 * settles from it. An approved contract is never edited: it is cancelled and a new one is made.
 */
export const COMMISSION_BASES = ['PERCENT_OF_PRICE', 'FIXED_PER_UNIT'] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

export const PARTNER_CONTRACT_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type PartnerContractStatus = (typeof PARTNER_CONTRACT_STATUSES)[number];

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
  notes?: string | null;
}
