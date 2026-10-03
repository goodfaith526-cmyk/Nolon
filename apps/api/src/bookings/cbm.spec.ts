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
