import type { CustomsClearanceRequest, CurrencyCode } from '@nolon/shared';
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
