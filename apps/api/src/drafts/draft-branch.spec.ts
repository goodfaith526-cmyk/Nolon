import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import { changedFields, evidenceAfterEdit } from './draft-evidence.js';
import { draftBranch, requestHash, withBranch } from './draft-rules.js';

const DXB = '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0a01';
const JED = '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0a02';

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
  allowedBranchIds: [DXB],
};

function refusalCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof BadRequestException) {
      return (error.getResponse() as { code?: unknown }).code;
    }
    throw error;
  }
  return null;
}

describe("a draft's branch (security context, never a business value)", () => {
  it("is the customer's or shipment's branch once the draft names one", () => {
    expect(draftBranch(user, null, DXB)).toBe(DXB);
    expect(draftBranch(user, undefined, DXB)).toBe(DXB);
    expect(draftBranch(user, DXB.toUpperCase(), DXB)).toBe(DXB);
  });

  it("refuses a parent's branch the user does not hold (a shipment shared with theirs)", () => {
    expect(() => draftBranch(user, null, JED)).toThrow(ForbiddenException);
    expect(() => draftBranch(user, JED, JED)).toThrow(ForbiddenException);
  });

  it("refuses a branch given that is not the customer's or shipment's", () => {
    expect(refusalCode(() => draftBranch(user, DXB, JED))).toBe('BRANCH_MISMATCH');
  });

  it('with no customer or shipment yet, is the branch given, one of the user branches', () => {
    expect(draftBranch(user, DXB.toUpperCase(), null)).toBe(DXB);
    expect(refusalCode(() => draftBranch(user, null, null))).toBe('BRANCH_REQUIRED');
    expect(refusalCode(() => draftBranch(user, '', null))).toBe('BRANCH_REQUIRED');
    expect(() => draftBranch(user, JED, null)).toThrow(ForbiddenException);
  });

  it('keeps the hash of a request that names no branch as it was', () => {
    const hash = requestHash({ a: 1 });
    expect(withBranch(hash, null)).toBe(hash);
    expect(withBranch(hash, undefined)).toBe(hash);
    expect(withBranch(hash, DXB)).not.toBe(hash);
    expect(withBranch(hash, DXB.toUpperCase())).toBe(withBranch(hash, DXB));
    expect(withBranch(hash, JED)).not.toBe(withBranch(hash, DXB));
  });
});

describe("the staff member's words after a person's edit", () => {
  const stored = [
    { field: 'amount', quote: 'ألف' },
    { field: 'customerId', quote: 'أحمد' },
    { field: 'lines[0].quantity', quote: 'اتنين' },
    { field: 'linesNote', quote: 'x' },
  ];

  it('drops the words of each value the person changed, a line value with its lines', () => {
    expect(evidenceAfterEdit(stored, ['amount', 'lines'])).toEqual([
      { field: 'customerId', quote: 'أحمد' },
      { field: 'linesNote', quote: 'x' },
    ]);
    expect(evidenceAfterEdit(stored, [])).toEqual(stored);
    expect(evidenceAfterEdit(null, ['amount'])).toEqual([]);
  });

  it('counts a value cleared (null) as changed, and one left out as not', () => {
    expect(changedFields({ amount: null, currency: undefined, notes: 'n' })).toEqual([
      'amount',
      'notes',
    ]);
  });
});
