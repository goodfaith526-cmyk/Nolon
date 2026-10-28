import type {
  CommissionBasis,
  MarginComponent,
  MarginGap,
  RateCostComponent,
  RateCostStatus,
  RateUnit,
} from '@nolon/shared';
import { RATE_COST_COMPONENTS } from '@nolon/shared';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';

/**
 * A rate card's expected margin (business model plan 6.1), in one place: price less the reference
 * costs and the outlet's commission, each brought to the card's unit and currency first. Exact
 * Decimal arithmetic throughout; amounts are rounded once, for display, to the currency's places.
 * Any component that cannot be brought to a number (not entered, a unit nothing converts, no
 * exchange rate, no outlet, no contract) makes the margin incomplete: null, never a guess, and a
 * zero only when a zero was entered.
 */

export interface MarginCard {
  unit: RateUnit;
  price: Decimal;
  minimumCharge: Decimal;
  currency: string;
}

export interface MarginCost {
  component: RateCostComponent;
  status: RateCostStatus;
  amount: Decimal | null;
  currency: string | null;
  unit: RateUnit | null;
  unitsPerCostUnit: Decimal | null;
  /** The card unit the factor was entered for; it converts only while the card has that unit. */
  conversionCardUnit: RateUnit | null;
}

export interface MarginContract {
  basis: CommissionBasis;
  value: Decimal;
  unit: RateUnit | null;
  currency: string | null;
}

/** The outlet's commission: no outlet chosen, an outlet without a contract for the card, or one. */
export type MarginCommission =
  { kind: 'NO_OUTLET' } | { kind: 'NO_CONTRACT' } | { kind: 'CONTRACT'; contract: MarginContract };

export interface MarginInput {
  card: MarginCard;
  costs: readonly MarginCost[];
  commission: MarginCommission;
  /** The reference quantity; null: one unit, without the minimum charge. */
  quantity: Decimal | null;
  /** Units of a currency per 1 USD on the margin's date; null when there is no rate. */
  fxRate: (currency: string) => Decimal | null;
  decimalPlaces: number;
}

export interface MarginLine {
  component: MarginComponent;
  amount: Decimal | null;
  notApplicable: boolean;
  gap: MarginGap | null;
}

export interface MarginResult {
  price: Decimal;
  lines: MarginLine[];
  expectedMargin: Decimal | null;
  missing: MarginComponent[];
}

type Converted = { amount: Decimal } | { gap: MarginGap };

export function computeExpectedMargin(input: MarginInput): MarginResult {
  const { card, quantity } = input;
  const units = quantity ?? dec(1);
  const extended = units.mul(card.price);
  // One unit: the price itself. A quantity: the line as a quotation prices it, with the minimum.
  const price = quantity && extended.lt(card.minimumCharge) ? card.minimumCharge : extended;

  const inCardCurrency = (amount: Decimal, currency: string): Converted => {
    if (currency === card.currency) return { amount };
    const from = input.fxRate(currency);
    const to = input.fxRate(card.currency);
    if (!from || !to || !from.gt(0) || !to.gt(0)) return { gap: 'NO_FX_RATE' };
    return { amount: amount.div(from).mul(to) };
  };

  const costLine = (component: RateCostComponent): MarginLine => {
    const cost = input.costs.find((c) => c.component === component);
    if (!cost) return { component, amount: null, notApplicable: false, gap: 'NOT_ENTERED' };
    if (cost.status === 'NOT_APPLICABLE') {
      return { component, amount: ZERO, notApplicable: true, gap: null };
    }
    if (!cost.amount || !cost.currency || !cost.unit) {
      return { component, amount: null, notApplicable: false, gap: 'NOT_ENTERED' };
    }
    let perUnit: Decimal;
    if (cost.unit === card.unit) perUnit = cost.amount;
    else if (cost.unitsPerCostUnit?.gt(0) && cost.conversionCardUnit === card.unit)
      perUnit = cost.amount.div(cost.unitsPerCostUnit);
    else return { component, amount: null, notApplicable: false, gap: 'UNIT_NOT_CONVERTIBLE' };
    const converted = inCardCurrency(perUnit.mul(units), cost.currency);
    return 'gap' in converted
      ? { component, amount: null, notApplicable: false, gap: converted.gap }
      : { component, amount: converted.amount, notApplicable: false, gap: null };
  };

  const commissionLine = (): MarginLine => {
    const component = 'OUTLET_COMMISSION';
    const { commission } = input;
    if (commission.kind === 'NO_OUTLET') {
      return { component, amount: null, notApplicable: false, gap: 'OUTLET_NOT_CHOSEN' };
    }
    if (commission.kind === 'NO_CONTRACT') {
      return { component, amount: null, notApplicable: false, gap: 'NO_CONTRACT' };
    }
    const { contract } = commission;
    if (contract.basis === 'PERCENT_OF_PRICE') {
      // On the line's price after the minimum charge (a card has no discount).
      return {
        component,
        amount: price.mul(contract.value).div(100),
        notApplicable: false,
        gap: null,
      };
    }
    // A fixed amount per unit converts only when its unit is the card's: no implicit conversion.
    if (contract.unit !== card.unit || !contract.currency) {
      return { component, amount: null, notApplicable: false, gap: 'UNIT_NOT_CONVERTIBLE' };
    }
    const converted = inCardCurrency(contract.value.mul(units), contract.currency);
    return 'gap' in converted
      ? { component, amount: null, notApplicable: false, gap: converted.gap }
      : { component, amount: converted.amount, notApplicable: false, gap: null };
  };

  const exact = [commissionLine(), ...RATE_COST_COMPONENTS.map(costLine)];
  const missing = exact.filter((l) => l.gap !== null).map((l) => l.component);
  const expectedMargin =
    missing.length === 0
      ? roundMoney(
          exact.reduce((left, l) => left.sub(l.amount ?? ZERO), price),
          input.decimalPlaces,
        )
      : null;
  return {
    price: roundMoney(price, input.decimalPlaces),
    lines: exact.map((l) => ({
      ...l,
      amount: l.amount === null ? null : roundMoney(l.amount, input.decimalPlaces),
    })),
    expectedMargin,
    missing,
  };
}
