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

/**
 * The branches a report covers: the one requested (403 when it is not one of the user's) or every
 * branch the user may see. Cross-branch figures therefore exist only for users whose roles or
 * assignments give them several branches.
 */
export function reportBranchIds(user: AuthUser, branchId?: string | null): string[] {
  if (branchId) {
    assertBranchAccess(user, branchId);
    return [branchId];
  }
  return [...user.allowedBranchIds];
}

/**
 * Prisma `where` fragment for a list filtered on `branchId`: that branch (403 when it is not one of
 * the user's) or every branch the user may see. Never wider than `branchScope`.
 */
export function listBranchScope(
  user: AuthUser,
  branchId?: string | null,
): { branchId: { in: string[] } } {
  return { branchId: { in: reportBranchIds(user, branchId) } };
}
