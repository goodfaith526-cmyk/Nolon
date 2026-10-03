import { describe, expect, it } from 'vitest';
import { isBranchCode, isCurrencyCode, isLocale, localeDirection } from './index.js';

describe('shared constants', () => {
  it('accepts only known branch codes', () => {
    expect(isBranchCode('DXB')).toBe(true);
    expect(isBranchCode('KRT')).toBe(true);
    expect(isBranchCode('dxb')).toBe(false);
    expect(isBranchCode('XXX')).toBe(false);
    expect(isBranchCode(1)).toBe(false);
  });

  it('accepts only supported currencies', () => {
    expect(isCurrencyCode('SDG')).toBe(true);
    expect(isCurrencyCode('GBP')).toBe(false);
  });

  it('maps locales to text direction', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });
});
