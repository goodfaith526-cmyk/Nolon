import { Prisma } from '../generated/prisma/client.js';

/**
 * Money arithmetic (AGENTS.md rule 1). Amounts are Prisma.Decimal; they enter and leave the API
 * as decimal strings. All rounding of money goes through `roundMoney`, half away from zero, to the
 * currency's minor units (`currencies.decimal_places`).
 */
export type Decimal = Prisma.Decimal;

export const ZERO: Decimal = new Prisma.Decimal(0);

export function dec(value: string | number | Decimal): Decimal {
  return new Prisma.Decimal(value);
}

export function roundMoney(value: Decimal, decimalPlaces: number): Decimal {
  return value.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
}

/** Decimal to its API form: a plain decimal string with the column's 4 places trimmed. */
export function toDecimalString(value: Decimal): string {
  return value.toFixed();
}

export function toDecimalStringOrNull(value: Decimal | null): string | null {
  return value === null ? null : value.toFixed();
}

/** The exchange rate a request sent, as stored for idempotent retries: null when it sent none. */
export function requestedRate(sent: string | null | undefined): Decimal | null {
  return sent ? dec(sent) : null;
}

/**
 * Whether a retry sent the rate the first request sent, at Decimal precision: both omitted, or
 * both the same number. The rate the first request resolved from the FX table is not consulted,
 * so editing the table afterwards does not turn an exact retry into a conflict.
 */
export function sameRequestedRate(
  stored: Decimal | null,
  sent: string | null | undefined,
): boolean {
  if (!sent) return stored === null;
  return stored !== null && stored.eq(dec(sent));
}
