import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { clearanceProblem, feeTotals, isValidFeeAmount } from './customs-rules.js';

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
