import {
  GLOBAL_MODULES,
  NON_GRANTABLE_MODULES,
  ROLE_PERMISSIONS,
  isPermission,
  permissionModule,
  type Permission,
  type Role,
} from '@nolon/shared';

/**
 * Who may do what, per branch (docs/plans/03-permissions-screen.md, section 4). Built once per
 * request from the database (AccessLoader) and never changed after: a change of access raises
 * access_state.version, and every write transaction of the request refuses to run when the
 * version moved (access-lock.ts).
 */
export class Access {
  private readonly union: ReadonlySet<Permission>;

  constructor(
    /** access_state.version this was computed at, as text (a bigint). */
    readonly version: string,
    private readonly byBranch: ReadonlyMap<string, ReadonlySet<Permission>>,
  ) {
    const all = new Set<Permission>();
    for (const permissions of byBranch.values()) for (const p of permissions) all.add(p);
    this.union = all;
  }

  /** The same permissions in every one of `branchIds` (tests, and fixed setups). */
  static uniform(
    permissions: Iterable<Permission>,
    branchIds: readonly string[],
    version = '0',
  ): Access {
    const set = new Set(permissions);
    return new Access(version, new Map(branchIds.map((id) => [id, set])));
  }

  /**
   * Holds `permission` in `branchId`. A global module (GLOBAL_MODULES) is held when it is held in
   * any branch: its rows belong to no branch.
   */
  has(permission: Permission, branchId: string | null | undefined): boolean {
    if (GLOBAL_MODULES.includes(permissionModule(permission))) return this.union.has(permission);
    if (!branchId) return false;
    return this.byBranch.get(branchId)?.has(permission) ?? false;
  }

  /** Holds `permission` in at least one branch. */
  any(permission: Permission): boolean {
    return this.union.has(permission);
  }

  /** The branches where every one of `permissions` is held (all branches for none). */
  branchesWith(permissions: readonly Permission[]): string[] {
    return [...this.byBranch.keys()].filter((branchId) =>
      permissions.every((p) => this.has(p, branchId)),
    );
  }

  /** The branches this was computed for, in no particular order. */
  branchIds(): string[] {
    return [...this.byBranch.keys()];
  }

  /** Every permission held in some branch, sorted. */
  all(): Permission[] {
    return [...this.union].sort();
  }

  /** The permissions held in `branchId`, sorted (global modules included when held anywhere). */
  inBranch(branchId: string): Permission[] {
    return [...this.union].filter((p) => this.has(p, branchId)).sort();
  }
}

export type AccessEffectValue = 'ALLOW' | 'DENY';

/** The rows that decide one person's access, as loaded (AccessLoader). */
export interface AccessRows {
  version: string;
  /** user_roles: the person's system teams in every branch they work in. */
  roles: readonly Role[];
  /** The branches access is computed for: every branch for an all-branch role, else user_branches. */
  branchIds: readonly string[];
  /** Teams the rows below name, and every system team. */
  teams: readonly {
    id: string;
    systemRole: Role | null;
    restricted: boolean;
    isActive: boolean;
    changes: readonly { permission: string; effect: AccessEffectValue }[];
  }[];
  /** user_branch_teams of the person. */
  branchTeams: readonly { teamId: string; branchId: string; delegationId: string | null }[];
  /** user_branch_permissions of the person. */
  branchPermissions: readonly {
    branchId: string;
    permission: string;
    effect: AccessEffectValue;
    delegationId: string | null;
  }[];
  /** branch_blocked_permissions of the branches above. */
  blocked: readonly { branchId: string; permission: string }[];
  /**
   * The delegations the rows above came through. `live`: not revoked, and its delegate is active
   * and still works in its branch (else nothing it gave counts).
   */
  delegations: readonly {
    id: string;
    branchId: string;
    live: boolean;
    permissions: readonly string[];
  }[];
}

/** Every permission, for the Administrator team (locked: no change, block or deny applies). */
const ADMINISTRATOR = ROLE_PERMISSIONS.ADMINISTRATOR;

function grantable(permission: Permission): boolean {
  return !NON_GRANTABLE_MODULES.includes(permissionModule(permission));
}

/** A team's permissions: a system team's defaults with its changes, a new team's ALLOW rows. */
export function teamPermissions(team: AccessRows['teams'][number]): Set<Permission> {
  const result = new Set<Permission>(team.systemRole ? ROLE_PERMISSIONS[team.systemRole] : []);
  if (team.systemRole === 'ADMINISTRATOR') return result;
  if (!team.systemRole && !team.isActive) return new Set();
  for (const change of team.changes) {
    if (!isPermission(change.permission)) continue;
    if (change.effect === 'DENY') result.delete(change.permission);
    // A restricted team takes no added permission (also refused by a trigger).
    else if (!team.restricted && grantable(change.permission)) result.add(change.permission);
  }
  return result;
}

/**
 * effective(u, b) of plan 03 section 4:
 * (owner-given ∪ (delegated ∩ D(d))) − owner DENY − blocked(b) − non-grantable, per branch.
 * The Administrator role holds everything everywhere.
 */
