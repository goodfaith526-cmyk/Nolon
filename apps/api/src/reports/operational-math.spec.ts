import { describe, expect, it } from 'vitest';
import { averageDays, conversionRate } from './operational-math.js';

describe('conversionRate', () => {
  it('is part / whole as a percentage to 2 places, rounded half up', () => {
    expect(conversionRate(1, 4)).toBe('25.00');
    expect(conversionRate(2, 3)).toBe('66.67');
    expect(conversionRate(1, 3)).toBe('33.33');
    expect(conversionRate(1, 8)).toBe('12.50');
    expect(conversionRate(1, 800)).toBe('0.13');
    expect(conversionRate(3, 3)).toBe('100.00');
    expect(conversionRate(0, 5)).toBe('0.00');
  });

  it('has no rate without a base', () => {
    expect(conversionRate(0, 0)).toBeNull();
  });
});

describe('averageDays', () => {
  it('averages to 1 place, half up', () => {
    expect(averageDays(7, 2)).toBe('3.5');
    expect(averageDays(10, 3)).toBe('3.3');
    expect(averageDays(5, 3)).toBe('1.7');
    expect(averageDays(1, 4)).toBe('0.3');
    expect(averageDays(0, 4)).toBe('0.0');
    expect(averageDays(3, 0)).toBeNull();
  });
});
