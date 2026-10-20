import { describe, expect, it } from 'vitest';
import { addDays } from './dates.js';

describe('addDays', () => {
  it('adds calendar days across months, years and a leap day', () => {
    expect(addDays('2026-10-19', 30)).toBe('2026-11-18');
    expect(addDays('2026-12-20', 14)).toBe('2027-01-03');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
