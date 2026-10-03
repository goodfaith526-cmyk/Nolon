import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from './auth-user.js';
import { assertBranchAccess, branchScope, canAccessBranch } from './branch-scope.js';

const user: AuthUser = {
  id: 'u',
  email: 'u@test',
  fullName: 'U',
  preferredLocale: 'ar',
  sessionId: 's',
  roles: ['SALES'],
  permissions: new Set(),
  allBranches: false,
  allowedBranchIds: ['dxb'],
};

describe('branch scope', () => {
  it('builds a filter from the user, not from input', () => {
    expect(branchScope(user)).toEqual({ branchId: { in: ['dxb'] } });
  });

  it('allows only the user branches', () => {
    expect(canAccessBranch(user, 'dxb')).toBe(true);
    expect(canAccessBranch(user, 'krt')).toBe(false);
    expect(() => assertBranchAccess(user, 'krt')).toThrow(ForbiddenException);
    expect(() => assertBranchAccess(user, 'dxb')).not.toThrow();
  });

  it('an empty branch list allows nothing', () => {
    const none = { ...user, allowedBranchIds: [] };
    expect(branchScope(none)).toEqual({ branchId: { in: [] } });
    expect(canAccessBranch(none, 'dxb')).toBe(false);
  });
});
