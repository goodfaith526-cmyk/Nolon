import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import { listScope, pageWhere, reviewDraftItem } from './drafts.service.js';

// Functional review هـ2: a page of the reviewers' list, never "my drafts".
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
  allowedBranchIds: [],
};

describe("a page of the reviewers' list", () => {
  const before = new Date('2026-10-12T10:00:00Z');
  const beforeId = '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0a01';

  it('starts after the cursor, a tie on the time broken by the id, under AND', () => {
    expect(pageWhere({ before, beforeId, limit: 20 })).toEqual({
      AND: [{ OR: [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: beforeId } }] }],
    });
    expect(pageWhere({ limit: 20 })).toEqual({});
  });

  it('never filters on who the drafts were made for; "my drafts" always does', () => {
    const page = listScope(user, undefined, { limit: 5 });
    expect(page).toEqual({ where: {}, take: 5 });
    const mine = listScope(user, { agentClientId: null, limit: 7 }, { limit: 5 });
    expect(mine).toEqual({ where: { createdById: 'u' }, take: 7 });
    expect(listScope(user, undefined, undefined)).toEqual({ where: {}, take: 200 });
  });

  it('counts what a draft misses and keeps whether the reviewer may decide it', () => {
    const item = reviewDraftItem('invoice', {
      id: 'd1',
      branchId: 'b1',
      subject: 'SH-1',
      status: 'DRAFT',
      version: 1,
      expiresAt: '2026-10-20T00:00:00.000Z',
      createdAt: '2026-10-18T00:00:00.000Z',
      createdByName: 'Staff',
      decidedByName: null,
      decidedAt: null,
      decidedFromAssistant: false,
      rejectReason: null,
      actions: { canEdit: true, canDecide: false },
      replacesDraftId: null,
      missingFields: ['currency', 'dueDate'],
    });
    expect(item).toMatchObject({
      kind: 'invoice',
      missingCount: 2,
      reviewPath: '/drafts/invoices/d1',
      canDecide: false,
    });
  });
});
