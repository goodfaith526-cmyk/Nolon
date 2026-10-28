import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { ROLES, ROLE_PERMISSIONS, type AuthMeResponse, type Permission } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAccess } from '../src/access-control/access-loader.js';
import { AccessChangedException } from '../src/access-control/access-lock.js';
import {
  requestAccessContext,
  setRequestAccessVersion,
} from '../src/access-control/request-access.js';
import { UsersService } from '../src/users/users.service.js';
import {
  type TestApp,
  actorAt,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';

// Plan 03 (docs/plans/03-permissions-screen.md), P-1: permissions held per branch, the database
// guards of the new tables, and the access_state lock between writes and changes of access.

const OWNER = '00000000-0000-0000-0000-000000000000';
const TEAM = {
  SALES: '5a0e0000-0000-4000-8000-000000000004',
  DRIVER: '5a0e0000-0000-4000-8000-000000000009',
  OUTLET_STAFF: '5a0e0000-0000-4000-8000-00000000000b',
};

describe('access control (plan 03, P-1)', () => {
  let t: TestApp;
  let dxb: string;
  let jed: string;
  let admin: { id: string; email: string };
  const touched: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    admin = await createUser(t.prisma, ['ADMINISTRATOR']);
    touched.push(admin.id);
  });

  afterAll(async () => {
    // Rows naming a test user as their author block deleting that user (onDelete: Restrict).
    const users = { in: touched };
    await t.prisma.userBranchPermission.deleteMany({ where: { createdById: users } });
    await t.prisma.userBranchTeam.deleteMany({ where: { createdById: users } });
    await t.prisma.branchDelegation.deleteMany({ where: { createdById: users } });
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  async function person(roles: Parameters<typeof createUser>[1], branches = ['DXB', 'JED']) {
    const user = await createUser(t.prisma, roles, branches);
    touched.push(user.id);
    return user;
  }

  async function bump(): Promise<void> {
    await t.prisma.accessState.update({ where: { id: 1 }, data: { version: { increment: 1 } } });
  }

  async function me(cookie: string): Promise<AuthMeResponse> {
    const res = await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    return res.body as AuthMeResponse;
  }

  /** Runs `fn` as a request whose access was computed at `version`. */
  function asRequest<R>(version: string, fn: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      requestAccessContext({} as Request, {} as Response, () => {
        setRequestAccessVersion(version);
        fn().then(resolve, reject);
      });
    });
  }

  async function currentVersion(): Promise<string> {
    return (await t.prisma.accessState.findUniqueOrThrow({ where: { id: 1 } })).version.toString();
  }

  describe('per branch', () => {
    it('leaves every existing user exactly their role defaults, in each branch', async () => {
      for (const role of ROLES) {
        const access = await loadAccess(t.prisma, randomUUID(), [role], [dxb, jed]);
        for (const b of [dxb, jed]) {
          expect(access.inBranch(b), role).toEqual([...ROLE_PERMISSIONS[role]].sort());
        }
      }
    });

    it('takes a permission away in one branch only (owner DENY)', async () => {
      const user = await person(['SALES']);
      await t.prisma.userBranchPermission.create({
        data: {
          userId: user.id,
          branchId: jed,
          permission: 'customers:view',
          effect: 'DENY',
          sourceKey: OWNER,
          createdById: admin.id,
        },
      });
      await bump();
      const cookie = await signIn(t, user.email);
      await t
        .http()
        .get(`/api/v1/test-auth/branches/${dxb}/customers`)
        .set('Cookie', cookie)
        .expect(200);
      await t
        .http()
        .get(`/api/v1/test-auth/branches/${jed}/customers`)
        .set('Cookie', cookie)
        .expect(403);
      // A route that names no branch still works: the permission is held in DXB.
      await t.http().get('/api/v1/test-auth/customers').set('Cookie', cookie).expect(200);

      const body = await me(cookie);
      const held = (b: string) =>
        body.branchPermissions?.find((p) => p.branchId === b)?.permissions;
      expect(held(dxb)).toContain('customers:view');
      expect(held(jed)).not.toContain('customers:view');
      // The flat list stays the union, as before (the assistant reads it).
      expect(body.permissions).toContain('customers:view');
      expect(body.roles).toEqual(['SALES']);
    });

    it('gives an added permission in its branch only', async () => {
      const user = await person(['OPERATIONS']);
      const added: Permission = 'manual_journals:view';
      expect(ROLE_PERMISSIONS.OPERATIONS.has(added)).toBe(false);
      await t.prisma.userBranchPermission.create({
        data: {
          userId: user.id,
          branchId: dxb,
          permission: added,
          effect: 'ALLOW',
          sourceKey: OWNER,
          createdById: admin.id,
        },
      });
      await bump();
      const body = await me(await signIn(t, user.email));
      const held = (b: string) =>
        body.branchPermissions?.find((p) => p.branchId === b)?.permissions;
      expect(held(dxb)).toContain(added);
      expect(held(jed)).not.toContain(added);
    });

    it('stops a delegated grant once its delegation is revoked', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const user = await person(['OPERATIONS'], ['DXB']);
      const added: Permission = 'manual_journals:view';
      const delegation = await t.prisma.branchDelegation.create({
        data: {
          branchId: dxb,
          delegateUserId: manager.id,
          createdById: admin.id,
          permissions: { create: [{ permission: added }] },
        },
      });
      await t.prisma.userBranchPermission.create({
        data: {
          userId: user.id,
          branchId: dxb,
          permission: added,
          effect: 'ALLOW',
          delegationId: delegation.id,
          sourceKey: delegation.id,
          createdById: manager.id,
        },
      });
      const rolesOf = ['OPERATIONS'] as const;
      expect((await loadAccess(t.prisma, user.id, rolesOf, [dxb])).has(added, dxb)).toBe(true);
      await t.prisma.branchDelegation.update({
        where: { id: delegation.id },
        data: { revokedAt: new Date(), revokedById: admin.id },
      });
      expect((await loadAccess(t.prisma, user.id, rolesOf, [dxb])).has(added, dxb)).toBe(false);
    });
  });

  describe('database guards', () => {
    it('refuses a DENY that does not come from the owner', async () => {
      const manager = await person(['BRANCH_MANAGER'], ['DXB']);
      const user = await person(['SALES'], ['DXB']);
      const delegation = await t.prisma.branchDelegation.create({
        data: { branchId: dxb, delegateUserId: manager.id, createdById: admin.id },
      });
      await expect(
        t.prisma.userBranchPermission.create({
          data: {
            userId: user.id,
            branchId: dxb,
            permission: 'customers:view',
            effect: 'DENY',
            delegationId: delegation.id,
            sourceKey: delegation.id,
            createdById: manager.id,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a source key that does not match the source', async () => {
      const user = await person(['SALES'], ['DXB']);
      await expect(
        t.prisma.userBranchPermission.create({
          data: {
            userId: user.id,
            branchId: dxb,
            permission: 'customers:view',
            effect: 'ALLOW',
            sourceKey: TEAM.SALES,
            createdById: admin.id,
          },
        }),
      ).rejects.toThrow();
    });

    it('never widens a restricted team (driver, outlet staff)', async () => {
      for (const teamId of [TEAM.DRIVER, TEAM.OUTLET_STAFF]) {
        await expect(
          t.prisma.teamPermissionChange.create({
            data: { teamId, permission: 'customers:view', effect: 'ALLOW', createdById: admin.id },
          }),
        ).rejects.toThrow();
        const user = await person(['SALES'], ['DXB']);
        await expect(
          t.prisma.userBranchTeam.create({
            data: {
              userId: user.id,
              teamId,
              branchId: dxb,
              sourceKey: OWNER,
              createdById: admin.id,
            },
          }),
        ).rejects.toThrow();
      }
    });

    it("keeps a team's code, role and restriction fixed", async () => {
      await expect(
        t.prisma.team.update({ where: { id: TEAM.DRIVER }, data: { restricted: false } }),
      ).rejects.toThrow();
      await expect(
        t.prisma.team.update({ where: { id: TEAM.SALES }, data: { code: 'SELLERS' } }),
      ).rejects.toThrow();
      await expect(
        t.prisma.team.create({
          data: { code: 'it-team', nameAr: 'x', nameEn: 'x', restricted: true },
        }),
      ).rejects.toThrow();
    });
  });

  describe('the access_state lock', () => {
    it('refuses a write transaction of a request checked at an older version (409)', async () => {
      const stale = await currentVersion();
      await bump();
      await expect(
        asRequest(stale, () => t.prisma.$transaction(async (tx) => tx.branch.count())),
      ).rejects.toBeInstanceOf(AccessChangedException);
      const now = await currentVersion();
      await expect(
        asRequest(now, () => t.prisma.$transaction(async (tx) => tx.branch.count())),
      ).resolves.toBeGreaterThan(0);
    });

    it('makes a change of access wait for a write already running, then refuses later writes', async () => {
      const version = await currentVersion();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const order: string[] = [];
      let locked!: () => void;
      const hasLock = new Promise<void>((r) => (locked = r));

      const write = asRequest(version, () =>
        t.prisma.$transaction(async (tx) => {
          locked(); // the SHARE lock is taken before the callback runs
          await gate;
          order.push('write committed');
          return tx.branch.count();
        }),
      );
      await hasLock;
      const change = t.prisma
        .changeAccess(version, () => {
          order.push('change ran');
          return Promise.resolve();
        })
        .then(() => order.push('change committed'));
      // Give the change time to reach the lock; it must still be waiting.
      await new Promise((r) => setTimeout(r, 200));
      expect(order).toEqual([]);
      release();
      await write;
      await change;
      expect(order).toEqual(['write committed', 'change ran', 'change committed']);

      // The same request (older version) can no longer write.
      await expect(
        asRequest(version, () => t.prisma.$transaction(async (tx) => tx.branch.count())),
      ).rejects.toBeInstanceOf(AccessChangedException);
    });

    it('refuses an admin change made from a page checked before another change', async () => {
      const users = t.app.get(UsersService);
      const user = await person(['SALES'], ['DXB']);
      const actor = await actorAt(t.prisma, admin.id);
      await bump();
      await expect(users.setActive(actor, user.id, false)).rejects.toBeInstanceOf(
        AccessChangedException,
      );
      await expect(
        users.setActive(await actorAt(t.prisma, admin.id), user.id, false),
      ).resolves.toMatchObject({ isActive: false });
    });

    it('rechecks the actor under the lock: a demoted admin can no longer change access', async () => {
      const users = t.app.get(UsersService);
      const former = await person(['ADMINISTRATOR'], []);
      const user = await person(['SALES'], ['DXB']);
      await t.prisma.userRole.updateMany({ where: { userId: former.id }, data: { role: 'SALES' } });
      await expect(
        users.setActive(await actorAt(t.prisma, former.id), user.id, false),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('raises the version with every change of access', async () => {
      const users = t.app.get(UsersService);
      const user = await person(['SALES'], ['DXB']);
      const before = BigInt(await currentVersion());
      await users.update(await actorAt(t.prisma, admin.id), user.id, { fullName: 'Renamed' });
      expect(BigInt(await currentVersion())).toBe(before + 1n);
    });
  });

  it('refuses giving a restricted role to a person with a team or an added permission', async () => {
    const users = t.app.get(UsersService);
    const user = await person(['SALES'], ['DXB']);
    await t.prisma.userBranchPermission.create({
      data: {
        userId: user.id,
        branchId: dxb,
        permission: 'manual_journals:view',
        effect: 'ALLOW',
        sourceKey: OWNER,
        createdById: admin.id,
      },
    });
    await expect(
      users.update(await actorAt(t.prisma, admin.id), user.id, { roles: ['DRIVER'] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
