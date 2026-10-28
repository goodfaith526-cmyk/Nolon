import type { CsBookingRequestCreate } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { contentHash, requestReference, stateOf } from './booking-requests.service.js';

const base: CsBookingRequestCreate = {
  originId: 'o',
  destinationId: 'd',
  category: 'C',
  quantity: '2',
  services: ['PICKUP', 'LAST_MILE'],
  senderName: 'S',
  consigneeName: 'R',
  consigneePhone: '+249900000000',
  handover: 'PICKUP',
  language: 'ar',
  idempotencyKey: 'key-00001',
};

describe('booking requests', () => {
  it('hashes the content, not the idempotency key, key order, service order or 2 vs 2.0', () => {
    const h = contentHash(base);
    expect(contentHash({ ...base, idempotencyKey: 'other-key' })).toBe(h);
    expect(contentHash({ ...base, services: ['LAST_MILE', 'PICKUP'] })).toBe(h);
    expect(contentHash({ ...base, quantity: '2.0' })).toBe(h);
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as CsBookingRequestCreate;
    expect(contentHash(reordered)).toBe(h);
    expect(contentHash({ ...base, quantity: '3' })).not.toBe(h);
    expect(contentHash({ ...base, requestedDate: '2030-01-01' })).not.toBe(h);
  });

  it('reads an undecided request past its time as expired', () => {
    const past = new Date(Date.now() - 1);
    const future = new Date(Date.now() + 60_000);
    expect(stateOf({ status: 'PENDING', expiresAt: past })).toBe('expired');
    expect(stateOf({ status: 'AWAITING_ROUTING', expiresAt: past })).toBe('expired');
    expect(stateOf({ status: 'AWAITING_ROUTING', expiresAt: future })).toBe('awaiting_routing');
    expect(stateOf({ status: 'APPROVED', expiresAt: past })).toBe('approved');
    expect(stateOf({ status: 'REJECTED', expiresAt: past })).toBe('rejected');
  });

  it('numbers requests BR-000001', () => {
    expect(requestReference(1n)).toBe('BR-000001');
    expect(requestReference(1234567n)).toBe('BR-1234567');
  });
});
