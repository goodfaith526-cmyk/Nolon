import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NON_GRANTABLE_MODULES,
  PERMISSIONS,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  RESTRICTED_ROLES,
  ROLE_PERMISSIONS,
  hasAllBranchAccess,
  isPermission,
  permissionModule,
  type AccessBranchDto,
  type AccessCatalogDto,
  type AccessPersonRefDto,
  type AccessTeamDto,
  type AuditLogEntryDto,
  type BranchAccessDto,
  type CreateDelegationRequest,
  type CreateTeamRequest,
  type DelegatedPersonDto,
  type DelegationChangeDto,
  type DelegationDto,
  type DroppedGrantDto,
  type MyDelegationDto,
  type Permission,
  type PersonAccessDto,
  type Role,
  type SetDelegatedAccessRequest,
  type SetPersonBranchAccessRequest,
  type UpdateTeamRequest,
} from '@nolon/shared';
import { AuditService, type AuditRecord } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { explainAccess, mayHoldDelegation, teamPermissions } from './access.js';
import { loadAccess, loadAccessRows, readAccessVersion } from './access-loader.js';
import { AccessChangedException, requireActorInTx } from './access-lock.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;
type Actor = Pick<AuthUser, 'id' | 'access'>;

/** user_branch_teams / user_branch_permissions source_key of the owner's rows. */
const OWNER_SOURCE = '00000000-0000-0000-0000-000000000000';

const TEAM_SELECT = {
  id: true,
  code: true,
  nameAr: true,
  nameEn: true,
  systemRole: true,
  restricted: true,
  isActive: true,
  permissionChanges: { select: { permission: true, effect: true } },
} satisfies Prisma.TeamSelect;
type TeamRow = Prisma.TeamGetPayload<{ select: typeof TEAM_SELECT }>;

const DELEGATION_SELECT = {
  id: true,
  branchId: true,
  createdAt: true,
  revokedAt: true,
  delegate: { select: { id: true, fullName: true } },
  permissions: { select: { permission: true } },
  _count: { select: { teams: true, grants: true } },
} satisfies Prisma.BranchDelegationSelect;
type DelegationRow = Prisma.BranchDelegationGetPayload<{ select: typeof DELEGATION_SELECT }>;

function permsOf(team: TeamRow): Set<Permission> {
  return teamPermissions({ ...team, changes: team.permissionChanges });
}

function toTeam(team: TeamRow): AccessTeamDto {
  return {
    id: team.id,
    code: team.code,
    nameAr: team.nameAr,
    nameEn: team.nameEn,
    systemRole: team.systemRole,
    restricted: team.restricted,
    isActive: team.isActive,
    permissions: [...permsOf(team)].sort(),
    defaults: team.systemRole ? [...ROLE_PERMISSIONS[team.systemRole]].sort() : null,
  };
}

