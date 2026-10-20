import { permissionsForRoles } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import {
  notPairedWithOpenBooking,
  pairedWithOpenBooking,
  reviewsWithBooking,
} from './customer-drafts.service.js';

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

// Functional review هـ1: the "new customers" list leaves out a customer draft waiting on its
// open booking only for a reviewer who approves both from the booking's screen.
describe('customer drafts: the review list and the booking for a new customer', () => {
  const user = (roles: AuthUser['roles'], agent = false): AuthUser => ({
    id: 'u',
    email: 'u@test',
    fullName: 'U',
    preferredLocale: 'ar',
    sessionId: 's',
    credentialStamp: 'c',
    roles,
    permissions: new Set(permissionsForRoles(roles)),
    allBranches: false,
    allowedBranchIds: [],
    ...(agent ? { agent: { tokenId: 't', clientId: 'c' } } : {}),
  });

  it('is approved with its booking by who books and adds customers', () => {
    expect(reviewsWithBooking(user(['SALES']))).toBe(true);
    expect(reviewsWithBooking(user(['ADMINISTRATOR']))).toBe(true);
  });

  it('stays in the list of who cannot do both, and of the assistant', () => {
    // A branch manager adds customers but does not create bookings; operations the other way.
    expect(reviewsWithBooking(user(['BRANCH_MANAGER']))).toBe(false);
    expect(reviewsWithBooking(user(['OPERATIONS']))).toBe(false);
    expect(reviewsWithBooking(user(['SALES'], true))).toBe(false);
  });

  it('is hidden only while its booking draft is open', () => {
    const now = new Date('2026-10-12T10:00:00Z');
    expect(notPairedWithOpenBooking(now)).toEqual({
      NOT: { newCustomerBookingDraft: { is: { state: 'DRAFT', expiresAt: { gt: now } } } },
    });
  });
});
