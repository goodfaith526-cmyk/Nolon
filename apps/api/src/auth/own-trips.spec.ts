import { permissionsForRoles, type Role } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from './auth-user.js';
import { limitedToOwnTrips } from './own-trips.js';

function user(roles: Role[]): AuthUser {
  return {
    id: 'u',
    email: 'u@example.com',
    fullName: 'U',
    preferredLocale: 'ar',
    sessionId: 's',
    credentialStamp: 'c',
    roles,
    permissions: new Set(permissionsForRoles(roles)),
    allBranches: false,
    allowedBranchIds: [],
  };
}

describe('limitedToOwnTrips', () => {
  it('limits a driver to their own trips', () => {
    expect(limitedToOwnTrips(user(['DRIVER']), 'shipments')).toBe(true);
    expect(limitedToOwnTrips(user(['DRIVER']), 'documents')).toBe(true);
  });

  it('does not limit when another role grants the module', () => {
    expect(limitedToOwnTrips(user(['DRIVER', 'OPERATIONS']), 'shipments')).toBe(false);
    expect(limitedToOwnTrips(user(['OPERATIONS']), 'shipments')).toBe(false);
  });

  it('does not apply to modules without the own-trips rule', () => {
    expect(limitedToOwnTrips(user(['DRIVER']), 'customers')).toBe(false);
  });
});
