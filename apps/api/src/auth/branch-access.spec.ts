import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from './auth-user.js';
import { requireBranchMemberInTx } from './branch-access.js';
import { Access } from '../access-control/access.js';

const user: AuthUser = {
  id: '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0aff',
  email: 'u@test',
  fullName: 'U',
  preferredLocale: 'ar',
  sessionId: 's',
  credentialStamp: 'c',
  roles: ['SALES'],
  access: Access.uniform([], ['dxb']),
  allBranches: false,
  allowedBranchIds: ['dxb'],
};

/** A transaction whose raw queries answer `roles`, then `memberships`. */
function tx(roles: string[], memberships: unknown[]) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce(roles.map((role) => ({ role })))
    .mockResolvedValueOnce(memberships);
  return { tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, queryRaw };
}

const sqlOf = (queryRaw: ReturnType<typeof vi.fn>, call: number) =>
  (queryRaw.mock.calls[call]?.[0] as readonly string[]).join('?');

describe('the final branch check inside a write transaction', () => {
  it('locks the roles, then the membership row, and passes while it is stored', async () => {
    const { tx: t, queryRaw } = tx(['SALES'], [{ held: 1 }]);
    await requireBranchMemberInTx(t, user, 'dxb');
    expect(sqlOf(queryRaw, 0)).toContain('"user_roles"');
    expect(sqlOf(queryRaw, 0)).toContain('FOR SHARE');
    expect(sqlOf(queryRaw, 1)).toContain('"user_branches"');
    expect(sqlOf(queryRaw, 1)).toContain('FOR SHARE');
  });

  it('refuses (403) once the membership is gone, whatever the request loaded', async () => {
    const { tx: t } = tx(['SALES'], []);
    await expect(requireBranchMemberInTx(t, user, 'dxb')).rejects.toThrow(ForbiddenException);
  });

  it('passes on an every-branch role still stored, without a membership', async () => {
    for (const role of ['ADMINISTRATOR', 'MANAGEMENT']) {
      const { tx: t, queryRaw } = tx(['SALES', role], []);
      await requireBranchMemberInTx(t, { ...user, allowedBranchIds: [] }, 'dxb');
      expect(queryRaw).toHaveBeenCalledTimes(1);
    }
  });

  it('never trusts the request’s every-branch flag: a removed role falls to the membership', async () => {
    const { tx: t } = tx(['SALES'], []);
    await expect(
      requireBranchMemberInTx(
        t,
        { ...user, roles: ['SALES', 'MANAGEMENT'], allBranches: true },
        'dxb',
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
