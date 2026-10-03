import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/auth-user.js';
import { AuthService } from '../src/auth/auth.service.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { UsersService } from '../src/users/users.service.js';
import {
  PASSWORD,
  type TestApp,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';

// Review fixes: credential changes that interleave with a sign-in or a password change, and the
// "at least one active Administrator" invariant under concurrency. The interleavings are made
// deterministic by calling the second half of each operation after the competing change.

const CTX = { ip: '127.0.0.1', userAgent: 'test' };

describe('credential changes racing with sign-in and password change', () => {
  let t: TestApp;
  let auth: AuthService;
  let users: UsersService;

  beforeAll(async () => {
    t = await createTestApp();
    auth = t.app.get(AuthService);
    users = t.app.get(UsersService);
  });

  afterAll(async () => {
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  async function storedHash(id: string): Promise<string> {
    return (await t.prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;
  }

  it('a sign-in verified before an admin reset does not get a session after it', async () => {
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const verified = await storedHash(user.id); // the login checked PASSWORD against this
    await users.resetPassword(user.id, 'admin-chosen-password');
    await expect(auth.issueSession(user.id, verified, CTX)).resolves.toBeNull();
    expect(await t.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a sign-in verified before deactivation does not get a session after it', async () => {
    const actor = await createUser(t.prisma, ['ADMINISTRATOR']);
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const verified = await storedHash(user.id);
    await users.setActive(actor.id, user.id, false);
    await expect(auth.issueSession(user.id, verified, CTX)).resolves.toBeNull();
    // Reactivation does not revive anything: there is no late session to come back.
    await users.setActive(actor.id, user.id, true);
    expect(await t.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a sign-in and a reset at the same moment never leave a usable session on the old password', async () => {
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const verified = await storedHash(user.id);
    await Promise.all([
      auth.issueSession(user.id, verified, CTX),
      users.resetPassword(user.id, 'admin-chosen-password'),
    ]);
    const open = await t.prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(open).toBe(0);
  });

  it('a self password change checked before an admin reset does not overwrite the reset', async () => {
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const cookie = await signIn(t, user.email);
    const me = await auth.resolveSession(cookie.split('=')[1] ?? '');
    expect(me).not.toBeNull();
    const verified = await storedHash(user.id); // currentPassword was checked against this
    await users.resetPassword(user.id, 'admin-chosen-password');
    const changed = await auth.applyPasswordChange(
      me as AuthUser,
      verified,
      await hashPassword('self-chosen-password'),
    );
    expect(changed).toBe(false);
    expect(await verifyPassword('admin-chosen-password', await storedHash(user.id))).toBe(true);
  });

  it('login still works end to end with the current password', async () => {
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const result = await auth.login(user.email, PASSWORD, CTX);
    expect(result.ok).toBe(true);
  });
});

describe('at least one active Administrator, under concurrency', () => {
  let t: TestApp;
  let users: UsersService;
  let parked: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    users = t.app.get(UsersService);
  });

  afterAll(async () => {
    await t.prisma.user.updateMany({ where: { id: { in: parked } }, data: { isActive: true } });
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  /** Leaves exactly two active administrators: the two returned. */
  async function twoAdminsOnly(): Promise<[string, string]> {
    const a = await createUser(t.prisma, ['ADMINISTRATOR']);
    const b = await createUser(t.prisma, ['ADMINISTRATOR']);
    const others = await t.prisma.user.findMany({
      where: {
        isActive: true,
        id: { notIn: [a.id, b.id] },
        roles: { some: { role: 'ADMINISTRATOR' } },
      },
      select: { id: true },
    });
    parked = [...parked, ...others.map((o) => o.id)];
    await t.prisma.user.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { isActive: false },
    });
    return [a.id, b.id];
  }

  async function activeAdmins(): Promise<number> {
    return t.prisma.user.count({
      where: { isActive: true, roles: { some: { role: 'ADMINISTRATOR' } } },
    });
  }

  it('two admins deactivating each other at once: one succeeds, one is rejected', async () => {
    const [a, b] = await twoAdminsOnly();
    const results = await Promise.allSettled([
      users.setActive(a, b, false),
      users.setActive(b, a, false),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await activeAdmins()).toBe(1);
  });

  it('two concurrent demotions: one succeeds, one is rejected', async () => {
    const [a, b] = await twoAdminsOnly();
    const results = await Promise.allSettled([
      users.update(a, { roles: ['MANAGEMENT'] }),
      users.update(b, { roles: ['MANAGEMENT'] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await activeAdmins()).toBe(1);
  });
});