export function computeAccess(rows: AccessRows): Access {
  const byBranch = new Map<string, Set<Permission>>();
  if (rows.roles.includes('ADMINISTRATOR')) {
    for (const branchId of rows.branchIds) byBranch.set(branchId, new Set(ADMINISTRATOR));
    return new Access(rows.version, byBranch);
  }

  const teams = new Map(rows.teams.map((t) => [t.id, t]));
  const permsOf = new Map<string, Set<Permission>>();
  const teamPerms = (teamId: string): Set<Permission> => {
    let perms = permsOf.get(teamId);
    if (!perms) {
      const team = teams.get(teamId);
      perms = team ? teamPermissions(team) : new Set();
      permsOf.set(teamId, perms);
    }
    return perms;
  };
  const systemTeams = rows.teams.filter((t) => t.systemRole && rows.roles.includes(t.systemRole));
  // A holder of a restricted role takes no other team or added permission (plan 03, F114-2).
  const restrictedHolder = rows.roles.some((r) =>
    rows.teams.some((t) => t.systemRole === r && t.restricted),
  );
  const delegations = new Map(rows.delegations.map((d) => [d.id, d]));
  const ceiling = (delegationId: string, branchId: string): ReadonlySet<string> | null => {
    const d = delegations.get(delegationId);
    if (!d || !d.live || d.branchId !== branchId) return null;
    return new Set(d.permissions);
  };

  for (const branchId of rows.branchIds) {
    const held = new Set<Permission>();
    for (const team of systemTeams) for (const p of teamPerms(team.id)) held.add(p);

    if (!restrictedHolder) {
      for (const row of rows.branchTeams) {
        if (row.branchId !== branchId || teams.get(row.teamId)?.restricted !== false) continue;
        const limit = row.delegationId === null ? null : ceiling(row.delegationId, branchId);
        if (row.delegationId !== null && !limit) continue;
        for (const p of teamPerms(row.teamId)) if (!limit || limit.has(p)) held.add(p);
      }
      for (const row of rows.branchPermissions) {
        if (row.branchId !== branchId || row.effect !== 'ALLOW') continue;
        if (!isPermission(row.permission)) continue;
        if (row.delegationId !== null) {
          const limit = ceiling(row.delegationId, branchId);
          if (!limit?.has(row.permission)) continue;
        }
        held.add(row.permission);
      }
    }

    // DENY rows come from the owner only (CHECK in the migration); ignore any other defensively.
    for (const row of rows.branchPermissions) {
      if (row.branchId === branchId && row.effect === 'DENY' && row.delegationId === null) {
        held.delete(row.permission as Permission);
      }
    }
    for (const row of rows.blocked) {
      if (row.branchId === branchId) held.delete(row.permission as Permission);
    }
    for (const p of held) if (!grantable(p)) held.delete(p);
    byBranch.set(branchId, held);
  }
  return new Access(rows.version, byBranch);
}

/** Where a permission held in a branch comes from (the permissions screen's "why"). */
export interface AccessSource {
  kind: 'ROLE' | 'TEAM' | 'ADDED' | 'DELEGATED';
  teamId?: string;
  delegationId?: string;
}

/**
 * The sources of every permission `computeAccess(rows)` holds in `branchId`, by the same rules.
 * A permission held has at least one source; one not held is not listed.
 */
export function explainAccess(
  rows: AccessRows,
  branchId: string,
): { permission: Permission; sources: AccessSource[] }[] {
  const held = computeAccess(rows).inBranch(branchId);
  const teams = new Map(rows.teams.map((t) => [t.id, t]));
  const sources = new Map<Permission, AccessSource[]>(held.map((p) => [p, []]));
  const add = (p: Permission, source: AccessSource) => sources.get(p)?.push(source);
  const restrictedHolder = rows.roles.some((r) =>
    rows.teams.some((t) => t.systemRole === r && t.restricted),
  );
  const live = new Map(
    rows.delegations
      .filter((d) => d.live && d.branchId === branchId)
      .map((d) => [d.id, new Set(d.permissions)]),
  );

  for (const team of rows.teams) {
    if (!team.systemRole || !rows.roles.includes(team.systemRole)) continue;
    for (const p of teamPermissions(team)) add(p, { kind: 'ROLE', teamId: team.id });
  }
  if (!restrictedHolder && !rows.roles.includes('ADMINISTRATOR')) {
    for (const row of rows.branchTeams) {
      const team = teams.get(row.teamId);
      if (row.branchId !== branchId || !team || team.restricted) continue;
      const limit = row.delegationId === null ? null : live.get(row.delegationId);
      if (row.delegationId !== null && !limit) continue;
      for (const p of teamPermissions(team)) {
        if (!limit) add(p, { kind: 'TEAM', teamId: team.id });
        else if (limit.has(p)) {
          add(p, { kind: 'DELEGATED', teamId: team.id, delegationId: row.delegationId! });
        }
      }
    }
    for (const row of rows.branchPermissions) {
      if (row.branchId !== branchId || row.effect !== 'ALLOW' || !isPermission(row.permission)) {
        continue;
      }
      if (row.delegationId === null) add(row.permission, { kind: 'ADDED' });
      else if (live.get(row.delegationId)?.has(row.permission)) {
        add(row.permission, { kind: 'DELEGATED', delegationId: row.delegationId });
      }
    }
  }
  return held.map((permission) => ({ permission, sources: sources.get(permission) ?? [] }));
}
