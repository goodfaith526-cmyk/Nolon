import { describe, expect, it } from 'vitest';
import { pairedWithOpenBooking } from './customer-drafts.service.js';

describe('customer drafts: replacing one proposed with a booking', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const later = new Date('2026-10-19T10:00:00Z');
  const earlier = new Date('2026-10-05T10:00:00Z');

  it('is replaced alone when no booking for a new customer goes with it', () => {
    expect(pairedWithOpenBooking(null, now)).toBe(false);
  });

  it('is not replaced alone while its booking draft is open', () => {
    expect(pairedWithOpenBooking({ state: 'DRAFT', expiresAt: later }, now)).toBe(true);
  });

  it('is replaced alone once its booking draft is decided or expired', () => {
    expect(pairedWithOpenBooking({ state: 'REJECTED', expiresAt: later }, now)).toBe(false);
    expect(pairedWithOpenBooking({ state: 'APPROVED', expiresAt: later }, now)).toBe(false);
    expect(pairedWithOpenBooking({ state: 'DRAFT', expiresAt: earlier }, now)).toBe(false);
  });
});
