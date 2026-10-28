import type { RateUnit } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';

/**
 * A rate card's reference costs and expected margin (business model plan 6.1). A planning figure
 * only ("expected margin, estimated"): never a journal entry or a report figure, and apart from the
 * actual profit read from the books. The outlet's commission is not entered: it comes from the
 * outlet's approved contract (partner-contracts.ts).
 */
export const RATE_COST_COMPONENTS = [
  'ORIGIN_HANDLING',
  'SEA_FREIGHT',
  'DISTRIBUTION',
  'OTHER',
] as const;
export type RateCostComponent = (typeof RATE_COST_COMPONENTS)[number];

export const RATE_COST_STATUSES = ['ENTERED', 'NOT_APPLICABLE'] as const;
export type RateCostStatus = (typeof RATE_COST_STATUSES)[number];

export interface RateCardCostDto {
  component: RateCostComponent;
  status: RateCostStatus;
  amount: DecimalString | null;
  currency: CurrencyCode | null;
  unit: RateUnit | null;
  /** How many of the card's units one cost unit holds, when the cost's unit is not the card's. */
  unitsPerCostUnit: DecimalString | null;
  note: string | null;
  updatedAt: string;
}

/** One component: entered (with amount, currency and unit) or not applicable (with none). */
export type RateCardCostInput =
  | {
      status: 'ENTERED';
      amount: DecimalString;
      currency: CurrencyCode;
      unit: RateUnit;
      unitsPerCostUnit?: DecimalString | null;
      note?: string | null;
    }
  | { status: 'NOT_APPLICABLE'; note?: string | null };

/** The components of the margin: the entered ones and the outlet's commission. */
export type MarginComponent = RateCostComponent | 'OUTLET_COMMISSION';

/**
 * Why a component has no amount, so the margin is incomplete: not entered; its unit is not the
 * card's and nothing converts it; no exchange rate for its currency; no outlet chosen; no approved
 * contract of the outlet covers the card.
 */
export const MARGIN_GAPS = [
  'NOT_ENTERED',
  'UNIT_NOT_CONVERTIBLE',
  'NO_FX_RATE',
  'OUTLET_NOT_CHOSEN',
  'NO_CONTRACT',
] as const;
export type MarginGap = (typeof MARGIN_GAPS)[number];

export interface MarginLineDto {
  component: MarginComponent;
  /** In the card's currency, for the quantity; null when not applicable or missing. */
  amount: DecimalString | null;
  notApplicable: boolean;
  gap: MarginGap | null;
}

export interface ExpectedMarginDto {
  rateCardId: string;
  currency: CurrencyCode;
  /** The reference quantity; null: one unit, without the minimum charge. */
  quantity: DecimalString | null;
  /** The card's price for one unit, or max(quantity × price, minimum charge). */
  price: DecimalString;
  lines: MarginLineDto[];
  /** Price less every component; null while any component is missing (never a guess). */
  expectedMargin: DecimalString | null;
  incomplete: boolean;
  missing: MarginComponent[];
  /** The exchange rates' date (the card branch's today). */
  asOf: string;
}
