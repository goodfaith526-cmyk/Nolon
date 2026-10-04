import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { AgingTotals, agingBucket, daysPastDue } from './aging.js';

describe('AR aging', () => {
  it('counts whole calendar days from the due date', () => {
    expect(daysPastDue('2026-03-31', '2026-03-31')).toBe(0);
    expect(daysPastDue('2026-03-30', '2026-03-31')).toBe(-1);
    expect(daysPastDue('2026-04-01', '2026-03-31')).toBe(1);
    // Across a leap day and a year end.
    expect(daysPastDue('2024-03-01', '2024-02-28')).toBe(2);
    expect(daysPastDue('2027-01-01', '2026-12-01')).toBe(31);
  });

  it('puts the bucket edges where the annex says', () => {
    expect(agingBucket(-10)).toBe('current');
    expect(agingBucket(0)).toBe('current');
    expect(agingBucket(1)).toBe('days1to30');
    expect(agingBucket(30)).toBe('days1to30');
    expect(agingBucket(31)).toBe('days31to60');
    expect(agingBucket(60)).toBe('days31to60');
    expect(agingBucket(61)).toBe('days61to90');
    expect(agingBucket(90)).toBe('days61to90');
    expect(agingBucket(91)).toBe('over90');
  });

  it('adds amounts per bucket and in total, as decimals', () => {
    const totals = new AgingTotals();
    totals.add('current', dec('0.1'));
    totals.add('current', dec('0.2'));
    totals.add('over90', dec('1666.67'));
    expect(totals.toDto()).toEqual({
      current: '0.3',
      days1to30: '0',
      days31to60: '0',
      days61to90: '0',
      over90: '1666.67',
      total: '1666.97',
    });
  });
});
