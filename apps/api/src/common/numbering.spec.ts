import { describe, expect, it } from 'vitest';
import { formatDocumentNumber, formatShortNumber } from './numbering.js';

describe('document numbers', () => {
  it('gives bookings, quotations and customers the short form, five digits and no year', () => {
    expect(formatShortNumber('BK', 1n)).toBe('BK00001');
    expect(formatShortNumber('QT', 42n)).toBe('QT00042');
    expect(formatShortNumber('CS', 99999n)).toBe('CS99999');
  });

  it('grows past five digits instead of wrapping', () => {
    expect(formatShortNumber('BK', 100000n)).toBe('BK100000');
  });

  it('keeps the long form for the other documents', () => {
    expect(formatDocumentNumber('SHP', 7n, '2026')).toBe('NOL-SHP-2026-000007');
    expect(formatDocumentNumber('SUP', 7n)).toBe('NOL-SUP-000007');
  });
});
