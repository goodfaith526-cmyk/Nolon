import { describe, expect, it } from 'vitest';
import { dec, requestedRate, sameRequestedRate } from './money.js';

describe('requested exchange rates of idempotent requests', () => {
  it('stores what was sent, null when nothing was', () => {
    expect(requestedRate(undefined)).toBeNull();
    expect(requestedRate(null)).toBeNull();
    expect(requestedRate('600.5')?.toFixed()).toBe('600.5');
  });

  it('a retry matches only when both omitted the rate or both sent the same number', () => {
    expect(sameRequestedRate(null, undefined)).toBe(true);
    expect(sameRequestedRate(null, null)).toBe(true);
    expect(sameRequestedRate(dec('600'), '600.00000000')).toBe(true);
    expect(sameRequestedRate(dec('600'), '600.00000001')).toBe(false);
    expect(sameRequestedRate(dec('600'), undefined)).toBe(false);
    expect(sameRequestedRate(null, '600')).toBe(false);
  });
});
