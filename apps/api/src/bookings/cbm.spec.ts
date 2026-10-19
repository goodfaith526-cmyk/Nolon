import { cbmOf } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { cbmFromDimensions } from './cbm.js';

describe('cbmFromDimensions', () => {
  it('computes cubic metres for all pieces', () => {
    // A standard pallet 120 × 100 × 150 cm = 1.8 m³; ten of them = 18.
    expect(cbmFromDimensions(dec('120'), dec('100'), dec('150'), 10).toFixed()).toBe('18');
  });

  it('keeps decimal dimensions exact and rounds to 4 places', () => {
    expect(cbmFromDimensions(dec('33.3'), dec('33.3'), dec('33.3'), 1).toFixed()).toBe('0.0369');
    expect(cbmFromDimensions(dec('10.5'), dec('20.25'), dec('30'), 3).toFixed()).toBe('0.0191');
  });
});

describe('cbmOf (the form shows it as dimensions are typed)', () => {
  it('gives the value the API stores, to 4 places', () => {
    const cases: [string, string, string, number][] = [
      ['120', '100', '150', 10],
      ['33.3', '33.3', '33.3', 1],
      ['10.5', '20.25', '30', 3],
      ['0.01', '0.01', '0.01', 1],
      ['50', '50', '20', 1],
      ['1203.99', '235.01', '269.99', 999],
      ['1.5', '2.25', '3.75', 7],
    ];
    for (const [l, w, h, q] of cases) {
      const stored = cbmFromDimensions(dec(l), dec(w), dec(h), q).toFixed(4);
      expect(cbmOf(l, w, h, String(q)), `${l}×${w}×${h}×${q}`).toBe(stored);
    }
  });

  it('rounds half up', () => {
    // 50 × 50 × 0.02 cm = 50 cm³ = 0.00005 m³ → 0.0001.
    expect(cbmOf('50', '50', '0.02', '1')).toBe('0.0001');
    expect(cbmOf('49', '50', '0.02', '1')).toBe('0.0000');
  });

  it('is null until three dimensions and a whole quantity are given', () => {
    expect(cbmOf('120', '', '150', '1')).toBeNull();
    expect(cbmOf('120', '100', '150', '')).toBeNull();
    expect(cbmOf('120', '100', '150', '1.5')).toBeNull();
    expect(cbmOf('12,0', '100', '150', '1')).toBeNull();
    expect(cbmOf('1.234', '100', '150', '1')).toBeNull();
    expect(cbmOf('-1', '100', '150', '1')).toBeNull();
  });
});
