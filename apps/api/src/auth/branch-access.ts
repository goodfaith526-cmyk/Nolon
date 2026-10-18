import { ForbiddenException } from '@nestjs/common';
import { type Role, hasAllBranchAccess } from '@nolon/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from './auth-user.js';

/**
 * The final branch check of a write, inside its transaction (AGENTS.md rule 2): the user still
 * holds `branchId` as stored now, not only as their request loaded it. Never decided from the
 * request's own view of the user (`allBranches`, `allowedBranchIds`):
 * - the user's role rows are read and locked first (FOR SHARE): a role that gives every branch
 *   (Administrator, Management) still held passes;
 * - otherwise their membership row of `branchId` is read and locked (FOR SHARE), and without it
 *   the write is refused (403).
 * A concurrent change of either commits first (and is seen here) or waits for this write to
 * commit. The locks are taken in the order a user edit writes them (roles, then branches), so
 * the two never wait on each other in a cycle.
 */
export async function requireBranchMemberInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  branchId: string,
): Promise<void> {
  const roles = await tx.$queryRaw<{ role: Role }[]>`
    SELECT "role"::text AS "role" FROM "user_roles"
    WHERE "user_id" = ${user.id}::uuid
    ORDER BY "role"
    FOR SHARE`;
  if (hasAllBranchAccess(roles.map((r) => r.role))) return;
  const rows = await tx.$queryRaw<{ held: number }[]>`
    SELECT 1 AS "held" FROM "user_branches"
    WHERE "user_id" = ${user.id}::uuid AND "branch_id" = ${branchId}::uuid
    FOR SHARE`;
  if (rows.length === 0) throw new ForbiddenException('No access to this branch');
}
