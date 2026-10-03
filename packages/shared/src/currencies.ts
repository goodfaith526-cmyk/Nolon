/** Base reporting currency. All functional amounts roll up to this. */
export const BASE_CURRENCY = 'USD';

/**
 * ISO 4217 code (e.g. "SDG"). The set of currencies is master data in the `currencies` table and
 * can grow without a deploy, so this is deliberately an open string: whether a code is usable is
 * decided by the API against that table, not by this package.
 */
export type CurrencyCode = string;

/**
 * Money crosses the API boundary as a decimal string (e.g. "1250.50"), never as a JS number,
 * so no precision is lost between the database `Decimal` and the client.
 */
export type DecimalString = string;

export interface Money {
  amount: DecimalString;
  currency: CurrencyCode;
}

/** Shape check only (three uppercase letters). It does not mean the currency exists. */
export function isCurrencyCodeFormat(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}
