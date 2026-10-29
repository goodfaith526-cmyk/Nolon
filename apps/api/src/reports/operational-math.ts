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

/**
 * Scans pages (`fetch` from a cursor, `nextAfterId` null once done) and keeps what `keep`
 * returns of each, until more than `limit` items are kept or nothing is left. A kept item is
 * never missed behind the rows `keep` drops; `truncated` says more than `limit` were kept (only
 * the first `limit` are returned).
 */
export async function collectPaged<T, K>(
  fetch: (cursor: string | null) => Promise<{ rows: T[]; nextAfterId: string | null }>,
  keep: (rows: T[]) => Promise<K[]>,
  limit: number,
): Promise<{ items: K[]; truncated: boolean }> {
  const items: K[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetch(cursor);
    items.push(...(await keep(page.rows)));
    if (items.length > limit) return { items: items.slice(0, limit), truncated: true };
    if (page.nextAfterId === null) return { items, truncated: false };
    cursor = page.nextAfterId;
  }
}
