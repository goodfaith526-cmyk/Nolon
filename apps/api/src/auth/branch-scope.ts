import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from './auth-user.js';

/**
 * Branch scoping (AGENTS.md rule 2). Services take the branch list from the authenticated user,
 * never from an unchecked request field.
 */

/** Prisma `where` fragment for branch-owned rows: `{ branchId: { in: [...] } }`. */
export function branchScope(user: AuthUser): { branchId: { in: string[] } } {
  return { branchId: { in: [...user.allowedBranchIds] } };
}

export function canAccessBranch(user: AuthUser, branchId: string): boolean {
  return user.allowedBranchIds.includes(branchId);
}

/** Throws 403 when a requested branch is outside the user's branches. */
export function assertBranchAccess(user: AuthUser, branchId: string): void {
  if (!canAccessBranch(user, branchId)) {
    throw new ForbiddenException('No access to this branch');
  }
}
