import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from './auth-user.js';

/**
 * The final branch check of a write, inside its transaction (AGENTS.md rule 2): the user still
 * holds `branchId` as stored now, not only as their request loaded it. The membership row is
 * locked (FOR SHARE), so a concurrent revocation either commits first (this write is refused,
 * 403) or waits for this write to commit. A user whose roles give every branch (Administrator,
 * Management) holds no membership rows; their access stays as their request loaded it.
 */
export async function requireBranchMemberInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  branchId: string,
): Promise<void> {
  if (user.allBranches) return;
  const rows = await tx.$queryRaw<{ held: number }[]>`
    SELECT 1 AS "held" FROM "user_branches"
    WHERE "user_id" = ${user.id}::uuid AND "branch_id" = ${branchId}::uuid
    FOR SHARE`;
  if (rows.length === 0) throw new ForbiddenException('No access to this branch');
}
