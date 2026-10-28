import { describe, expect, it } from 'vitest';
import { currentLocationOf } from './location-timeline.js';

const at = (day: number, created = day) => ({
  at: new Date(Date.UTC(2026, 9, day)),
  createdAt: new Date(Date.UTC(2026, 9, created)),
});

describe('currentLocationOf (B3)', () => {
  it('is null with no place', () => {
    expect(currentLocationOf([])).toBeNull();
  });

  it('takes the latest by time, then by when it was recorded', () => {
    expect(
      currentLocationOf([
        { ...at(1), locationId: 'x' },
        { ...at(3), locationId: 'y' },
        { ...at(2), locationId: 'z' },
      ]),
    ).toBe('y');
    expect(
      currentLocationOf([
        { ...at(2, 5), locationId: 'late' },
        { ...at(2, 4), locationId: 'early' },
      ]),
    ).toBe('late');
  });

  it('keeps an earlier proof of delivery that kept the status (F132-4)', () => {
    // The step departed at X on day 1; a POD that kept the status moved it to Y on day 2.
    expect(
      currentLocationOf([
        { ...at(1), locationId: 'x' },
        { ...at(2), locationId: 'y' },
      ]),
    ).toBe('y');
  });
});
