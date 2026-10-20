import { describe, expect, it } from 'vitest';
import {
  SHIPPING_MODES,
  hasRoadLeg,
  hasSeaLeg,
  isBranchCode,
  isCurrencyCodeFormat,
  isLocale,
  loadTypeOf,
  localeDirection,
  modeOfLegs,
} from './index.js';

describe('shared constants', () => {
  it('accepts only known branch codes', () => {
    expect(isBranchCode('DXB')).toBe(true);
    expect(isBranchCode('KRT')).toBe(true);
    expect(isBranchCode('dxb')).toBe(false);
    expect(isBranchCode('XXX')).toBe(false);
    expect(isBranchCode(1)).toBe(false);
  });

  it('checks only the shape of a currency code, not whether it exists', () => {
    expect(isCurrencyCodeFormat('SDG')).toBe(true);
    expect(isCurrencyCodeFormat('GBP')).toBe(true);
    expect(isCurrencyCodeFormat('sdg')).toBe(false);
    expect(isCurrencyCodeFormat('US')).toBe(false);
    expect(isCurrencyCodeFormat(840)).toBe(false);
  });

  it('maps locales to text direction', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });
});

describe('shipping mode legs (sea, road, or both)', () => {
  it('maps the two ticks to a mode and back', () => {
    expect(modeOfLegs(true, false)).toBe('SEA');
    expect(modeOfLegs(false, true)).toBe('ROAD');
    expect(modeOfLegs(true, true)).toBe('SEA_ROAD');
    expect(modeOfLegs(false, false)).toBeNull();
    for (const mode of SHIPPING_MODES) {
      expect(modeOfLegs(hasSeaLeg(mode), hasRoadLeg(mode))).toBe(mode);
    }
  });
});

describe('load type left unchosen (functional review B2)', () => {
  it('is FCL for a container and LCL otherwise, on a sea leg only', () => {
    expect(loadTypeOf('SEA', 'CONTAINER')).toBe('FCL');
    expect(loadTypeOf('SEA_ROAD', 'CONTAINER')).toBe('FCL');
    expect(loadTypeOf('SEA', 'PALLET')).toBe('LCL');
    expect(loadTypeOf('SEA', 'BARREL')).toBe('LCL');
    expect(loadTypeOf('SEA', 'GENERAL')).toBe('LCL');
    expect(loadTypeOf('ROAD', 'CONTAINER')).toBeNull();
    expect(loadTypeOf('ROAD', 'PALLET')).toBeNull();
  });
});
