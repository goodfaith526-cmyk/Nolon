import { hasAllBranchAccess, type Role } from '@nolon/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { type Access, type AccessRows, computeAccess } from './access.js';

type Db = Pick<
  Prisma.TransactionClient,
  | 'accessState'
  | 'branch'
  | 'team'
  | 'userBranchTeam'
  | 'userBranchPermission'
  | 'branchBlockedPermission'
  | 'branchDelegation'
>;

/**
 * Loads the rows that decide a person's access (plan 03, section 4) and computes it. `roles` and
 * `memberBranchIds` are the person's user_roles and user_branches, already loaded by the caller
 * (the session, or a transaction that locked them).
 */
export async function loadAccess(
  db: Db,
  userId: string,
  roles: readonly Role[],
  memberBranchIds: readonly string[],
): Promise<Access> {
  return computeAccess(await loadAccessRows(db, userId, roles, memberBranchIds));
}

/** The rows `loadAccess` computes from (the permissions screen explains them). */
export async function loadAccessRows(
  db: Db,
  userId: string,
  roles: readonly Role[],
  memberBranchIds: readonly string[],
): Promise<AccessRows> {
  const [state, branchIds, branchTeams, branchPermissions] = await Promise.all([
    db.accessState.findUniqueOrThrow({ where: { id: 1 }, select: { version: true } }),
    hasAllBranchAccess([...roles])
      ? db.branch.findMany({ select: { id: true } }).then((rows) => rows.map((b) => b.id))
      : Promise.resolve([...memberBranchIds]),
    db.userBranchTeam.findMany({
      where: { userId },
      select: { teamId: true, branchId: true, delegationId: true },
    }),
    db.userBranchPermission.findMany({
      where: { userId },
      select: { branchId: true, permission: true, effect: true, delegationId: true },
    }),
  ]);
  const delegationIds = [
    ...new Set(
      [...branchTeams, ...branchPermissions]
        .map((r) => r.delegationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const [teams, blocked, delegations] = await Promise.all([
    db.team.findMany({
      where: {
        OR: [{ systemRole: { not: null } }, { id: { in: branchTeams.map((t) => t.teamId) } }],
      },
      select: {
        id: true,
        systemRole: true,
        restricted: true,
        isActive: true,
        permissionChanges: { select: { permission: true, effect: true } },
      },
    }),
    db.branchBlockedPermission.findMany({
      where: { branchId: { in: branchIds } },
      select: { branchId: true, permission: true },
    }),
    delegationIds.length === 0
      ? Promise.resolve([])
      : db.branchDelegation.findMany({
          where: { id: { in: delegationIds } },
          select: {
            id: true,
            branchId: true,
            revokedAt: true,
            delegate: {
              select: {
                isActive: true,
                branches: { select: { branchId: true } },
              },
            },
            permissions: { select: { permission: true } },
          },
        }),
  ]);
  const rows: AccessRows = {
    version: state.version.toString(),
    roles,
    branchIds,
    teams: teams.map((t) => ({
      id: t.id,
      systemRole: t.systemRole,
      restricted: t.restricted,
      isActive: t.isActive,
      changes: t.permissionChanges,
    })),
    branchTeams,
    branchPermissions,
    blocked,
    delegations: delegations.map((d) => ({
      id: d.id,
      branchId: d.branchId,
      live:
        d.revokedAt === null &&
        d.delegate.isActive &&
        // A member of the branch (user_branches), as when the delegation was made.
        d.delegate.branches.some((b) => b.branchId === d.branchId),
      permissions: d.permissions.map((p) => p.permission),
    })),
  };
  return rows;
}
