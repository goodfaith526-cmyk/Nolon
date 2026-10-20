import type {
  CustomsClearanceRequest,
  CustomsStatus,
  CurrencyCode,
  ShipmentStatus,
} from '@nolon/shared';
import { addDays, daysBetween } from '../common/dates.js';
import { startOfDayIn } from '../common/list-filters.js';
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

/**
 * The shipment statuses a saved customs file moves the shipment through (functional review D1),
 * in order: a file in progress (submitted, under inspection or held) means customs in progress; a
 * cleared file means cleared, through customs in progress when the shipment has not got there. A
 * pending file moves nothing. Each step goes through the state machine, which skips a step the
 * shipment has already passed or cannot take now, so nothing moves backwards or repeats.
 */
export function shipmentStepsForFile(status: CustomsStatus): ShipmentStatus[] {
  switch (status) {
    case 'PENDING':
      return [];
    case 'CLEARED':
      return ['CUSTOMS_IN_PROGRESS', 'CUSTOMS_CLEARED'];
    default:
      return ['CUSTOMS_IN_PROGRESS'];
  }
}

/**
 * When the shipment's clearance happened, from the file's clearance date (a branch-local day):
 * now when it is today; the last instant of that day when it is earlier, so it never lands
 * before the day's other events; null when it is after today (the caller refuses it).
 */
export function clearanceMoment(
  clearedOn: string,
  timeZone: string,
  today: string,
  now: Date,
): Date | null {
  if (clearedOn > today) return null;
  if (clearedOn === today) return now;
  return new Date(startOfDayIn(addDays(clearedOn, 1), timeZone).getTime() - 1);
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
