import { ALERT_KINDS, permissionsForRoles, type Role } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import { concerns } from './alert-rules.js';

function user(roles: Role[]): AuthUser {
  return {
    id: 'u',
    email: 'u@example.com',
    fullName: 'U',
    preferredLocale: 'ar',
    sessionId: 's',
    roles,
    permissions: new Set(permissionsForRoles(roles)),
    allBranches: false,
    allowedBranchIds: [],
  };
}

const kindsOf = (roles: Role[]) => ALERT_KINDS.filter((kind) => concerns(user(roles), kind));

describe('which alerts concern a user', () => {
  it('follows what each role may see (annex A)', () => {
    expect(kindsOf(['ADMINISTRATOR'])).toEqual([...ALERT_KINDS]);
    expect(kindsOf(['FINANCE'])).toEqual([
      'SHIPMENT_PAST_ETA',
      'INVOICE_OVERDUE',
      'CUSTOMS_STALLED',
      'STORAGE_EXCEEDED',
      'TRIP_LATE',
    ]);
    expect(kindsOf(['WAREHOUSE'])).toEqual(['SHIPMENT_PAST_ETA', 'STORAGE_EXCEEDED', 'TRIP_LATE']);
    expect(kindsOf(['CUSTOMS'])).toEqual([
      'SHIPMENT_PAST_ETA',
      'CUSTOMS_STALLED',
      'STORAGE_EXCEEDED',
    ]);
  });

  it('gives a driver only their late trips, unless another role shows them shipments', () => {
    expect(kindsOf(['DRIVER'])).toEqual(['TRIP_LATE']);
    expect(kindsOf(['DRIVER', 'WAREHOUSE'])).toEqual([
      'SHIPMENT_PAST_ETA',
      'STORAGE_EXCEEDED',
      'TRIP_LATE',
    ]);
  });
});
