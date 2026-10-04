import { describe, expect, it } from 'vitest';
import { daysLate } from './lateness.js';

describe('daysLate', () => {
  it('an open shipment is late from the day after its ETA', () => {
    expect(daysLate('2026-03-10', null, '2026-03-09')).toBeNull();
    expect(daysLate('2026-03-10', null, '2026-03-10')).toBeNull();
    expect(daysLate('2026-03-10', null, '2026-03-11')).toBe(1);
    expect(daysLate('2026-03-10', null, '2026-04-09')).toBe(30);
  });

  it('a delivered shipment counts to its delivery day, whatever today is', () => {
    expect(daysLate('2026-03-10', '2026-03-10', '2026-06-01')).toBeNull();
    expect(daysLate('2026-03-10', '2026-03-08', '2026-06-01')).toBeNull();
    expect(daysLate('2026-03-10', '2026-03-13', '2026-06-01')).toBe(3);
  });

  it('counts calendar days across months and leap days', () => {
    expect(daysLate('2028-02-28', '2028-03-01', '2028-03-05')).toBe(2);
    expect(daysLate('2027-12-31', null, '2028-01-01')).toBe(1);
  });
});
