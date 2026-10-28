import type { Permission, PermissionAction, PermissionModule, Role } from './auth.js';

/**
 * The permissions screen (docs/plans/03-permissions-screen.md, sections 2 and 6): teams, branch
 * limits, per-person access per branch, and delegation to a person of a branch. The API computes
 * everything; the screens show these shapes and send the requests below.
 */

/** A team: a role's system team (`systemRole`) or a team the owner added. */
export interface AccessTeamDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  /** The role this team is, for a system team; null for a team the owner added. */
  systemRole: Role | null;
  /** Driver and Outlet Staff: given through the role only, never widened. */
  restricted: boolean;
  isActive: boolean;
  /** The team's permissions now, sorted. */
  permissions: Permission[];
  /** A system team's permissions in the code (PERMISSION_MATRIX); null for an added team. */
  defaults: Permission[] | null;
}

export interface AccessBranchDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
}

/** GET /access-control/catalog: what the owner's screen offers. */
export interface AccessCatalogDto {
  /**
   * access_state.version this was read at. Every change sends it back as `expectedVersion` and
   * is refused (409) when any change of access came in between: reload and redo (F118-3).
   */
  version: string;

  modules: PermissionModule[];
  actions: PermissionAction[];
  /** The permissions a team, a person, a branch limit or a delegation may name. */
  grantable: Permission[];
  teams: AccessTeamDto[];
  /** Every branch. */
  branches: AccessBranchDto[];
}

/** POST /access-control/teams. `copyFromTeamId` starts it with that team's permissions. */
export interface CreateTeamRequest {
  /** The `version` of the read the change was made from (F118-3). */
  expectedVersion: string;

  /** Upper case letters, digits and `_`, unique. */
  code: string;
  nameAr: string;
  nameEn: string;
  copyFromTeamId?: string;
}

/** PATCH /access-control/teams/:id. A team is never deleted, only made inactive. */
export interface UpdateTeamRequest {
  /** The `version` of the read the change was made from (F118-3). */
  expectedVersion: string;

  nameAr?: string;
  nameEn?: string;
  /** Added teams only. */
  isActive?: boolean;
}

/**
 * A whole set of permissions: PUT /access-control/teams/:id/permissions (the team's set; a
 * system team's set equal to its defaults clears its changes), PUT
 * /access-control/branches/:id/blocked (the branch limit).
 */
export interface SetPermissionsRequest {
  /** The `version` of the read the change was made from (F118-3). */
  expectedVersion: string;

  permissions: Permission[];
}

export interface AccessPersonRefDto {
  userId: string;
  fullName: string;
  roles: Role[];
  isActive: boolean;
}

/** GET /access-control/branches/:id: the branch limit, who works there, its delegations. */
export interface BranchAccessDto {
  /**
   * access_state.version this was read at. Every change sends it back as `expectedVersion` and
   * is refused (409) when any change of access came in between: reload and redo (F118-3).
   */
  version: string;

  branchId: string;
  blocked: Permission[];
  people: AccessPersonRefDto[];
  delegations: DelegationDto[];
}

/** Where a permission a person holds in a branch comes from. */
export type AccessSourceKind = 'ROLE' | 'TEAM' | 'ADDED' | 'DELEGATED';

export interface AccessSourceDto {
  kind: AccessSourceKind;
  /** ROLE and TEAM, and DELEGATED through a team. */
  teamId?: string;
  /** DELEGATED. */
  delegationId?: string;
}

export interface PersonBranchAccessDto {
  branchId: string;
  /** Teams in this branch only (not the role teams, which are in `roles`). */
  teams: { teamId: string; delegationId: string | null }[];
  /** Permissions added in this branch. */
  allow: { permission: Permission; delegationId: string | null }[];
  /** Permissions the owner took away from this person in this branch. */
  deny: Permission[];
  /** The branch limit. */
  blocked: Permission[];
  /** What the person may do in this branch now, and why. */
  effective: { permission: Permission; sources: AccessSourceDto[] }[];
}

