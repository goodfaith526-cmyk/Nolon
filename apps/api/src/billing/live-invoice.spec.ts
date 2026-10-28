import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { isLiveInvoice } from './live-invoice.js';

const approved = (paid: string, credited: string) => ({
  status: 'APPROVED' as const,
  total: dec('100'),
  paidAmount: dec(paid),
  creditedAmount: dec(credited),
});

describe('isLiveInvoice', () => {
  it('a draft bills the shipment; a cancelled draft does not', () => {
    expect(isLiveInvoice({ ...approved('0', '0'), status: 'DRAFT' })).toBe(true);
    expect(isLiveInvoice({ ...approved('0', '0'), status: 'CANCELLED' })).toBe(false);
  });

  it('an approved invoice bills it until credit notes cover all of it', () => {
    expect(isLiveInvoice(approved('0', '0'))).toBe(true);
    expect(isLiveInvoice(approved('0', '99.99'))).toBe(true);
    expect(isLiveInvoice(approved('0', '100'))).toBe(false);
  });

  it('a paid or part-paid invoice keeps billing it, credited or not', () => {
    expect(isLiveInvoice(approved('100', '0'))).toBe(true);
    expect(isLiveInvoice(approved('40', '0'))).toBe(true);
    expect(isLiveInvoice(approved('40', '60'))).toBe(true);
  });
});
