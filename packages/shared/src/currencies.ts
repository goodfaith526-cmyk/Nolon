/** Base reporting currency. All functional amounts roll up to this. */
export const BASE_CURRENCY = 'USD' as const;

export const CURRENCY_CODES = ['USD', 'AED', 'SAR', 'SDG', 'EUR'] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/**
 * Money crosses the API boundary as a decimal string (e.g. "1250.50"), never as a JS number,
 * so no precision is lost between the database `Decimal` and the client.
 */
export type DecimalString = string;

export interface Money {
  amount: DecimalString;
  currency: CurrencyCode;
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCY_CODES as readonly string[]).includes(value);
}
