import type {
  AccessCatalogDto,
  AccessTeamDto,
  AuditLogEntryDto,
  AuthMeResponse,
  DelegationChangeDto,
  DelegationDto,
  MyDelegationDto,
  Permission,
  PersonAccessDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';

// Plan 03, P-2 and P-3 through HTTP: the owner's teams, branch limits, people and delegations,
// and the delegate's own screen, with the negative cases (sections 6 and 10).

const SALES_TEAM = '5a0e0000-0000-4000-8000-000000000004';
const DRIVER_TEAM = '5a0e0000-0000-4000-8000-000000000009';
const ADMIN_TEAM = '5a0e0000-0000-4000-8000-000000000001';

describe('the permissions screen (plan 03, P-2 and P-3)', () => {
  let t: TestApp;
  let dxb: string;
  let jed: string;
  let admin: string;
  const users: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    const a = await createUser(t.prisma, ['ADMINISTRATOR']);
    users.push(a.id);
    admin = await signIn(t, a.email);
  });

  afterAll(async () => {
    // Put the role teams and branch limits back for the other suites.
    const ids = { in: users };
    await t.prisma.teamPermissionChange.deleteMany({ where: { createdById: ids } });
    await t.prisma.branchBlockedPermission.deleteMany({ where: { createdById: ids } });
    await t.prisma.userBranchPermission.deleteMany({ where: { createdById: ids } });
    await t.prisma.userBranchTeam.deleteMany({ where: { createdById: ids } });
    await t.prisma.branchDelegationPermission.deleteMany({
      where: { delegation: { createdById: ids } },
    });
    await t.prisma.branchDelegation.deleteMany({ where: { createdById: ids } });
    await t.prisma.team.deleteMany({ where: { createdById: ids } });
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  async function person(roles: Parameters<typeof createUser>[1], branches = ['DXB', 'JED']) {
    const user = await createUser(t.prisma, roles, branches);
    users.push(user.id);
    return { ...user, cookie: await signIn(t, user.email) };
  }

  const get = (cookie: string, path: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const version = async () =>
    (await t.prisma.accessState.findUniqueOrThrow({ where: { id: 1 } })).version.toString();
  const raw = (method: 'post' | 'put' | 'patch', cookie: string, path: string, body: object) =>
    t.http()[method](`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  /**
   * A change made from a screen read just now: the permissions routes get the current version as
   * `expectedVersion` unless the body names one (the stale-screen cases below do).
   */
  const send = (method: 'post' | 'put' | 'patch', cookie: string, path: string, body: object) => ({
    expect: async (status: number) => {
      // A preview changes nothing and takes no version (it answers one).
      const screen =
        (path.startsWith('/access-control/') || path.startsWith('/branch-access/')) &&
        !path.endsWith('/preview');
      const withVersion =
        screen && !('expectedVersion' in body)
          ? { expectedVersion: await version(), ...body }
          : body;
      return raw(method, cookie, path, withVersion).expect(status);
    },
  });

  async function heldIn(cookie: string, branch: string): Promise<Permission[]> {
    const me = (await get(cookie, '/auth/me').expect(200)).body as AuthMeResponse;
    return me.branchPermissions?.find((b) => b.branchId === branch)?.permissions ?? [];
  }

  it('is the Administrator’s only', async () => {
    const manager = await person(['BRANCH_MANAGER'], ['DXB']);
    await get(manager.cookie, '/access-control/catalog').expect(403);
    await send('put', manager.cookie, `/access-control/branches/${dxb}/blocked`, {
      permissions: [],
    }).expect(403);
    const catalog = (await get(admin, '/access-control/catalog').expect(200))
      .body as AccessCatalogDto;
    expect(catalog.teams.filter((team) => team.systemRole)).toHaveLength(11);
    expect(catalog.grantable).not.toContain('users:view');
    expect(catalog.grantable).not.toContain('access_control:update');
    expect(catalog.branches.map((b) => b.code)).toContain('KRT');
  });

  describe('teams', () => {
    it('changes a role team for everyone in it, and goes back to its defaults', async () => {
      const seller = await person(['SALES']);
      const catalog = (await get(admin, '/access-control/catalog')).body as AccessCatalogDto;
      const sales = catalog.teams.find((team) => team.id === SALES_TEAM)!;
      const without = sales.permissions.filter((p) => p !== 'bookings:create');
      const changed = (
        await send('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
          permissions: without,
        }).expect(200)
      ).body as AccessTeamDto;
      expect(changed.permissions).not.toContain('bookings:create');
      expect(await heldIn(seller.cookie, dxb)).not.toContain('bookings:create');
      expect(await heldIn(seller.cookie, jed)).not.toContain('bookings:create');

      await send('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
        permissions: sales.defaults,
      }).expect(200);
      expect(await heldIn(seller.cookie, dxb)).toContain('bookings:create');
      expect(await t.prisma.teamPermissionChange.count({ where: { teamId: SALES_TEAM } })).toBe(0);
    });

    it('refuses widening a restricted team, the Administrator team, or giving user management', async () => {
      await send('put', admin, `/access-control/teams/${DRIVER_TEAM}/permissions`, {
        permissions: ['customers:view'],
      }).expect(400);
      await send('put', admin, `/access-control/teams/${ADMIN_TEAM}/permissions`, {
        permissions: [],
      }).expect(400);
      await send('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
        permissions: ['users:view'],
      }).expect(400);
      await send('post', admin, '/access-control/teams', {
        code: 'IT_COPY_DRIVER',
        nameAr: 'x',
        nameEn: 'x',
        copyFromTeamId: DRIVER_TEAM,
      }).expect(400);
    });

    it('adds a team, copied from another, and gives it to a person in one branch only', async () => {
      const team = (
        await send('post', admin, '/access-control/teams', {
          code: `IT_${Date.now()}`,
          nameAr: 'محاسبة القيود',
          nameEn: 'Journals',
        }).expect(201)
      ).body as AccessTeamDto;
      expect(team.permissions).toEqual([]);
      await send('put', admin, `/access-control/teams/${team.id}/permissions`, {
        permissions: ['manual_journals:view'],
      }).expect(200);

      const ops = await person(['OPERATIONS']);
      const view = (
        await send('put', admin, `/access-control/people/${ops.id}/branches/${dxb}`, {
          teamIds: [team.id],
          allow: [],
          deny: [],
        }).expect(200)
      ).body as PersonAccessDto;
      const inDxb = view.branches.find((b) => b.branchId === dxb)!;
      expect(inDxb.effective.find((e) => e.permission === 'manual_journals:view')?.sources).toEqual(
        [{ kind: 'TEAM', teamId: team.id }],
      );
      expect(await heldIn(ops.cookie, dxb)).toContain('manual_journals:view');
      expect(await heldIn(ops.cookie, jed)).not.toContain('manual_journals:view');

      // An inactive added team gives nothing.
      await send('patch', admin, `/access-control/teams/${team.id}`, { isActive: false }).expect(
        200,
      );
      expect(await heldIn(ops.cookie, dxb)).not.toContain('manual_journals:view');
      await send('patch', admin, `/access-control/teams/${SALES_TEAM}`, { isActive: false }).expect(
        400,
      );
    });
  });

  describe('branch limits and people', () => {
    it('blocks a permission for everyone in a branch, Management too, never the Administrator', async () => {
      const seller = await person(['SALES']);
      const management = await person(['MANAGEMENT'], []);
      const otherAdmin = await person(['ADMINISTRATOR'], []);
      await send('put', admin, `/access-control/branches/${jed}/blocked`, {
        permissions: ['bookings:view'],
      }).expect(200);
      expect(await heldIn(seller.cookie, jed)).not.toContain('bookings:view');
      expect(await heldIn(seller.cookie, dxb)).toContain('bookings:view');
      expect(await heldIn(management.cookie, jed)).not.toContain('bookings:view');
      expect(await heldIn(otherAdmin.cookie, jed)).toContain('bookings:view');
      await send('put', admin, `/access-control/branches/${jed}/blocked`, {
        permissions: [],
      }).expect(200);
      expect(await heldIn(seller.cookie, jed)).toContain('bookings:view');
    });

    it('takes a permission from one person in one branch, and refuses one outside their branches', async () => {
      const seller = await person(['SALES'], ['DXB']);
      await send('put', admin, `/access-control/people/${seller.id}/branches/${dxb}`, {
        teamIds: [],
        allow: [],
        deny: ['customers:create'],
      }).expect(200);
      expect(await heldIn(seller.cookie, dxb)).not.toContain('customers:create');
      await send('put', admin, `/access-control/people/${seller.id}/branches/${jed}`, {
        teamIds: [],
        allow: [],
        deny: [],
      }).expect(400);
      await send('put', admin, `/access-control/people/${seller.id}/branches/${dxb}`, {
        teamIds: [],
        allow: ['customers:create'],
        deny: ['customers:create'],
      }).expect(400);
    });

    it('gives a driver no team and no added permission', async () => {
      const driver = await person(['DRIVER'], ['DXB']);
      await send('put', admin, `/access-control/people/${driver.id}/branches/${dxb}`, {
        teamIds: [SALES_TEAM],
        allow: [],
        deny: [],
      }).expect(400);
      await send('put', admin, `/access-control/people/${driver.id}/branches/${dxb}`, {
        teamIds: [],
        allow: ['customers:view'],
        deny: [],
      }).expect(400);
      const view = (await get(admin, `/access-control/people/${driver.id}`).expect(200))
        .body as PersonAccessDto;
      expect(view.restricted).toBe(true);
    });
  });

  describe('delegation', () => {
    it('lets the delegate hand out only what was delegated, to people of the branch only', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const ops = await person(['OPERATIONS'], ['DXB']);
      const outsider = await person(['OPERATIONS'], ['JED']);
      const management = await person(['MANAGEMENT'], ['DXB']);
      const delegation = (
        await send('post', admin, '/access-control/delegations', {
          branchId: dxb,
          delegateUserId: manager.id,
          permissions: ['manual_journals:view', 'expenses:create'],
        }).expect(201)
      ).body as DelegationDto;
      await send('post', admin, '/access-control/delegations', {
        branchId: dxb,
        delegateUserId: manager.id,
        permissions: [],
      }).expect(409);

      const me = (await get(manager.cookie, '/auth/me')).body as AuthMeResponse;
      expect(me.delegations).toEqual([{ id: delegation.id, branchId: dxb }]);
      const mine = (await get(manager.cookie, '/branch-access').expect(200))
        .body as MyDelegationDto[];
      expect(mine).toHaveLength(1);
      const people = mine[0]!.people;
      expect(people.find((p) => p.userId === ops.id)?.editable).toBe(true);
      expect(people.find((p) => p.userId === manager.id)?.editable).toBe(false);
      expect(people.find((p) => p.userId === management.id)?.editable).toBe(false);

      const path = (userId: string) => `/branch-access/${delegation.id}/people/${userId}`;
      await send('put', manager.cookie, path(ops.id), {
        teamIds: [],
        allow: ['manual_journals:view'],
      }).expect(200);
      expect(await heldIn(ops.cookie, dxb)).toContain('manual_journals:view');

      // Outside the ceiling, outside the branch, not editable, a DENY: refused.
      await send('put', manager.cookie, path(ops.id), {
        teamIds: [],
        allow: ['manual_journals:create'],
      }).expect(403);
      await send('put', manager.cookie, path(outsider.id), { teamIds: [], allow: [] }).expect(403);
      await send('put', manager.cookie, path(management.id), { teamIds: [], allow: [] }).expect(
        403,
      );
      await send('put', manager.cookie, path(manager.id), {
        teamIds: [],
        allow: ['expenses:create'],
      }).expect(403);
      await send('put', manager.cookie, path(ops.id), {
        teamIds: [],
        allow: [],
        deny: ['customers:view'],
      }).expect(400);
      // The delegate does not reach the owner's screen, nor someone else's delegation.
      await get(manager.cookie, '/access-control/catalog').expect(403);
      await send('put', ops.cookie, path(ops.id), { teamIds: [], allow: [] }).expect(403);
    });

    it('drops what a smaller ceiling or a revocation leaves out, after a preview, and keeps owner grants', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const ops = await person(['OPERATIONS'], ['DXB']);
      const delegation = (
        await send('post', admin, '/access-control/delegations', {
          branchId: dxb,
          delegateUserId: manager.id,
          permissions: ['manual_journals:view', 'expenses:create'],
        }).expect(201)
      ).body as DelegationDto;
      await send('put', manager.cookie, `/branch-access/${delegation.id}/people/${ops.id}`, {
        teamIds: [],
        allow: ['manual_journals:view', 'expenses:create'],
      }).expect(200);
      // The owner also gives expenses:create: it survives the delegation's end.
      await send('put', admin, `/access-control/people/${ops.id}/branches/${dxb}`, {
        teamIds: [],
        allow: ['expenses:create'],
        deny: [],
      }).expect(200);

      const preview = (
        await send('post', admin, `/access-control/delegations/${delegation.id}/preview`, {
          permissions: ['expenses:create'],
        }).expect(200)
      ).body as DelegationChangeDto;
      expect(preview.dropped).toEqual([
        { userId: ops.id, fullName: 'Integration Test', permission: 'manual_journals:view' },
      ]);
      expect(await heldIn(ops.cookie, dxb)).toContain('manual_journals:view');

      const shrunk = (
        await send('put', admin, `/access-control/delegations/${delegation.id}/permissions`, {
          permissions: ['expenses:create'],
        }).expect(200)
      ).body as DelegationChangeDto;
      expect(shrunk.dropped).toEqual(preview.dropped);
      expect(await heldIn(ops.cookie, dxb)).not.toContain('manual_journals:view');

      await send('post', admin, `/access-control/delegations/${delegation.id}/revoke`, {}).expect(
        200,
      );
      expect(await heldIn(ops.cookie, dxb)).toContain('expenses:create');
      expect(((await get(manager.cookie, '/auth/me')).body as AuthMeResponse).delegations).toEqual(
        [],
      );
      await send('put', manager.cookie, `/branch-access/${delegation.id}/people/${ops.id}`, {
        teamIds: [],
        allow: [],
      }).expect(403);
    });

    it('gives nothing once the delegate leaves the branch', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const ops = await person(['OPERATIONS'], ['DXB']);
      const delegation = (
        await send('post', admin, '/access-control/delegations', {
          branchId: dxb,
          delegateUserId: manager.id,
          permissions: ['manual_journals:view'],
        }).expect(201)
      ).body as DelegationDto;
      await send('put', manager.cookie, `/branch-access/${delegation.id}/people/${ops.id}`, {
        teamIds: [],
        allow: ['manual_journals:view'],
      }).expect(200);
      await send('patch', admin, `/users/${manager.id}`, { branchIds: [jed] }).expect(200);
      expect(await heldIn(ops.cookie, dxb)).not.toContain('manual_journals:view');
    });
  });

  describe('a change is made from the version it was read at (Codex F118-3)', () => {
    it('refuses a whole set saved from a team page read before another change', async () => {
      const page = (await get(admin, '/access-control/catalog').expect(200))
        .body as AccessCatalogDto;
      const sales = page.teams.find((team) => team.id === SALES_TEAM)!;
      expect(sales.permissions).toContain('bookings:create');
      // A second editor takes bookings:create away.
      await send('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
        permissions: sales.permissions.filter((p) => p !== 'bookings:create'),
      }).expect(200);
      // The first editor's old page adds rates:view to the set it read: refused, nothing restored.
      await send('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
        expectedVersion: page.version,
        permissions: [...sales.permissions, 'rates:view'],
      }).expect(409);
      const now = (await get(admin, '/access-control/catalog')).body as AccessCatalogDto;
      expect(now.version).not.toBe(page.version);
      expect(now.teams.find((team) => team.id === SALES_TEAM)!.permissions).not.toContain(
        'bookings:create',
      );
      // Read again, the change goes through; then back to the defaults.
      await send('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
        expectedVersion: now.version,
        permissions: sales.defaults,
      }).expect(200);
      // A body without a version, or with a version that is not one, is refused.
      await raw('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
        permissions: sales.defaults,
      }).expect(400);
      await raw('put', admin, `/access-control/teams/${SALES_TEAM}/permissions`, {
        expectedVersion: 'latest',
        permissions: sales.defaults,
      }).expect(400);
    });

    it('refuses stale branch, person and new-delegation saves', async () => {
      const ops = await person(['OPERATIONS'], ['DXB']);
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const branchPage = (await get(admin, `/access-control/branches/${dxb}`).expect(200)).body as {
        version: string;
      };
      const personPage = (await get(admin, `/access-control/people/${ops.id}`).expect(200))
        .body as PersonAccessDto;
      expect(personPage.version).toBe(branchPage.version);
      await send('put', admin, `/access-control/branches/${jed}/blocked`, {
        permissions: [],
      }).expect(200);
      await send('put', admin, `/access-control/branches/${dxb}/blocked`, {
        expectedVersion: branchPage.version,
        permissions: ['bookings:view'],
      }).expect(409);
      await send('put', admin, `/access-control/people/${ops.id}/branches/${dxb}`, {
        expectedVersion: personPage.version,
        teamIds: [],
        allow: ['manual_journals:view'],
        deny: [],
      }).expect(409);
      await send('post', admin, '/access-control/delegations', {
        expectedVersion: branchPage.version,
        branchId: dxb,
        delegateUserId: manager.id,
        permissions: ['expenses:create'],
      }).expect(409);
      expect(await heldIn(ops.cookie, dxb)).not.toContain('manual_journals:view');
      expect(await t.prisma.branchDelegation.count({ where: { delegateUserId: manager.id } })).toBe(
        0,
      );
      // A save answers the view at the version it left behind: the next save from it goes through.
      const saved = (
        await send('put', admin, `/access-control/people/${ops.id}/branches/${dxb}`, {
          teamIds: [],
          allow: [],
          deny: [],
        }).expect(200)
      ).body as PersonAccessDto;
      expect(saved.version).toBe(await version());
      await send('put', admin, `/access-control/people/${ops.id}/branches/${dxb}`, {
        expectedVersion: saved.version,
        teamIds: [],
        allow: [],
        deny: [],
      }).expect(200);
    });

    it('applies a smaller ceiling or a revocation only from an unchanged preview', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const ops = await person(['OPERATIONS'], ['DXB']);
      const delegation = (
        await send('post', admin, '/access-control/delegations', {
          branchId: dxb,
          delegateUserId: manager.id,
          permissions: ['manual_journals:view', 'expenses:create'],
        }).expect(201)
      ).body as DelegationDto;
      const preview = (
        await send('post', admin, `/access-control/delegations/${delegation.id}/preview`, {
          permissions: ['expenses:create'],
        }).expect(200)
      ).body as DelegationChangeDto;
      expect(preview.dropped).toEqual([]);
      // In between, the delegate hands out manual_journals:view: the preview no longer says so.
      await send('put', manager.cookie, `/branch-access/${delegation.id}/people/${ops.id}`, {
        teamIds: [],
        allow: ['manual_journals:view'],
      }).expect(200);
      await send('put', admin, `/access-control/delegations/${delegation.id}/permissions`, {
        expectedVersion: preview.version,
        permissions: ['expenses:create'],
      }).expect(409);
      await send('post', admin, `/access-control/delegations/${delegation.id}/revoke`, {
        expectedVersion: preview.version,
      }).expect(409);
      expect(await heldIn(ops.cookie, dxb)).toContain('manual_journals:view');
      await raw('post', admin, `/access-control/delegations/${delegation.id}/revoke`, {}).expect(
        400,
      );

      // A fresh preview shows the drop, and applies from its own version.
      const again = (
        await send('post', admin, `/access-control/delegations/${delegation.id}/preview`, {
          permissions: ['expenses:create'],
        }).expect(200)
      ).body as DelegationChangeDto;
      expect(again.dropped.map((d) => d.permission)).toEqual(['manual_journals:view']);
      const applied = (
        await send('put', admin, `/access-control/delegations/${delegation.id}/permissions`, {
          expectedVersion: again.version,
          permissions: ['expenses:create'],
        }).expect(200)
      ).body as DelegationChangeDto;
      expect(applied.version).toBe(await version());
      expect(await heldIn(ops.cookie, dxb)).not.toContain('manual_journals:view');
    });

    it('refuses the delegate’s save from a screen read before another change', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const ops = await person(['OPERATIONS'], ['DXB']);
      const delegation = (
        await send('post', admin, '/access-control/delegations', {
          branchId: dxb,
          delegateUserId: manager.id,
          permissions: ['manual_journals:view'],
        }).expect(201)
      ).body as DelegationDto;
      const screen = (await get(manager.cookie, '/branch-access').expect(200))
        .body as MyDelegationDto[];
      await send('put', admin, `/access-control/branches/${jed}/blocked`, {
        permissions: [],
      }).expect(200);
      await send('put', manager.cookie, `/branch-access/${delegation.id}/people/${ops.id}`, {
        expectedVersion: screen[0]!.version,
        teamIds: [],
        allow: ['manual_journals:view'],
      }).expect(409);
      expect(await heldIn(ops.cookie, dxb)).not.toContain('manual_journals:view');
    });
  });

  describe('a delegate must keep roles that may hold a delegation (Codex F118-4)', () => {
    it('refuses giving the delegate a restricted role or the Administrator role', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      await send('post', admin, '/access-control/delegations', {
        branchId: dxb,
        delegateUserId: manager.id,
        permissions: ['manual_journals:view'],
      }).expect(201);
      await send('patch', admin, `/users/${manager.id}`, { roles: ['DRIVER'] }).expect(400);
      await send('patch', admin, `/users/${manager.id}`, { roles: ['ADMINISTRATOR'] }).expect(400);
      const roles = await t.prisma.userRole.findMany({ where: { userId: manager.id } });
      expect(roles.map((r) => r.role)).toEqual(['BRANCH_MANAGER']);
    });

    it('stops counting a delegation whose holder now holds a restricted role', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const ops = await person(['OPERATIONS'], ['DXB']);
      const delegation = (
        await send('post', admin, '/access-control/delegations', {
          branchId: dxb,
          delegateUserId: manager.id,
          permissions: ['manual_journals:view'],
        }).expect(201)
      ).body as DelegationDto;
      await send('put', manager.cookie, `/branch-access/${delegation.id}/people/${ops.id}`, {
        teamIds: [],
        allow: ['manual_journals:view'],
      }).expect(200);
      expect(await heldIn(ops.cookie, dxb)).toContain('manual_journals:view');

      // A role row written around the users screen (data from before the check): the delegation
      // gives nothing, the delegate's screen is empty and their save is refused.
      await t.prisma.userRole.updateMany({
        where: { userId: manager.id },
        data: { role: 'DRIVER' },
      });
      expect(await heldIn(ops.cookie, dxb)).not.toContain('manual_journals:view');
      const me = (await get(manager.cookie, '/auth/me').expect(200)).body as AuthMeResponse;
      expect(me.delegations).toEqual([]);
      expect((await get(manager.cookie, '/branch-access').expect(200)).body).toEqual([]);
      await send('put', manager.cookie, `/branch-access/${delegation.id}/people/${ops.id}`, {
        teamIds: [],
        allow: [],
      }).expect(403);
      const view = (await get(admin, `/access-control/people/${ops.id}`).expect(200))
        .body as PersonAccessDto;
      const inDxb = view.branches.find((b) => b.branchId === dxb)!;
      expect(inDxb.effective.map((e) => e.permission)).not.toContain('manual_journals:view');
    });
  });

  it('logs every change for the owner', async () => {
    const log = (await get(admin, '/access-control/log?limit=50').expect(200))
      .body as AuditLogEntryDto[];
    const entities = new Set(log.map((e) => e.entity));
    for (const e of ['TEAM', 'USER_ACCESS', 'BRANCH_LIMIT', 'DELEGATION']) {
      expect(entities, e).toContain(e);
    }
  });
});
