/**
 * Display only: groups the integer digits of a decimal string the API returned ("1666666.67" to
 * "1,666,666.67"). It works on the text and never converts the amount to a number (AGENTS.md
 * rule 1); anything that is not a plain decimal string is shown unchanged.
 */
export function formatAmount(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value);
  if (!match) return value;
  const [, sign = '', integer = '', fraction = ''] = match;
  return `${sign}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`;
}

/** Today in the browser's time zone, as yyyy-mm-dd. A default for date inputs only. */
export function todayString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Pattern for amount inputs: what the API accepts (up to 14 integer and 4 decimal digits). */
export const AMOUNT_PATTERN = '\\d{1,14}(\\.\\d{1,4})?';

/** Pattern for exchange-rate inputs: up to 10 integer and 8 decimal digits. */
export const FX_RATE_PATTERN = '\\d{1,10}(\\.\\d{1,8})?';
