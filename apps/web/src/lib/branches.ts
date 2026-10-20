import type { AuthMeResponse } from '@nolon/shared';

type MyBranch = AuthMeResponse['branches'][number];

/**
 * The user's branch when they have exactly one (functional review B7): a form then sends it
 * without asking. Only a convenience: the API checks the branch on every save, so a branch taken
 * from the user meanwhile is refused there, and the form shows that refusal.
 */
export function onlyBranch(me: Pick<AuthMeResponse, 'branches'>): MyBranch | undefined {
  return me.branches.length === 1 ? me.branches[0] : undefined;
}
