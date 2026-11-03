import { BASE_CURRENCY } from '@nolon/shared';
import { USD_DECIMALS, toUsd } from '../accounting/journal-math.js';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';

/**
 * Partner commission arithmetic (plan 07, 4.2 and 4.7), in one place: what a slot (a partner's role
 * on a shipment, in one currency) should hold now, and the entry that moves it there. Every amount
 * is a Prisma Decimal; each figure is rounded once, where it is made.
 */

/** An approved customer invoice of the shipment, as a percentage reads it. */
export interface CommissionInvoice {
  currency: string;
  fxRate: Decimal;
  total: Decimal;
  /** Approved credit notes against it, in its currency. */
  credited: Decimal;
  /** Its lines that are not reimbursable charges. */
  commissionable: Decimal;
}

/** What a slot should hold: in its currency and, separately, its USD carrying value. */
export interface SlotTarget {
  amount: Decimal;
  amountUsd: Decimal;
  /** Percentages: the base, to 4 places. Fixed amounts: null. */
  base: Decimal | null;
  /** Fixed amounts: the quantity in the contract's unit. Percentages: null. */
  quantity: Decimal | null;
  /** The rate the USD value came from; null when the invoices' rates differ. */
  fxRate: Decimal | null;
}

const PERCENT = dec(100);

/**
 * A percentage, per invoice currency: the base is each invoice's non-reimbursable lines less its
 * share of the credit notes (a credit note is shared over its invoice's lines in proportion, as
 * rule 6 shares it). The commission in the currency is rounded once, on the sum; its USD value is
 * each invoice's commission at that invoice's own rate, each rounded to cents (4.7). A USD slot has
 * one figure.
 */
export function percentTargets(
  invoices: readonly CommissionInvoice[],
  percent: Decimal,
  decimalsOf: (currency: string) => number,
): Map<string, SlotTarget> {
  const sums = new Map<
    string,
    { base: Decimal; usd: Decimal; rates: Set<string>; rate: Decimal }
  >();
  for (const invoice of invoices) {
    if (!invoice.total.gt(0)) continue;
    const base = invoice.commissionable.times(dec(1).minus(invoice.credited.div(invoice.total)));
    const commission = base.times(percent).div(PERCENT);
    const sum = sums.get(invoice.currency) ?? {
      base: ZERO,
      usd: ZERO,
      rates: new Set<string>(),
      rate: invoice.fxRate,
    };
    sum.base = sum.base.plus(base);
    sum.usd = sum.usd.plus(roundMoney(commission.div(invoice.fxRate), USD_DECIMALS));
    sum.rates.add(invoice.fxRate.toFixed());
    sums.set(invoice.currency, sum);
  }
  const targets = new Map<string, SlotTarget>();
  for (const [currency, sum] of sums) {
    const amount = roundMoney(sum.base.times(percent).div(PERCENT), decimalsOf(currency));
    targets.set(currency, {
      amount,
      amountUsd: currency === BASE_CURRENCY ? amount : sum.usd,
      base: roundMoney(sum.base, 4),
      quantity: null,
      fxRate: sum.rates.size === 1 ? sum.rate : null,
    });
  }
  return targets;
}

/** A fixed amount per unit: quantity × amount, at the slot's rate (kept from its first accrual). */
export function fixedTarget(
  quantity: Decimal,
  value: Decimal,
  currency: string,
  decimalPlaces: number,
  fxRate: Decimal,
): SlotTarget {
  const amount = roundMoney(quantity.times(value), decimalPlaces);
  return { amount, amountUsd: toUsd(amount, fxRate, currency), base: null, quantity, fxRate };
}

/** Nothing earned (the event undone, the shipment cancelled, the partner taken off): zero, exactly. */
export const ZERO_TARGET: SlotTarget = {
  amount: ZERO,
  amountUsd: ZERO,
  base: null,
  quantity: null,
  fxRate: null,
};

/** One debit and one credit of rule 16, in the slot's currency or (USD only) in dollars. */
export interface CommissionLinePair {
  currency: string;
  fxRate: Decimal;
  amount: Decimal;
  amountUsd: Decimal;
  /** True: debit commission cost, credit accrued commissions. False: the other way round. */
  accrues: boolean;
}

/**
 * The lines that move a slot by `amount` in its currency and `amountUsd` in USD (4.7): one pair
 * carrying both when they go the same way; a pair at 0 USD in the currency and a USD pair when they
 * go opposite ways; a USD pair alone for a USD difference with no difference in the currency.
 * Returns null when the entry would be worth nothing in USD (the journal refuses it).
 */
export function commissionLines(
  currency: string,
  fxRate: Decimal,
  amount: Decimal,
  amountUsd: Decimal,
): CommissionLinePair[] | null {
  if (amountUsd.isZero()) return null;
  const usdPair = (usd: Decimal): CommissionLinePair => ({
    currency: BASE_CURRENCY,
    fxRate: dec(1),
    amount: usd.abs(),
    amountUsd: usd.abs(),
    accrues: usd.gt(0),
  });
  if (amount.isZero()) return [usdPair(amountUsd)];
  if (currency === BASE_CURRENCY) return [usdPair(amount)];
  if (amount.gt(0) === amountUsd.gt(0)) {
    return [
      { currency, fxRate, amount: amount.abs(), amountUsd: amountUsd.abs(), accrues: amount.gt(0) },
    ];
  }
  return [
    { currency, fxRate, amount: amount.abs(), amountUsd: ZERO, accrues: amount.gt(0) },
    usdPair(amountUsd),
  ];
}

/** The rate shown on a slot's currency lines: its own, or the one its difference implies. */
export function lineRate(
  target: SlotTarget,
  amount: Decimal,
  amountUsd: Decimal,
  fallback: Decimal,
): Decimal {
  if (target.fxRate) return target.fxRate;
  if (!amount.isZero() && !amountUsd.isZero()) return roundMoney(amount.div(amountUsd).abs(), 8);
  return fallback;
}
