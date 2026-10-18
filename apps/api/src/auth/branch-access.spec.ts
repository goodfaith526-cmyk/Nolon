import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from './auth-user.js';
import { requireBranchMemberInTx } from './branch-access.js';

const user: AuthUser = {
  id: '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0aff',
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

function txReturning(rows: unknown[]) {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  return { tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, queryRaw };
}

describe('the final branch check inside a write transaction', () => {
  it('passes while the membership row is stored, and locks it', async () => {
    const { tx, queryRaw } = txReturning([{ held: 1 }]);
    await requireBranchMemberInTx(tx, user, 'dxb');
    const sql = (queryRaw.mock.calls[0]?.[0] as readonly string[]).join('?');
    expect(sql).toContain('"user_branches"');
    expect(sql).toContain('FOR SHARE');
  });

  it('refuses (403) once the membership is gone, whatever the request loaded', async () => {
    const { tx } = txReturning([]);
    await expect(requireBranchMemberInTx(tx, user, 'dxb')).rejects.toThrow(ForbiddenException);
  });

  it('leaves every-branch roles as their request loaded them', async () => {
    const { tx, queryRaw } = txReturning([]);
    await requireBranchMemberInTx(tx, { ...user, allBranches: true }, 'dxb');
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
