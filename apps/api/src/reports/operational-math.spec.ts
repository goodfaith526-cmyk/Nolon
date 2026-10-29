import { describe, expect, it } from 'vitest';
import { averageDays, collectPaged, conversionRate } from './operational-math.js';

describe('conversionRate', () => {
  it('is part / whole as a percentage to 2 places, rounded half up', () => {
    expect(conversionRate(1, 4)).toBe('25.00');
    expect(conversionRate(2, 3)).toBe('66.67');
    expect(conversionRate(1, 3)).toBe('33.33');
    expect(conversionRate(1, 8)).toBe('12.50');
    expect(conversionRate(1, 800)).toBe('0.13');
    expect(conversionRate(3, 3)).toBe('100.00');
    expect(conversionRate(0, 5)).toBe('0.00');
  });

  it('has no rate without a base', () => {
    expect(conversionRate(0, 0)).toBeNull();
  });
});

describe('averageDays', () => {
  it('averages to 1 place, half up', () => {
    expect(averageDays(7, 2)).toBe('3.5');
    expect(averageDays(10, 3)).toBe('3.3');
    expect(averageDays(5, 3)).toBe('1.7');
    expect(averageDays(1, 4)).toBe('0.3');
    expect(averageDays(0, 4)).toBe('0.0');
    expect(averageDays(3, 0)).toBeNull();
  });
});

describe('collectPaged', () => {
  /** Ids 1..n in pages of `take`; keeps the ids in `wanted`. */
  const pages = (n: number, take: number) => {
    const fetched: (string | null)[] = [];
    const fetch = (cursor: string | null) => {
      fetched.push(cursor);
      const from = cursor === null ? 0 : Number(cursor);
      const rows = Array.from({ length: Math.min(take, n - from) }, (_, i) => from + i + 1);
      const last = rows.at(-1);
      return Promise.resolve({
        rows,
        nextAfterId: rows.length === take && last !== undefined ? String(last) : null,
      });
    };
    return { fetch, fetched };
  };
  const keep = (wanted: number[]) => (rows: number[]) =>
    Promise.resolve(rows.filter((r) => wanted.includes(r)));

  it('finds the one kept item behind a full page of dropped ones (the 2000/2001 boundary)', async () => {
    const { fetch, fetched } = pages(2001, 2000);
    expect(await collectPaged(fetch, keep([2001]), 2000)).toEqual({
      items: [2001],
      truncated: false,
    });
    expect(fetched).toEqual([null, '2000']);
  });

  it('returns exactly the limit without a cut when no more are kept', async () => {
    const { fetch } = pages(6, 2);
    expect(await collectPaged(fetch, keep([1, 2, 3, 4]), 4)).toEqual({
      items: [1, 2, 3, 4],
      truncated: false,
    });
  });

  it('says the list is cut when more than the limit are kept', async () => {
    const { fetch } = pages(7, 2);
    expect(await collectPaged(fetch, keep([1, 3, 5, 7]), 3)).toEqual({
      items: [1, 3, 5],
      truncated: true,
    });
  });

  it('stops on an empty first page', async () => {
    const { fetch } = pages(0, 2);
    expect(await collectPaged(fetch, keep([]), 3)).toEqual({ items: [], truncated: false });
  });
});
