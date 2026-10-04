import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  clearanceDays,
  clearanceProblem,
  daysOpen,
  feeTotals,
  isValidFeeAmount,
} from './customs-rules.js';

describe('clearanceProblem', () => {
  it('accepts a file in progress and a cleared file with its date', () => {
    expect(clearanceProblem({ status: 'PENDING' })).toBeNull();
    expect(clearanceProblem({ status: 'SUBMITTED', submittedOn: '2026-10-01' })).toBeNull();
    expect(
      clearanceProblem({ status: 'CLEARED', submittedOn: '2026-10-01', clearedOn: '2026-10-01' }),
    ).toBeNull();
  });

  it('refuses a clearance date before the submission date', () => {
    expect(
      clearanceProblem({ status: 'CLEARED', submittedOn: '2026-10-02', clearedOn: '2026-10-01' }),
    ).toMatch(/before/);
  });

  it('a cleared file needs a clearance date, and only a cleared file has one', () => {
    expect(clearanceProblem({ status: 'CLEARED' })).toMatch(/needs/);
    expect(clearanceProblem({ status: 'HELD', clearedOn: '2026-10-01' })).toMatch(/Only/);
  });
});

describe('fees', () => {
  it('amounts are positive and fit the currency minor units', () => {
    expect(isValidFeeAmount(dec('150.25'), 2)).toBe(true);
    expect(isValidFeeAmount(dec('150.255'), 2)).toBe(false);
    expect(isValidFeeAmount(dec('150'), 0)).toBe(true);
    expect(isValidFeeAmount(dec('150.5'), 0)).toBe(false);
    expect(isValidFeeAmount(dec('0'), 2)).toBe(false);
  });

  it('totals per currency without converting', () => {
    const totals = feeTotals([
      { currency: 'SDG', amount: dec('1000.10') },
      { currency: 'USD', amount: dec('50') },
      { currency: 'SDG', amount: dec('0.20') },
    ]);
    expect(totals.map((t) => [t.currency, t.amount.toFixed()])).toEqual([
      ['SDG', '1000.3'],
      ['USD', '50'],
    ]);
  });
});

describe('clearance time', () => {
  it('a cleared file took the days from submission to clearance', () => {
    expect(clearanceDays('2026-10-01', '2026-10-01')).toBe(0);
    expect(clearanceDays('2026-10-01', '2026-10-04')).toBe(3);
    expect(clearanceDays('2026-09-28', '2026-10-03')).toBe(5);
  });

  it('is unknown without both dates', () => {
    expect(clearanceDays(null, '2026-10-04')).toBeNull();
    expect(clearanceDays('2026-10-01', null)).toBeNull();
  });

  it('an open file counts from submission, else from when it was opened, to today', () => {
    expect(daysOpen(null, '2026-10-01', '2026-09-20', '2026-10-05')).toBe(4);
    expect(daysOpen(null, null, '2026-09-20', '2026-10-05')).toBe(15);
    expect(daysOpen('2026-10-03', '2026-10-01', '2026-09-20', '2026-10-05')).toBeNull();
  });
});
