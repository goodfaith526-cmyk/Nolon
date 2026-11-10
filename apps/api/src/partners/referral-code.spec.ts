import { REFERRAL_CODE_PATTERN } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { randomReferralCode } from './partners.service.js';

describe('randomReferralCode (plan 18, 3)', () => {
  it('is r_ and 8 lowercase letters or digits, and varies', () => {
    const codes = new Set(Array.from({ length: 200 }, () => randomReferralCode()));
    for (const code of codes) expect(code).toMatch(REFERRAL_CODE_PATTERN);
    expect(codes.size).toBeGreaterThan(195);
  });
});
