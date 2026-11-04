import type { AuthMeResponse, Permission } from '@nolon/shared';

type MyBranch = AuthMeResponse['branches'][number];

/**
 * The user's branch when they have exactly one (functional review B7): a form then sends it
 * without asking. Only a convenience: the API checks the branch on every save, so a branch taken
 * from the user meanwhile is refused there, and the form shows that refusal.
 */
export function onlyBranch(me: Pick<AuthMeResponse, 'branches'>): MyBranch | undefined {
  return me.branches.length === 1 ? me.branches[0] : undefined;
}

/**
 * Today in the branch a document is for (functional review C9): the branch's local date from
 * /auth/me, not the browser's clock nor the user's first branch. '' when the branch is not one of
 * the user's, so the person types the date.
 */
export function branchToday(me: Pick<AuthMeResponse, 'branches'>, branchId: string): string {
  return me.branches.find((b) => b.id === branchId)?.today ?? '';
}

/** The default currency of one of the user's branches; '' when it is not one of theirs. */
export function branchCurrency(me: Pick<AuthMeResponse, 'branches'>, branchId: string): string {
  return me.branches.find((b) => b.id === branchId)?.defaultCurrency ?? '';
}

/**
 * The one date the given branches share as today, or '' when they differ (or there are none):
 * for a record that belongs to no branch, a date is suggested only when no branch disagrees.
 */
export function commonToday(branches: readonly Pick<MyBranch, 'today'>[]): string {
  const days = new Set(branches.map((b) => b.today));
  return days.size === 1 ? (branches[0]?.today ?? '') : '';
}

/**
 * Plan 09f: the user's branches where they hold `permission` (from the per-branch lists; all their
 * branches when the session has none). A new document for a customer is written in one of them,
 * since a customer is of no branch.
 */
export function writableBranches(
  me: Pick<AuthMeResponse, 'branches' | 'branchPermissions'>,
  permission: Permission,
): MyBranch[] {
  if (!me.branchPermissions) return [...me.branches];
  const held = new Set(
    me.branchPermissions.filter((b) => b.permissions.includes(permission)).map((b) => b.branchId),
  );
  return me.branches.filter((b) => held.has(b.id));
}
