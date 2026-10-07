import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from './auth-user.js';
import {
  assertBranchAccess,
  branchScope,
  canAccessBranch,
  listBranchScope,
  reportBranchIds,
} from './branch-scope.js';

const user: AuthUser = {
  id: 'u',
  email: 'u@test',
  fullName: 'U',
  preferredLocale: 'ar',
  sessionId: 's',
  credentialStamp: 'c',
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

  it("a report covers the requested branch only when it is the user's, else all of theirs", () => {
    const two = { ...user, allowedBranchIds: ['dxb', 'pts'] };
    expect(reportBranchIds(two)).toEqual(['dxb', 'pts']);
    expect(reportBranchIds(two, 'pts')).toEqual(['pts']);
    expect(() => reportBranchIds(two, 'krt')).toThrow(ForbiddenException);
    expect(reportBranchIds({ ...user, allowedBranchIds: [] })).toEqual([]);
  });

  it('a list branch filter narrows to one of the user branches, never wider', () => {
    expect(listBranchScope(user)).toEqual({ branchId: { in: ['dxb'] } });
    expect(listBranchScope(user, 'dxb')).toEqual({ branchId: { in: ['dxb'] } });
    expect(() => listBranchScope(user, 'krt')).toThrow(ForbiddenException);
  });
});
