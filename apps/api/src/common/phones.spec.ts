import { describe, expect, it } from 'vitest';
import { internationalPhone, samePhone } from './phones.js';

describe('internationalPhone', () => {
  it('keeps +E.164 and reads 00 as +', () => {
    expect(internationalPhone('+249912345678')).toBe('+249912345678');
    expect(internationalPhone('00249912345678')).toBe('+249912345678');
    expect(internationalPhone(' +249 91-234-5678 ')).toBe('+249912345678');
  });
  it('guesses no country for local digits', () => {
    expect(internationalPhone('0912345678')).toBeNull();
    expect(internationalPhone('912345678')).toBeNull();
    expect(internationalPhone(null)).toBeNull();
  });
});

describe('samePhone', () => {
  it('compares digits', () => {
    expect(samePhone('+249912345678', '00249912345678')).toBe(true);
    expect(samePhone('+249912345678', '249912345678')).toBe(true);
    expect(samePhone('+249912345678', '+249912345679')).toBe(false);
  });
  it('never matches a missing number', () => {
    expect(samePhone(null, null)).toBe(false);
    expect(samePhone('', '')).toBe(false);
  });
});
