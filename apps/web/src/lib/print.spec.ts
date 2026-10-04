import { describe, expect, it } from 'vitest';
import { packageLabels, startOfYear } from './print';

const lines = [
  { lineNo: 1, quantity: 2, name: 'pallets' },
  { lineNo: 2, quantity: 0, name: 'nothing' },
  { lineNo: 3, quantity: 3, name: 'barrels' },
];

describe('packageLabels', () => {
  it('gives one label per package, numbered across the shipment', () => {
    const { labels, total, truncated } = packageLabels(lines);
    expect(total).toBe(5);
    expect(truncated).toBe(false);
    expect(labels.map((l) => [l.index, l.total, l.line.name])).toEqual([
      [1, 5, 'pallets'],
      [2, 5, 'pallets'],
      [3, 5, 'barrels'],
      [4, 5, 'barrels'],
      [5, 5, 'barrels'],
    ]);
  });

  it('prints one cargo line, keeping the shipment-wide numbers', () => {
    const { labels } = packageLabels(lines, { onlyLine: 3 });
    expect(labels.map((l) => `${l.index}/${l.total}`)).toEqual(['3/5', '4/5', '5/5']);
  });

  it('stops at the maximum and says so', () => {
    const { labels, total, truncated } = packageLabels([{ lineNo: 1, quantity: 12 }], { max: 10 });
    expect(labels).toHaveLength(10);
    expect(labels.at(-1)?.index).toBe(10);
    expect(total).toBe(12);
    expect(truncated).toBe(true);
  });

  it('gives nothing for a shipment without packages', () => {
    expect(packageLabels([])).toEqual({ labels: [], total: 0, truncated: false });
    expect(packageLabels([{ lineNo: 1, quantity: -1 }]).total).toBe(0);
  });
});

describe('startOfYear', () => {
  it('is the first of January of the date’s year', () => {
    expect(startOfYear('2026-10-04')).toBe('2026-01-01');
  });
});
