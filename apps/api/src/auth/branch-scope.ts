import { fieldRefusal } from '../common/validation.js';
import { ForbiddenException } from '@nestjs/common';
import type { Permission } from '@nolon/shared';
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

/**
 * The user narrowed to the branches where they hold every one of `permissions`, as the guard
 * narrows a route's user (plan 03, section 5.2): for a part of a page or list that needs another
 * permission than the route's. Never wider than the user passed in.
 */
export function withPermissions(user: AuthUser, ...permissions: Permission[]): AuthUser {
  const held = new Set(user.access.branchesWith(permissions));
  return { ...user, allowedBranchIds: user.allowedBranchIds.filter((id) => held.has(id)) };
}

/**
 * Plan 09d section 2: the branch a new record for a customer is written in, now that a customer
 * is tied to no branch. The branch asked for (403 unless the user holds `permission` there); else
 * the user's only branch with it; else the customer's branch of registration when the user holds
 * it there; else 400 BRANCH_REQUIRED. Callers that send no branch (the assistant's drafts) keep
 * the branch they had before 09d whenever the user may write there.
 */
export function workBranch(
  user: AuthUser,
  permission: Permission,
  given: string | null | undefined,
  homeBranchId: string | null,
): string {
  const writable = user.access
    .branchesWith([permission])
    .filter((id) => user.allowedBranchIds.includes(id));
  if (given) {
    if (!writable.includes(given)) throw new ForbiddenException('No access to this branch');
    return given;
  }
  if (writable.length === 1) return writable[0]!;
  if (homeBranchId !== null && writable.includes(homeBranchId)) return homeBranchId;
  throw fieldRefusal('BRANCH_REQUIRED', 'Choose the branch to write this in', ['branchId']);
}
