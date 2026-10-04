import type { CustomsClearanceRequest, CurrencyCode } from '@nolon/shared';
import { daysBetween } from '../common/dates.js';
import { type Decimal, ZERO, roundMoney } from '../common/money.js';

/** Customs rules (scope 11), as pure functions. */

/** Why a customs file cannot be saved as given, or null when it can. */
export function clearanceProblem(input: CustomsClearanceRequest): string | null {
  if (input.submittedOn && input.clearedOn && input.clearedOn < input.submittedOn) {
    return 'The clearance date cannot be before the submission date';
  }
  if (input.status === 'CLEARED' && !input.clearedOn) {
    return 'A cleared file needs its clearance date';
  }
  if (input.status !== 'CLEARED' && input.clearedOn) {
    return 'Only a cleared file has a clearance date';
  }
  return null;
}

/** A fee is positive and has no more decimals than its currency's minor units. */
export function isValidFeeAmount(amount: Decimal, decimalPlaces: number): boolean {
  return amount.gt(0) && roundMoney(amount, decimalPlaces).eq(amount);
}

/** Fee totals per currency, in the order each currency first appears. No conversion. */
export function feeTotals(
  fees: readonly { currency: CurrencyCode; amount: Decimal }[],
): { currency: CurrencyCode; amount: Decimal }[] {
  const totals = new Map<CurrencyCode, Decimal>();
  for (const fee of fees) {
    totals.set(fee.currency, (totals.get(fee.currency) ?? ZERO).plus(fee.amount));
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

/** Days from submission to clearance of a cleared file; null until both dates are known. */
export function clearanceDays(submittedOn: string | null, clearedOn: string | null): number | null {
  if (!submittedOn || !clearedOn) return null;
  return Math.max(daysBetween(submittedOn, clearedOn), 0);
}

/**
 * Days a file not yet cleared has been open: since its submission, or since it was opened when it
 * has not been submitted; null for a cleared file.
 */
export function daysOpen(
  clearedOn: string | null,
  submittedOn: string | null,
  openedOn: string,
  today: string,
): number | null {
  if (clearedOn) return null;
  return Math.max(daysBetween(submittedOn ?? openedOn, today), 0);
}
