import { BRANCH_CODES, isCurrencyCode } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { DEMO_BRANCHES } from './demo-data.js';

describe('DEMO_BRANCHES', () => {
  it('covers every branch code exactly once', () => {
    expect(DEMO_BRANCHES.map((branch) => branch.code).sort()).toEqual([...BRANCH_CODES].sort());
  });

  it('uses supported currencies and valid time zones', () => {
    for (const branch of DEMO_BRANCHES) {
      expect(isCurrencyCode(branch.defaultCurrency)).toBe(true);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: branch.timezone })).not.toThrow();
      expect(branch.countryCode).toMatch(/^[A-Z]{2}$/);
    }
  });
});
