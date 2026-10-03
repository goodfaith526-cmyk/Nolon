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
