import { describe, expect, it } from 'vitest';
import { packageLabels, startOfYear } from './print';

const lines = [
  { lineNo: 1, quantity: 2, name: 'pallets' },
  { lineNo: 2, quantity: 0, name: 'nothing' },
  { lineNo: 3, quantity: 3, name: 'barrels' },
];

describe('packageLabels', () => {
  it('gives one label per package, numbered across the shipment', () => {
    const { labels, nextFrom } = packageLabels(lines, 5);
    expect(nextFrom).toBeNull();
    expect(labels.map((l) => [l.index, l.total, l.line.name])).toEqual([
      [1, 5, 'pallets'],
      [2, 5, 'pallets'],
      [3, 5, 'barrels'],
      [4, 5, 'barrels'],
      [5, 5, 'barrels'],
    ]);
  });

  it('prints one cargo line, keeping the shipment-wide numbers', () => {
    const { labels } = packageLabels(lines, 5, { onlyLine: 3 });
    expect(labels.map((l) => `${l.index}/${l.total}`)).toEqual(['3/5', '4/5', '5/5']);
  });

  it('stops at the maximum and says where the next batch starts', () => {
    const { labels, nextFrom } = packageLabels([{ lineNo: 1, quantity: 12 }], 12, { max: 10 });
    expect(labels).toHaveLength(10);
    expect(labels.at(-1)?.index).toBe(10);
    expect(nextFrom).toBe(11);
  });

  it('prints every label of a large line, batch after batch', () => {
    const big = [
      { lineNo: 1, quantity: 3 },
      { lineNo: 2, quantity: 800 },
    ];
    const seen: number[] = [];
    let from: number | null = 1;
    let batches = 0;
    while (from !== null) {
      const batch: { labels: { index: number }[]; nextFrom: number | null } = packageLabels(
        big,
        803,
        { from },
      );
      seen.push(...batch.labels.map((l) => l.index));
      from = batch.nextFrom;
      batches += 1;
    }
    expect(batches).toBe(2);
    expect(seen).toEqual(Array.from({ length: 803 }, (_, i) => i + 1));
  });

  it('starts a batch at a package number, within one line too', () => {
    const second = packageLabels([{ lineNo: 2, quantity: 800 }], 803, { from: 504, onlyLine: 2 });
    expect(second.labels).toHaveLength(297);
    expect(second.labels[0]?.index).toBe(504);
    expect(second.nextFrom).toBeNull();
    const fromLine = packageLabels(lines, 5, { from: 4 });
    expect(fromLine.labels.map((l) => l.index)).toEqual([4, 5]);
  });

  it('gives nothing for a shipment without packages, or past its last one', () => {
    expect(packageLabels([], 0)).toEqual({ labels: [], nextFrom: null });
    expect(packageLabels([{ lineNo: 1, quantity: -1 }], 0).labels).toEqual([]);
    expect(packageLabels(lines, 5, { from: 9 }).labels).toEqual([]);
  });
});

describe('startOfYear', () => {
  it('is the first of January of the date’s year', () => {
    expect(startOfYear('2026-10-04')).toBe('2026-01-01');
  });
});