function toDelegation(d: DelegationRow): DelegationDto {
  return {
    id: d.id,
    branchId: d.branchId,
    delegate: { userId: d.delegate.id, fullName: d.delegate.fullName },
    permissions: d.permissions
      .map((p) => p.permission)
      .filter(isPermission)
      .sort(),
    createdAt: d.createdAt.toISOString(),
    grantedCount: d._count.teams + d._count.grants,
  };
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const listText = (values: Iterable<string>) => sorted(values).join(', ') || null;

function grantable(permission: Permission): boolean {
  return !NON_GRANTABLE_MODULES.includes(permissionModule(permission));
}

/** 400 unless every entry is a permission that may be given (no user or access management). */
function requireGrantable(values: readonly string[]): Permission[] {
  const bad = values.filter((v) => !isPermission(v) || !grantable(v));
  if (bad.length > 0)
    throw new BadRequestException(`Not a permission that can be given: ${bad.join(', ')}`);
  return sorted(values) as Permission[];
}

const isAdministrator = (roles: readonly Role[]) => roles.includes('ADMINISTRATOR');

/** The access_state.version a change made under the lock at `version` leaves behind. */
const nextVersion = (version: string) => (BigInt(version) + 1n).toString();
const holdsRestricted = (roles: readonly Role[]) => roles.some((r) => RESTRICTED_ROLES.includes(r));

/**
 * The permissions screen (docs/plans/03-permissions-screen.md, sections 6 and 7): the owner's
 * teams, branch limits, per-person access and delegations, and the delegate's own screen. Every
 * change runs under PrismaService.changeAccess (access_state FOR UPDATE, version raised), rechecks
 * the actor under that lock and writes its audit row in the same transaction.
 */
@Injectable()
export class AccessControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- Reads (owner) -------------------------------------------------------------------------

  // Every read takes access_state.version first: a change committed after it leaves the screen
  // with the older version, so its next change is refused (F118-3).

  async catalog(): Promise<AccessCatalogDto> {
    const version = await readAccessVersion(this.prisma);
    const [teams, branches] = await Promise.all([
      this.prisma.team.findMany({
        select: TEAM_SELECT,
        orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
      }),
      this.branches(this.prisma),
    ]);
    return {
      version,
      modules: [...PERMISSION_MODULES],
      actions: [...PERMISSION_ACTIONS],
      grantable: PERMISSIONS.filter(grantable),
      teams: teams.map(toTeam),
      branches,
    };
  }

  async branch(branchId: string): Promise<BranchAccessDto> {
    return this.branchView(this.prisma, branchId, await readAccessVersion(this.prisma));
  }

  async person(userId: string): Promise<PersonAccessDto> {
    return this.personView(this.prisma, userId, await readAccessVersion(this.prisma));
  }

  log(limit: number): Promise<AuditLogEntryDto[]> {
    return this.audit.accessEntries(limit);
  }

  // ---- Teams ---------------------------------------------------------------------------------

  async createTeam(actor: Actor, input: CreateTeamRequest): Promise<AccessTeamDto> {
    return this.asOwner(actor, input.expectedVersion, async (tx) => {
      if (await tx.team.findUnique({ where: { code: input.code } })) {
        throw new ConflictException('A team with this code already exists');
      }
      let permissions: Permission[] = [];
      if (input.copyFromTeamId) {
        const source = await this.teamOrThrow(tx, input.copyFromTeamId);
        if (source.restricted) throw new BadRequestException('A restricted team cannot be copied');
        permissions = [...permsOf(source)].filter(grantable).sort();
      }
      const team = await tx.team.create({
        data: {
          code: input.code,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          createdById: actor.id,
          permissionChanges: {
            create: permissions.map((permission) => ({
              permission,
              effect: 'ALLOW' as const,
              createdById: actor.id,
            })),
          },
        },
        select: TEAM_SELECT,
      });
      await this.record(tx, actor, {
        branchId: null,
        entity: 'TEAM',
        entityId: team.id,
        reference: team.code,
        action: 'CREATED',
        changes: [
          { field: 'name', before: null, after: `${team.nameEn} / ${team.nameAr}` },
          { field: 'permissions', before: null, after: listText(permissions) },
        ],
      });
      return toTeam(team);
    });
  }

  async updateTeam(actor: Actor, id: string, input: UpdateTeamRequest): Promise<AccessTeamDto> {
    return this.asOwner(actor, input.expectedVersion, async (tx) => {
      const before = await this.teamOrThrow(tx, id);
      if (input.isActive !== undefined && before.systemRole) {
        throw new BadRequestException('A role team is always active');
      }
      const after = await tx.team.update({
        where: { id },
        data: {
          ...(input.nameAr !== undefined && { nameAr: input.nameAr.trim() }),
          ...(input.nameEn !== undefined && { nameEn: input.nameEn.trim() }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
        },
        select: TEAM_SELECT,
      });
      const changes = [
        ['nameAr', before.nameAr, after.nameAr],
        ['nameEn', before.nameEn, after.nameEn],
        ['isActive', String(before.isActive), String(after.isActive)],
      ]
        .filter(([, was, now]) => was !== now)
        .map(([field, was, now]) => ({ field: field!, before: was ?? null, after: now ?? null }));
      await this.record(tx, actor, {
        branchId: null,
        entity: 'TEAM',
        entityId: id,
        reference: after.code,
        action: 'UPDATED',
        changes,
      });
      return toTeam(after);
    });
  }

  /**
   * A team's whole set: a role team stores what differs from its defaults (a set equal to them
   * clears its changes); an added team stores its ALLOW rows. The Administrator team is fixed; a
   * restricted team may only lose permissions (plan 03, F114-2).
   */
  async setTeamPermissions(
    actor: Actor,
    id: string,
    wanted: readonly string[],
    expectedVersion: string,
  ): Promise<AccessTeamDto> {
    return this.asOwner(actor, expectedVersion, async (tx) => {
      const team = await this.teamOrThrow(tx, id);
      if (team.systemRole === 'ADMINISTRATOR') {
        throw new BadRequestException('The Administrator team holds every permission');
      }
      const defaults = new Set<Permission>(
        team.systemRole ? ROLE_PERMISSIONS[team.systemRole] : [],
      );
      // A role team keeps its non-grantable defaults (none today outside the Administrator).
      const keep = [...defaults].filter((p) => !grantable(p));
      const next = new Set<Permission>([...requireGrantable(wanted), ...keep]);
      if (team.restricted && [...next].some((p) => !defaults.has(p))) {
        throw new BadRequestException('A restricted team cannot take more permissions');
      }
      const rows: { permission: Permission; effect: 'ALLOW' | 'DENY' }[] = team.systemRole
        ? [
            ...[...next]
              .filter((p) => !defaults.has(p))
              .map((p) => ({ permission: p, effect: 'ALLOW' as const })),
            ...[...defaults]
              .filter((p) => !next.has(p))
              .map((p) => ({ permission: p, effect: 'DENY' as const })),
          ]
        : [...next].map((p) => ({ permission: p, effect: 'ALLOW' as const }));
      const before = permsOf(team);
      await tx.teamPermissionChange.deleteMany({ where: { teamId: id } });
      await tx.teamPermissionChange.createMany({
        data: rows.map((r) => ({ teamId: id, ...r, createdById: actor.id })),
      });
      const after = await this.teamOrThrow(tx, id);
      await this.record(tx, actor, {
        branchId: null,
        entity: 'TEAM',
        entityId: id,
        reference: team.code,
        action: 'UPDATED',
        changes: diffChanges(before, permsOf(after)),
      });
      return toTeam(after);
    });
  }

  // ---- Branch limits -------------------------------------------------------------------------

  async setBranchBlocked(
    actor: Actor,
    branchId: string,
    wanted: readonly string[],
    expectedVersion: string,
  ): Promise<BranchAccessDto> {
    return this.asOwner(actor, expectedVersion, async (tx) => {
      const branch = await this.branchOrThrow(tx, branchId);
      const next = requireGrantable(wanted);
      const before = await tx.branchBlockedPermission.findMany({ where: { branchId } });
      await tx.branchBlockedPermission.deleteMany({ where: { branchId } });
      await tx.branchBlockedPermission.createMany({
        data: next.map((permission) => ({ branchId, permission, createdById: actor.id })),
      });
      await this.record(tx, actor, {
        branchId,
        entity: 'BRANCH_LIMIT',
        entityId: branchId,
        reference: branch.code,
        action: 'UPDATED',
        changes: [
          {
            field: 'blocked',
            before: listText(before.map((b) => b.permission)),
            after: listText(next),
          },
        ].filter((c) => c.before !== c.after),
      });
      return this.branchView(tx, branchId, nextVersion(actor.access.version));
    });
  }

  // ---- People --------------------------------------------------------------------------------

  /** The owner's own rows for a person in one of their branches (delegated rows stay). */
  async setPersonBranch(
    actor: Actor,
    userId: string,
    branchId: string,
    input: SetPersonBranchAccessRequest,
  ): Promise<PersonAccessDto> {
    return this.asOwner(actor, input.expectedVersion, async (tx) => {
      const person = await this.personOrThrow(tx, userId);
      const branch = await this.branchOrThrow(tx, branchId);
      if (!personBranchIds(person, await this.allBranchIds(tx)).includes(branchId)) {
        throw new BadRequestException('This person does not work in this branch');
      }
      const allow = requireGrantable(input.allow);
      const deny = requireGrantable(input.deny);
      if (allow.some((p) => deny.includes(p))) {
        throw new BadRequestException('A permission cannot be both added and taken away');
      }
      const teamIds = sorted(input.teamIds);
      const roles = person.roles.map((r) => r.role);
      if (holdsRestricted(roles) && (teamIds.length > 0 || allow.length > 0)) {
        throw new BadRequestException(
          'A person with a restricted role takes no team or added permission',
        );
      }
      await this.requireAssignableTeams(tx, teamIds);

      const owner = { userId, branchId, delegationId: null };
      const before = await this.ownerRows(tx, userId, branchId);
      await tx.userBranchTeam.deleteMany({ where: owner });
      await tx.userBranchPermission.deleteMany({ where: owner });
      await tx.userBranchTeam.createMany({
        data: teamIds.map((teamId) => ({
          userId,
          branchId,
          teamId,
          sourceKey: OWNER_SOURCE,
          createdById: actor.id,
        })),
      });
      await tx.userBranchPermission.createMany({
        data: [
          ...allow.map((permission) => ({ permission, effect: 'ALLOW' as const })),
          ...deny.map((permission) => ({ permission, effect: 'DENY' as const })),
        ].map((r) => ({ userId, branchId, ...r, sourceKey: OWNER_SOURCE, createdById: actor.id })),
      });
      const teamCodes = await this.teamCodes(tx, [...before.teamIds, ...teamIds]);
      await this.record(tx, actor, {
        branchId,
        entity: 'USER_ACCESS',
        entityId: userId,
        reference: `${person.fullName} @ ${branch.code}`,
        action: 'UPDATED',
        changes: [
          {
            field: 'teams',
            before: listText(before.teamIds.map(teamCodes)),
            after: listText(teamIds.map(teamCodes)),
          },
          { field: 'allow', before: listText(before.allow), after: listText(allow) },
          { field: 'deny', before: listText(before.deny), after: listText(deny) },
          { field: 'via', before: null, after: 'owner' },
        ].filter((c) => c.field === 'via' || c.before !== c.after),
      });
      return this.personView(tx, userId, nextVersion(actor.access.version));
    });
  }

  // ---- Delegations (owner) -------------------------------------------------------------------

  async createDelegation(actor: Actor, input: CreateDelegationRequest): Promise<DelegationDto> {
    return this.asOwner(actor, input.expectedVersion, async (tx) => {
      const branch = await this.branchOrThrow(tx, input.branchId);
      const delegate = await this.personOrThrow(tx, input.delegateUserId);
      const roles = delegate.roles.map((r) => r.role);
      if (!delegate.isActive) throw new BadRequestException('This person is not active');
      if (!delegate.branches.some((b) => b.branchId === input.branchId)) {
        throw new BadRequestException('The delegate must work in this branch');
      }
      if (!mayHoldDelegation(roles)) {
        throw new BadRequestException('This person cannot hold a delegation');
      }
      // One live delegation per person and branch (kept here under the access_state lock).
      if (
        await tx.branchDelegation.findFirst({
          where: {
            branchId: input.branchId,
            delegateUserId: input.delegateUserId,
            revokedAt: null,
          },
        })
      ) {
        throw new ConflictException('This person already holds a delegation in this branch');
      }
      const permissions = requireGrantable(input.permissions);
      const created = await tx.branchDelegation.create({
        data: {
          branchId: input.branchId,
          delegateUserId: input.delegateUserId,
          createdById: actor.id,
          permissions: { create: permissions.map((permission) => ({ permission })) },
        },
        select: DELEGATION_SELECT,
      });
      await this.record(tx, actor, {
        branchId: input.branchId,
        entity: 'DELEGATION',
        entityId: created.id,
        reference: `${delegate.fullName} @ ${branch.code}`,
        action: 'CREATED',
        changes: [{ field: 'permissions', before: null, after: listText(permissions) }],
      });
      return toDelegation(created);
    });
  }

  /**
   * What a new ceiling (or a revocation, `null`) would drop, without changing anything. The change
   * itself is applied only from this preview's `version` (F118-3).
   */
  async previewDelegation(
    id: string,
    permissions: readonly string[] | null,
  ): Promise<DelegationChangeDto> {
    const version = await readAccessVersion(this.prisma);
    const delegation = await this.liveDelegationOrThrow(this.prisma, id);
    const ceiling = permissions === null ? null : new Set(requireGrantable(permissions));
    return {
      version,
      delegation: toDelegation(delegation),
      dropped: await this.dropped(this.prisma, id, ceiling),
    };
  }

  /** A new ceiling: what was handed out outside it is dropped at once, each drop recorded. */
  async setDelegationPermissions(
    actor: Actor,
    id: string,
    permissions: readonly string[],
    expectedVersion: string,
  ): Promise<DelegationChangeDto> {
    return this.asOwner(actor, expectedVersion, async (tx) => {
      const before = await this.liveDelegationOrThrow(tx, id);
      const next = requireGrantable(permissions);
      const dropped = await this.drop(tx, actor, before, new Set(next));
      await tx.branchDelegationPermission.deleteMany({ where: { delegationId: id } });
      await tx.branchDelegationPermission.createMany({
        data: next.map((permission) => ({ delegationId: id, permission })),
      });
      await this.record(tx, actor, {
        branchId: before.branchId,
        entity: 'DELEGATION',
        entityId: id,
        reference: before.delegate.fullName,
        action: 'UPDATED',
        changes: [
          {
            field: 'permissions',
            before: listText(before.permissions.map((p) => p.permission)),
            after: listText(next),
          },
        ].filter((c) => c.before !== c.after),
      });
      return {
        version: nextVersion(actor.access.version),
        delegation: toDelegation(await this.delegationOrThrow(tx, id)),
        dropped,
      };
    });
  }

  /** Ends a delegation: everything handed out through it is dropped, each drop recorded. */
  async revokeDelegation(
    actor: Actor,
    id: string,
    expectedVersion: string,
  ): Promise<DelegationChangeDto> {
    return this.asOwner(actor, expectedVersion, async (tx) => {
      const before = await this.liveDelegationOrThrow(tx, id);
      const dropped = await this.drop(tx, actor, before, null);
      await tx.branchDelegation.update({
        where: { id },
        data: { revokedAt: new Date(), revokedById: actor.id },
      });
      await this.record(tx, actor, {
        branchId: before.branchId,
        entity: 'DELEGATION',
        entityId: id,
        reference: before.delegate.fullName,
        action: 'CANCELLED',
        changes: [{ field: 'revoked', before: null, after: 'yes' }],
      });
      return {
        version: nextVersion(actor.access.version),
        delegation: toDelegation(await this.delegationOrThrow(tx, id)),
        dropped,
      };
    });
  }

  // ---- The delegate's screen -----------------------------------------------------------------

  async mine(user: AuthUser): Promise<MyDelegationDto[]> {
    const version = await readAccessVersion(this.prisma);
    const delegations = await this.prisma.branchDelegation.findMany({
      where: { delegateUserId: user.id, revokedAt: null },
      select: DELEGATION_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    const live = [];
    for (const d of delegations) {
      if (await this.delegateStillHolds(this.prisma, user.id, d.branchId)) live.push(d);
    }
    if (live.length === 0) return [];
    const teams = await this.prisma.team.findMany({
      where: { isActive: true, restricted: false, NOT: { systemRole: 'ADMINISTRATOR' } },
      select: TEAM_SELECT,
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    });
    const result: MyDelegationDto[] = [];
    for (const d of live) {
      const branch = await this.branchOrThrow(this.prisma, d.branchId);
      result.push({
        version,
        delegation: toDelegation(d),
        branch: { id: branch.id, code: branch.code, nameAr: branch.nameAr, nameEn: branch.nameEn },
        teams: teams.map(toTeam),
        people: await this.delegatedPeople(this.prisma, user.id, d.id, d.branchId),
      });
    }
    return result;
  }

  /** The delegation's own rows for one person of its branch (plan 03, section 6). */
  async setDelegated(
    actor: Actor,
    delegationId: string,
    userId: string,
    input: SetDelegatedAccessRequest,
  ): Promise<DelegatedPersonDto> {
    requireExpectedVersion(actor, input.expectedVersion);
    return this.prisma.changeAccess(actor.access.version, async (tx) => {
      // Under the lock: the delegation is live and the actor still holds it.
      const delegation = await tx.branchDelegation.findUnique({
        where: { id: delegationId },
        select: DELEGATION_SELECT,
      });
      if (
        !delegation ||
        delegation.revokedAt !== null ||
        delegation.delegate.id !== actor.id ||
        !(await this.delegateStillHolds(tx, actor.id, delegation.branchId))
      ) {
        throw new ForbiddenException('You no longer hold this delegation');
      }
      const branchId = delegation.branchId;
      const people = await this.delegatedPeople(tx, actor.id, delegationId, branchId);
      const person = people.find((p) => p.userId === userId);
      if (!person) throw new ForbiddenException('This person does not work in your branch');
      if (!person.editable) throw new ForbiddenException('You cannot change this person');

      const ceiling = new Set(delegation.permissions.map((p) => p.permission));
      const allow = requireGrantable(input.allow);
      const outside = allow.filter((p) => !ceiling.has(p));
      if (outside.length > 0) {
        throw new ForbiddenException(`Outside your delegation: ${outside.join(', ')}`);
      }
      const teamIds = sorted(input.teamIds);
      await this.requireAssignableTeams(tx, teamIds);

      const where = { userId, branchId, delegationId };
      await tx.userBranchTeam.deleteMany({ where });
      await tx.userBranchPermission.deleteMany({ where });
      await tx.userBranchTeam.createMany({
        data: teamIds.map((teamId) => ({
          ...where,
          teamId,
          sourceKey: delegationId,
          createdById: actor.id,
        })),
      });
      await tx.userBranchPermission.createMany({
        data: allow.map((permission) => ({
          ...where,
          permission,
          effect: 'ALLOW' as const,
          sourceKey: delegationId,
          createdById: actor.id,
        })),
      });
      const teamCodes = await this.teamCodes(tx, [...person.delegated.teamIds, ...teamIds]);
      await this.record(tx, actor, {
        branchId,
        entity: 'USER_ACCESS',
        entityId: userId,
        reference: person.fullName,
        action: 'UPDATED',
        changes: [
          {
            field: 'teams',
            before: listText(person.delegated.teamIds.map(teamCodes)),
            after: listText(teamIds.map(teamCodes)),
          },
          { field: 'allow', before: listText(person.delegated.allow), after: listText(allow) },
          { field: 'via', before: null, after: `delegation ${delegationId}` },
        ].filter((c) => c.field === 'via' || c.before !== c.after),
      });
      const after = await this.delegatedPeople(tx, actor.id, delegationId, branchId);
      return after.find((p) => p.userId === userId)!;
    });
  }

  // ---- Helpers -------------------------------------------------------------------------------

  /**
   * A change by the owner, made from a read at `expectedVersion` with nothing changed since, and
   * the actor still an active Administrator under the lock.
   */
  private asOwner<R>(
    actor: Actor,
    expectedVersion: string,
    fn: (tx: Tx) => Promise<R>,
  ): Promise<R> {
    requireExpectedVersion(actor, expectedVersion);
    return this.prisma.changeAccess(actor.access.version, async (tx) => {
      await requireActorInTx(tx, actor.id, isAdministrator);
      return fn(tx);
    });
  }

  private record(tx: Tx, actor: Actor, record: AuditRecord): Promise<void> {
    return this.audit.record(tx, actor, record);
  }

  private async branches(db: Db): Promise<AccessBranchDto[]> {
    return db.branch.findMany({
      select: { id: true, code: true, nameAr: true, nameEn: true },
      orderBy: { code: 'asc' },
    });
  }

  private async allBranchIds(db: Db): Promise<string[]> {
    return (await db.branch.findMany({ select: { id: true } })).map((b) => b.id);
  }

  private async branchOrThrow(db: Db, id: string) {
    const branch = await db.branch.findUnique({
      where: { id },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  private async teamOrThrow(db: Db, id: string): Promise<TeamRow> {
    const team = await db.team.findUnique({ where: { id }, select: TEAM_SELECT });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  private async teamCodes(db: Db, ids: readonly string[]): Promise<(id: string) => string> {
    const rows = await db.team.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, code: true },
    });
    const codes = new Map(rows.map((r) => [r.id, r.code]));
    return (id) => codes.get(id) ?? id;
  }

  /** Teams a person may be put in for one branch: active, not restricted, not the Administrator. */
  private async requireAssignableTeams(db: Db, teamIds: readonly string[]): Promise<void> {
    if (teamIds.length === 0) return;
    const teams = await db.team.findMany({
      where: { id: { in: [...teamIds] } },
      select: { id: true, isActive: true, restricted: true, systemRole: true },
    });
    const ok = teams.filter((t) => t.isActive && !t.restricted && t.systemRole !== 'ADMINISTRATOR');
    if (ok.length !== teamIds.length) {
      throw new BadRequestException(
        'A team here must be active, not restricted, not the Administrator',
      );
    }
  }

  private async personOrThrow(db: Db, id: string) {
    const person = await db.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        isActive: true,
        roles: { select: { role: true } },
        branches: { select: { branchId: true } },
      },
    });
    if (!person) throw new NotFoundException('User not found');
    return person;
  }

  private async ownerRows(db: Db, userId: string, branchId: string) {
    const [teams, perms] = await Promise.all([
      db.userBranchTeam.findMany({
        where: { userId, branchId, delegationId: null },
        select: { teamId: true },
      }),
      db.userBranchPermission.findMany({
        where: { userId, branchId, delegationId: null },
        select: { permission: true, effect: true },
      }),
    ]);
    return {
      teamIds: teams.map((t) => t.teamId),
      allow: perms.filter((p) => p.effect === 'ALLOW').map((p) => p.permission),
      deny: perms.filter((p) => p.effect === 'DENY').map((p) => p.permission),
    };
  }

  private async branchView(db: Db, branchId: string, version: string): Promise<BranchAccessDto> {
    await this.branchOrThrow(db, branchId);
    const [blocked, people, delegations] = await Promise.all([
      db.branchBlockedPermission.findMany({ where: { branchId }, select: { permission: true } }),
      db.user.findMany({
        where: { branches: { some: { branchId } } },
        select: { id: true, fullName: true, isActive: true, roles: { select: { role: true } } },
        orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      }),
      db.branchDelegation.findMany({
        where: { branchId, revokedAt: null },
        select: DELEGATION_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      version,
      branchId,
      blocked: blocked
        .map((b) => b.permission)
        .filter(isPermission)
        .sort(),
      people: people.map((p): AccessPersonRefDto => ({
        userId: p.id,
        fullName: p.fullName,
        roles: p.roles.map((r) => r.role),
        isActive: p.isActive,
      })),
      delegations: delegations.map(toDelegation),
    };
  }

  private async personView(db: Db, userId: string, version: string): Promise<PersonAccessDto> {
    const person = await this.personOrThrow(db, userId);
    const roles = person.roles.map((r) => r.role);
    const memberBranchIds = person.branches.map((b) => b.branchId);
    const rows = await loadAccessRows(db, userId, roles, memberBranchIds, version);
    const branchIds = [...rows.branchIds].sort();
    return {
      version,
      userId,
      fullName: person.fullName,
      isActive: person.isActive,
      roles,
      allBranches: hasAllBranchAccess(roles),
      restricted: holdsRestricted(roles),
      branches: branchIds.map((branchId) => ({
        branchId,
        teams: rows.branchTeams
          .filter((t) => t.branchId === branchId)
          .map((t) => ({ teamId: t.teamId, delegationId: t.delegationId })),
        allow: rows.branchPermissions
          .filter(
            (p) => p.branchId === branchId && p.effect === 'ALLOW' && isPermission(p.permission),
          )
          .map((p) => ({ permission: p.permission as Permission, delegationId: p.delegationId })),
        deny: rows.branchPermissions
          .filter((p) => p.branchId === branchId && p.effect === 'DENY')
          .map((p) => p.permission)
          .filter(isPermission)
          .sort(),
        blocked: rows.blocked
          .filter((b) => b.branchId === branchId)
          .map((b) => b.permission)
          .filter(isPermission)
          .sort(),
        effective: explainAccess(rows, branchId),
      })),
    };
  }

  private async delegationOrThrow(db: Db, id: string): Promise<DelegationRow> {
    const d = await db.branchDelegation.findUnique({ where: { id }, select: DELEGATION_SELECT });
    if (!d) throw new NotFoundException('Delegation not found');
    return d;
  }

  private async liveDelegationOrThrow(db: Db, id: string): Promise<DelegationRow> {
    const d = await this.delegationOrThrow(db, id);
    if (d.revokedAt !== null) throw new BadRequestException('This delegation was revoked');
    return d;
  }

  /**
   * The delegate is active, still works in the branch and still holds roles that allow a
   * delegation (else their delegation gives nothing; F118-4).
   */
  private async delegateStillHolds(db: Db, userId: string, branchId: string): Promise<boolean> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        roles: { select: { role: true } },
        branches: { where: { branchId }, select: { branchId: true } },
      },
    });
    return Boolean(
      user?.isActive &&
      user.branches.length > 0 &&
      mayHoldDelegation(user.roles.map((r) => r.role)),
    );
  }

  /** Rows handed out through `delegationId` that `ceiling` (null: none) leaves without effect. */
  private async dropped(
    db: Db,
    delegationId: string,
    ceiling: ReadonlySet<string> | null,
  ): Promise<DroppedGrantDto[]> {
    const [teams, grants] = await Promise.all([
      db.userBranchTeam.findMany({
        where: { delegationId },
        select: {
          teamId: true,
          user: { select: { id: true, fullName: true } },
          team: { select: TEAM_SELECT },
        },
      }),
      db.userBranchPermission.findMany({
        where: { delegationId },
        select: { permission: true, user: { select: { id: true, fullName: true } } },
      }),
    ]);
    const out: DroppedGrantDto[] = [];
    for (const t of teams) {
      if (!ceiling || ![...permsOf(t.team)].some((p) => ceiling.has(p))) {
        out.push({ userId: t.user.id, fullName: t.user.fullName, teamId: t.teamId });
      }
    }
    for (const g of grants) {
      if ((!ceiling || !ceiling.has(g.permission)) && isPermission(g.permission)) {
        out.push({ userId: g.user.id, fullName: g.user.fullName, permission: g.permission });
      }
    }
    return out;
  }

  /** Deletes what `ceiling` drops and records one audit row per dropped grant. */
  private async drop(
    tx: Tx,
    actor: Actor,
    delegation: DelegationRow,
    ceiling: ReadonlySet<string> | null,
  ): Promise<DroppedGrantDto[]> {
    const dropped = await this.dropped(tx, delegation.id, ceiling);
    const teamCodes = await this.teamCodes(
      tx,
      dropped.flatMap((d) => (d.teamId ? [d.teamId] : [])),
    );
    for (const d of dropped) {
      const where = {
        userId: d.userId,
        branchId: delegation.branchId,
        delegationId: delegation.id,
      };
      if (d.teamId) await tx.userBranchTeam.deleteMany({ where: { ...where, teamId: d.teamId } });
      if (d.permission)
        await tx.userBranchPermission.deleteMany({ where: { ...where, permission: d.permission } });
      await this.record(tx, actor, {
        branchId: delegation.branchId,
        entity: 'USER_ACCESS',
        entityId: d.userId,
        reference: d.fullName,
        action: 'UPDATED',
        changes: [
          d.teamId
            ? { field: 'teams', before: teamCodes(d.teamId), after: null }
            : { field: 'allow', before: d.permission ?? null, after: null },
          { field: 'via', before: null, after: `dropped from delegation ${delegation.id}` },
        ],
      });
    }
    return dropped;
  }

  /** The people of the delegation's branch, as the delegate sees them. */
  private async delegatedPeople(
    db: Db,
    delegateId: string,
    delegationId: string,
    branchId: string,
  ): Promise<DelegatedPersonDto[]> {
    const [people, otherDelegates] = await Promise.all([
      db.user.findMany({
        where: { branches: { some: { branchId } } },
        select: {
          id: true,
          fullName: true,
          isActive: true,
          roles: { select: { role: true } },
          branches: { select: { branchId: true } },
        },
        orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      }),
      db.branchDelegation.findMany({
        where: { branchId, revokedAt: null, NOT: { id: delegationId } },
        select: { delegateUserId: true },
      }),
    ]);
    const delegates = new Set(otherDelegates.map((d) => d.delegateUserId));
    const result: DelegatedPersonDto[] = [];
    for (const p of people) {
      const roles = p.roles.map((r) => r.role);
      const [owner, mine, access] = await Promise.all([
        this.ownerRows(db, p.id, branchId),
        Promise.all([
          db.userBranchTeam.findMany({
            where: { userId: p.id, branchId, delegationId },
            select: { teamId: true },
          }),
          db.userBranchPermission.findMany({
            where: { userId: p.id, branchId, delegationId, effect: 'ALLOW' },
            select: { permission: true },
          }),
        ]),
        loadAccess(
          db,
          p.id,
          roles,
          p.branches.map((b) => b.branchId),
        ),
      ]);
      result.push({
        userId: p.id,
        fullName: p.fullName,
        roles,
        isActive: p.isActive,
        editable:
          p.isActive &&
          p.id !== delegateId &&
          !isAdministrator(roles) &&
          !roles.includes('MANAGEMENT') &&
          !holdsRestricted(roles) &&
          !delegates.has(p.id),
        owner: {
          teamIds: owner.teamIds,
          allow: owner.allow.filter(isPermission),
          deny: owner.deny.filter(isPermission),
        },
        delegated: {
          teamIds: mine[0].map((t) => t.teamId),
          allow: mine[1].map((g) => g.permission).filter(isPermission),
        },
        effective: access.inBranch(branchId),
      });
    }
    return result;
  }
}

/**
 * A change is made from the screen's read at `expectedVersion`: refused (409) when any change of
 * access came in between, so a whole set read before it never silently restores what another
 * change took away (F118-3). The lock then checks the request's own version against the database.
 */
function requireExpectedVersion(actor: Actor, expectedVersion: string): void {
  if (expectedVersion !== actor.access.version) throw new AccessChangedException();
}

/** The branches a person's access is computed for (every branch for an all-branch role). */
function personBranchIds(
  person: { roles: { role: Role }[]; branches: { branchId: string }[] },
  all: readonly string[],
): string[] {
  return hasAllBranchAccess(person.roles.map((r) => r.role))
    ? [...all]
    : person.branches.map((b) => b.branchId);
}

/** A team's set before and after, as audit changes (added / removed). */
function diffChanges(before: ReadonlySet<Permission>, after: ReadonlySet<Permission>) {
  const added = [...after].filter((p) => !before.has(p));
  const removed = [...before].filter((p) => !after.has(p));
  return [
    ...(added.length > 0 ? [{ field: 'added', before: null, after: listText(added) }] : []),
    ...(removed.length > 0 ? [{ field: 'removed', before: listText(removed), after: null }] : []),
  ];
}
