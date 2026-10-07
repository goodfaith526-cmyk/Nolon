import { BRANCH_CODES, isCurrencyCodeFormat } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { BRANCHES } from './branches.js';

describe('BRANCHES', () => {
  it('covers every branch code exactly once', () => {
    expect(BRANCHES.map((branch) => branch.code).sort()).toEqual([...BRANCH_CODES].sort());
  });

  it('uses well-formed currency codes and valid time zones', () => {
    for (const branch of BRANCHES) {
      expect(isCurrencyCodeFormat(branch.defaultCurrency)).toBe(true);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: branch.timezone })).not.toThrow();
      expect(branch.countryCode).toMatch(/^[A-Z]{2}$/);
    }
  });
});