/** GET /access-control/people/:userId. */
export interface PersonAccessDto {
  /**
   * access_state.version this was read at. Every change sends it back as `expectedVersion` and
   * is refused (409) when any change of access came in between: reload and redo (F118-3).
   */
  version: string;

  userId: string;
  fullName: string;
  isActive: boolean;
  /** The role teams, in every branch of the person (user_roles; changed on the users screen). */
  roles: Role[];
  allBranches: boolean;
  /** Holds a restricted role: no team or added permission can be given. */
  restricted: boolean;
  branches: PersonBranchAccessDto[];
}

/**
 * PUT /access-control/people/:userId/branches/:branchId: the owner's own rows for this person in
 * this branch (rows given through a delegation are left as they are).
 */
export interface SetPersonBranchAccessRequest {
  /** The `version` of the read the change was made from (F118-3). */
  expectedVersion: string;

  teamIds: string[];
  allow: Permission[];
  deny: Permission[];
}

/** A person of a branch given a set of permissions to hand out there (plan 03, section 2). */
export interface DelegationDto {
  id: string;
  branchId: string;
  delegate: { userId: string; fullName: string };
  /** The ceiling: what the delegate may hand out. */
  permissions: Permission[];
  createdAt: string;
  /** Team memberships and permissions handed out through it. */
  grantedCount: number;
}

/** POST /access-control/delegations. One live delegation per person and branch. */
export interface CreateDelegationRequest {
  /** The `version` of the read the change was made from (F118-3). */
  expectedVersion: string;

  branchId: string;
  delegateUserId: string;
  permissions: Permission[];
}

/** One row handed out through a delegation that a smaller ceiling or a revocation drops. */
export interface DroppedGrantDto {
  userId: string;
  fullName: string;
  /** A permission given alone. */
  permission?: Permission;
  /** A team membership whose every permission falls outside the new ceiling. */
  teamId?: string;
}

/**
 * POST /access-control/delegations/:id/preview with a new ceiling (or none, for a revocation):
 * what would stop counting, at `version`. PUT /access-control/delegations/:id/permissions and
 * POST /access-control/delegations/:id/revoke apply it from that `version` (expectedVersion) and
 * answer the same list.
 */
export interface DelegationChangeDto {
  /**
   * access_state.version this was read at. Every change sends it back as `expectedVersion` and
   * is refused (409) when any change of access came in between: reload and redo (F118-3).
   */
  version: string;

  delegation: DelegationDto;
  dropped: DroppedGrantDto[];
}

/** POST /access-control/delegations/:id/revoke. */
export interface RevokeDelegationRequest {
  /** The `version` of the preview the revocation was confirmed from. */
  expectedVersion: string;
}

/** A person the delegate sees on the branch-permissions screen. */
export interface DelegatedPersonDto extends AccessPersonRefDto {
  /** False for the delegate, the Administrator, Management, another delegate, a restricted role. */
  editable: boolean;
  /** What the owner gave in this branch (read only here). */
  owner: { teamIds: string[]; allow: Permission[]; deny: Permission[] };
  /** What this delegation gave. */
  delegated: { teamIds: string[]; allow: Permission[] };
  /** What the person may do in the branch now. */
  effective: Permission[];
}

/** GET /branch-access: one entry per live delegation the signed-in person holds. */
export interface MyDelegationDto {
  /**
   * access_state.version this was read at. Every change sends it back as `expectedVersion` and
   * is refused (409) when any change of access came in between: reload and redo (F118-3).
   */
  version: string;

  delegation: DelegationDto;
  branch: AccessBranchDto;
  /** Active, not restricted teams. A team gives only what is inside the ceiling. */
  teams: AccessTeamDto[];
  people: DelegatedPersonDto[];
}

/**
 * PUT /branch-access/:delegationId/people/:userId: the delegation's rows for this person. Every
 * permission in `allow` is inside the ceiling.
 */
export interface SetDelegatedAccessRequest {
  /** The `version` of the read the change was made from (F118-3). */
  expectedVersion: string;

  teamIds: string[];
  allow: Permission[];
}
