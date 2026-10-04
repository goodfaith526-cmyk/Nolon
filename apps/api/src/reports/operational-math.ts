import { dec, roundMoney } from '../common/money.js';

/**
 * Ratios and averages of the operational reports, in one place. They are not money, but they go
 * through Decimal so that the same figures always round the same way (half up).
 */

/** Rates are shown as percentages to 2 places. */
const RATE_DECIMALS = 2;
/** Average days are shown to 1 place. */
const DAYS_DECIMALS = 1;

/** part / whole x 100, to 2 places; null when there is nothing to divide by. */
export function conversionRate(part: number, whole: number): string | null {
  if (whole === 0) return null;
  return roundMoney(dec(part).div(whole).times(100), RATE_DECIMALS).toFixed(RATE_DECIMALS);
}

/** totalDays / count, to 1 place; null when there is nothing to average. */
export function averageDays(totalDays: number, count: number): string | null {
  if (count === 0) return null;
  return roundMoney(dec(totalDays).div(count), DAYS_DECIMALS).toFixed(DAYS_DECIMALS);
}
