import type {
  CustomerDraftRequest,
  NewCustomerBookingDraftCustomer,
  NewCustomerBookingRequest,
} from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { draftEvidencePaths } from '../drafts/draft-evidence.js';
import { withReplaced } from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { evidenceLine } from './new-customer-booking-drafts.controller.js';
import {
  CUSTOMER_APPROVED_REFUSAL,
  CUSTOMER_CLOSED_REFUSAL,
  bookingRequestOf,
  customerNotReady,
  requireReplaceablePair,
  newCustomerBookingHash,
  splitEvidence,
  storedRequest,
} from './new-customer-booking-drafts.service.js';

const BRANCH = '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0a01';
const customer: CustomerDraftRequest = { kind: 'INDIVIDUAL', name: 'Amna', phone: '+249912345678' };
const booking: NewCustomerBookingRequest = {
  originLocationId: 'A5D3F1C2-1111-4222-8333-944455556666',
  destinationLocationId: 'b5d3f1c2-1111-4222-8333-944455556667',
  mode: 'SEA',
  loadType: 'FCL',
  cargoType: 'CONTAINER',
  services: ['MAIN_FREIGHT', 'CUSTOMS', 'MAIN_FREIGHT'],
  items: [{ cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 2, weightKg: '1500.50' }],
};

describe('bookings for a new customer: the words', () => {
  it("keeps the customer's words for the customer draft and the rest for the booking", () => {
    const words = splitEvidence([
      { field: 'name', quote: 'اسمها آمنة' },
      { field: 'items[0].quantity', quote: '2 containers' },
      { field: 'branchId', quote: 'from Dubai' },
      { field: 'destinationLocationId', quote: 'to Port Sudan' },
    ]);
    expect(words.customer.map((e) => e.field)).toEqual(['name', 'branchId']);
    expect(words.booking.map((e) => e.field)).toEqual([
      'items[0].quantity',
      'destinationLocationId',
    ]);
  });

  it('accepts a line path only where the kind allows it', () => {
    const schema = draftEvidencePaths((f) => f === 'name' || evidenceLine(f) !== null, 10);
    expect(schema.safeParse([{ field: 'items[3].weightKg', quote: '3 t' }]).success).toBe(true);
    expect(schema.safeParse([{ field: 'items[3].unitPrice', quote: 'x' }]).success).toBe(false);
    expect(schema.safeParse([{ field: 'items[0]', quote: 'x' }]).success).toBe(false);
    expect(schema.safeParse([{ field: 'items[0].quantity; drop', quote: 'x' }]).success).toBe(
      false,
    );
    expect(evidenceLine('items[12].volumeCbm')).toBe(12);
    expect(evidenceLine('originLocationId')).toBeNull();
  });
});

describe('bookings for a new customer: the stored request', () => {
  it('stores measurements as canonical decimal strings and services without repeats', () => {
    const stored = storedRequest(booking);
    expect(stored).toMatchObject({
      originLocationId: 'a5d3f1c2-1111-4222-8333-944455556666',
      cargoDescription: null,
      services: ['MAIN_FREIGHT', 'CUSTOMS'],
      items: [{ weightKg: '1500.5', volumeCbm: null, description: null }],
    });
    expect(typeof stored.items[0]?.weightKg).toBe('string');
    const json = JSON.parse(JSON.stringify(stored)) as Prisma.JsonValue;
    expect(bookingRequestOf({ id: 'x', request: json })).toEqual(stored);
    expect(() => bookingRequestOf({ id: 'x', request: { items: 3 } })).toThrow();
  });

  it('hashes equal requests equally and any change otherwise', () => {
    const hash = newCustomerBookingHash(BRANCH, customer, booking);
    const sameValue = {
      ...booking,
      services: ['CUSTOMS' as const, 'MAIN_FREIGHT' as const],
      items: [{ ...booking.items[0]!, weightKg: '1500.500' }],
    };
    expect(newCustomerBookingHash(BRANCH.toUpperCase(), customer, sameValue)).toBe(hash);
    expect(
      newCustomerBookingHash(BRANCH, customer, {
        ...booking,
        items: [{ ...booking.items[0]!, weightKg: '1500.51' }],
      }),
    ).not.toBe(hash);
    expect(
      newCustomerBookingHash(BRANCH, { ...customer, phone: '+249912345679' }, booking),
    ).not.toBe(hash);
    expect(
      newCustomerBookingHash(BRANCH, customer, booking, [{ field: 'name', quote: 'Amna' }]),
    ).not.toBe(hash);
    expect(
      newCustomerBookingHash(BRANCH, customer, booking, [
        { field: 'items[0].quantity', quote: '2' },
      ]),
    ).not.toBe(hash);
  });
});

describe('bookings for a new customer: approval waits for the customer', () => {
  const linked = (
    status: NewCustomerBookingDraftCustomer['status'],
    customerId: string | null = null,
  ): NewCustomerBookingDraftCustomer => ({
    draftId: 'd',
    status,
    name: 'Amna',
    phone: '+249912345678',
    customerId,
    customerNumber: null,
  });

  it('is ready only once the customer draft is approved', () => {
    expect(customerNotReady(linked('APPROVED', 'c'))).toBeNull();
    expect(customerNotReady(linked('DRAFT'))).toMatch(/Approve the new customer first/);
    expect(customerNotReady(linked('REJECTED'))).toMatch(/rejected/);
    expect(customerNotReady(linked('EXPIRED'))).toMatch(/expired/);
  });
});

describe('bookings for a new customer: replacing a pair', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const later = new Date('2026-10-19T10:00:00Z');
  const earlier = new Date('2026-10-05T10:00:00Z');
  const open = { state: 'DRAFT' as const, expiresAt: later, version: 1 };

  it('replaces a pair whose booking draft and customer draft are both open', () => {
    expect(() => requireReplaceablePair(open, open, now)).not.toThrow();
    expect(() => requireReplaceablePair({ ...open, version: 3 }, open, now)).not.toThrow();
  });

  it('refuses a booking draft already decided or expired', () => {
    for (const booking of [
      { ...open, state: 'APPROVED' as const },
      { ...open, state: 'REJECTED' as const },
    ]) {
      expect(() => requireReplaceablePair(booking, open, now)).toThrow(/already decided/);
    }
    expect(() => requireReplaceablePair({ ...open, expiresAt: earlier }, open, now)).toThrow(
      /expired/,
    );
  });

  it('refuses a pair whose customer is approved: a new pair would add a second customer', () => {
    expect(() =>
      requireReplaceablePair(open, { ...open, state: 'APPROVED', version: 2 }, now),
    ).toThrow(CUSTOMER_APPROVED_REFUSAL);
  });

  it('refuses a pair whose customer draft was rejected or expired', () => {
    expect(() =>
      requireReplaceablePair(open, { ...open, state: 'REJECTED', version: 2 }, now),
    ).toThrow(CUSTOMER_CLOSED_REFUSAL);
    expect(() => requireReplaceablePair(open, { ...open, expiresAt: earlier }, now)).toThrow(
      CUSTOMER_CLOSED_REFUSAL,
    );
  });

  it('binds the hash of a replacement to the draft it replaces', () => {
    const base = newCustomerBookingHash(BRANCH, customer, booking);
    const a = withReplaced(base, 'A5D3F1C2-1111-4222-8333-944455550001');
    expect(a).not.toBe(base);
    expect(withReplaced(base, 'a5d3f1c2-1111-4222-8333-944455550001')).toBe(a);
    expect(withReplaced(base, 'a5d3f1c2-1111-4222-8333-944455550002')).not.toBe(a);
  });
});
