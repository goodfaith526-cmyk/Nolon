import { describe, expect, it } from 'vitest';
import { formatAmount } from './money';

describe('formatAmount', () => {
  it('groups the integer digits and keeps the fraction as written', () => {
    expect(formatAmount('1666666.67')).toBe('1,666,666.67');
    expect(formatAmount('1000')).toBe('1,000');
    expect(formatAmount('999.0001')).toBe('999.0001');
    expect(formatAmount('0')).toBe('0');
  });

  it('keeps the sign of a negative balance', () => {
    expect(formatAmount('-1234567.5')).toBe('-1,234,567.5');
  });

  it('leaves anything that is not a decimal string unchanged', () => {
    expect(formatAmount('')).toBe('');
    expect(formatAmount('abc')).toBe('abc');
    expect(formatAmount('1e5')).toBe('1e5');
  });
});
