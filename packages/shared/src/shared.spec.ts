import { describe, expect, it } from 'vitest';
import { isBranchCode, isCurrencyCodeFormat, isLocale, localeDirection } from './index.js';

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
