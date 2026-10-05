import type { AuditLogDto, UserSummary } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  PASSWORD,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';

const NEW_PASSWORD = 'another-long-password';

describe('users administration', () => {
  let t: TestApp;
  let admin: { id: string; email: string };
  let adminCookie: string;
  let dxb: string;
  let jed: string;

  function post(path: string, cookie: string, body?: object) {
    return t.http().post(path).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  }

  function patch(path: string, cookie: string, body: object) {
    return t.http().patch(path).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  }

  function newUserBody(overrides: object = {}) {
    return {
      email: `it-new-${Date.now()}-${Math.random().toString(36).slice(2)}@nolon.test`,
      fullName: 'New Staff',
      password: PASSWORD,
      preferredLocale: 'ar',
      roles: ['SALES'],
      branchIds: [dxb],
      ...overrides,
    };
  }

  beforeAll(async () => {
    t = await createTestApp();
    admin = await createUser(t.prisma, ['ADMINISTRATOR']);
    adminCookie = await signIn(t, admin.email);
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
  });

  afterAll(async () => {
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('only Administrator can list or create users', async () => {
    const manager = await createUser(t.prisma, ['BRANCH_MANAGER', 'FINANCE'], ['DXB']);
    const cookie = await signIn(t, manager.email);
    await t.http().get('/api/v1/users').set('Cookie', cookie).expect(403);
    await post('/api/v1/users', cookie, newUserBody()).expect(403);
    await t.http().get('/api/v1/users').expect(401);
    await t.http().get('/api/v1/users').set('Cookie', adminCookie).expect(200);
  });

  it('creates a user who can then sign in, with normalized email', async () => {
    const body = newUserBody({ roles: ['SALES', 'OPERATIONS'], branchIds: [dxb, jed] });
    const res = await post('/api/v1/users', adminCookie, {
      ...body,
      email: body.email.toUpperCase(),
    }).expect(201);
    const created = res.body as UserSummary;
    expect(created).toMatchObject({
      email: body.email,
      roles: ['SALES', 'OPERATIONS'],
      isActive: true,
    });
    expect(created.branchIds.sort()).toEqual([dxb, jed].sort());
    expect(JSON.stringify(created)).not.toContain('passwordHash');
    await signIn(t, body.email);
  });

  it('rejects a duplicate email, a short password, a bad role and a missing branch', async () => {
    const body = newUserBody();
    await post('/api/v1/users', adminCookie, body).expect(201);
    await post('/api/v1/users', adminCookie, body).expect(409);
    await post('/api/v1/users', adminCookie, newUserBody({ password: 'short' })).expect(400);
    await post('/api/v1/users', adminCookie, newUserBody({ roles: ['ROOT'] })).expect(400);
    await post('/api/v1/users', adminCookie, newUserBody({ roles: [] })).expect(400);
    await post('/api/v1/users', adminCookie, newUserBody({ branchIds: [] })).expect(400);
    await post(
      '/api/v1/users',
      adminCookie,
      newUserBody({ branchIds: ['00000000-0000-4000-8000-000000000000'] }),
    ).expect(400);
  });

  it('lets an all-branch role have no branch', async () => {
    await post(
      '/api/v1/users',
      adminCookie,
      newUserBody({ roles: ['MANAGEMENT'], branchIds: [] }),
    ).expect(201);
  });

  it('changes roles and branches, effective on the next request', async () => {
    const user = await createUser(t.prisma, ['DRIVER'], ['DXB']);
    const cookie = await signIn(t, user.email);
    await t.http().get('/api/v1/test-auth/customers').set('Cookie', cookie).expect(403);

    const res = await patch(`/api/v1/users/${user.id}`, adminCookie, {
      roles: ['SALES'],
      branchIds: [jed],
    }).expect(200);
    expect(res.body as UserSummary).toMatchObject({ roles: ['SALES'], branchIds: [jed] });

    await t.http().get('/api/v1/test-auth/customers').set('Cookie', cookie).expect(200);
    await t
      .http()
      .get(`/api/v1/test-auth/branches/${dxb}/customers`)
      .set('Cookie', cookie)
      .expect(403);
    await t
      .http()
      .get(`/api/v1/test-auth/branches/${jed}/customers`)
      .set('Cookie', cookie)
      .expect(200);
  });

  it('deactivation ends the user sessions at once; activation allows sign-in again', async () => {
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const cookie = await signIn(t, user.email);
    const res = await post(`/api/v1/users/${user.id}/deactivate`, adminCookie).expect(200);
    expect((res.body as UserSummary).isActive).toBe(false);

    await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    const open = await t.prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(open).toBe(0);
    await t
      .http()
      .post('/api/v1/auth/login')
      .set('Origin', APP_ORIGIN)
      .send({ email: user.email, password: PASSWORD })
      .expect(401);

    await post(`/api/v1/users/${user.id}/activate`, adminCookie).expect(200);
    await signIn(t, user.email);
  });

  it('an administrator cannot deactivate themselves', async () => {
    await post(`/api/v1/users/${admin.id}/deactivate`, adminCookie).expect(400);
  });

  it('never leaves the system without an active Administrator', async () => {
    // Make this test's admin the only active one.
    const others = await t.prisma.user.findMany({
      where: { isActive: true, id: { not: admin.id }, roles: { some: { role: 'ADMINISTRATOR' } } },
      select: { id: true },
    });
    await t.prisma.user.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { isActive: false },
    });
    try {
      await patch(`/api/v1/users/${admin.id}`, adminCookie, {
        roles: ['FINANCE'],
        branchIds: [dxb],
      }).expect(409);
      const after = await t.prisma.userRole.findMany({ where: { userId: admin.id } });
      expect(after.map((r) => r.role)).toEqual(['ADMINISTRATOR']);
    } finally {
      await t.prisma.user.updateMany({
        where: { id: { in: others.map((o) => o.id) } },
        data: { isActive: true },
      });
    }
  });

  it('password reset sets the new password and ends the user sessions', async () => {
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const cookie = await signIn(t, user.email);
    await post(`/api/v1/users/${user.id}/password`, adminCookie, { password: 'short' }).expect(400);
    await post(`/api/v1/users/${user.id}/password`, adminCookie, {
      password: NEW_PASSWORD,
    }).expect(204);
    await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    await signIn(t, user.email, NEW_PASSWORD);
  });

  it('logs account changes, never the password, for those who manage users only', async () => {
    const created = (await post('/api/v1/users', adminCookie, newUserBody()).expect(201))
      .body as UserSummary;
    await patch(`/api/v1/users/${created.id}`, adminCookie, {
      fullName: 'Renamed Staff',
      roles: ['SALES', 'OPERATIONS'],
    }).expect(200);
    await post(`/api/v1/users/${created.id}/password`, adminCookie, {
      password: NEW_PASSWORD,
    }).expect(204);
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const query = `from=${day(-1)}&to=${day(1)}&userId=${admin.id}&entity=USER`;
    const log = async (cookie: string, extra = '') =>
      (
        (
          await t
            .http()
            .get(`/api/v1/reports/audit-log?${query}${extra}`)
            .set('Cookie', cookie)
            .expect(200)
        ).body as AuditLogDto
      ).entries.filter((e) => e.reference.includes(created.email));

    const entries = await log(adminCookie);
    expect(entries.map((e) => e.action)).toEqual(['UPDATED', 'UPDATED', 'CREATED']);
    const [reset, edit, creation] = entries;
    expect(reset?.changes).toEqual([{ field: 'password', before: null, after: 'reset' }]);
    expect(edit?.changes).toEqual([
      { field: 'fullName', before: 'New Staff', after: 'Renamed Staff' },
      { field: 'roles', before: 'SALES', after: 'OPERATIONS, SALES' },
    ]);
    expect(creation?.changes).toEqual(
      expect.arrayContaining([
        { field: 'roles', before: null, after: 'SALES' },
        { field: 'branches', before: null, after: 'DXB' },
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
    expect(entries.every((e) => e.branchCode === '—' && e.source === 'USER')).toBe(true);

    // Not for a branch's view, nor for a role that reads the log but does not manage users.
    expect(await log(adminCookie, `&branchId=${dxb}`)).toEqual([]);
    const management = await createUser(t.prisma, ['MANAGEMENT']);
    expect(await log(await signIn(t, management.email))).toEqual([]);
  });

  it('returns 404 for an unknown user and 400 for a bad id', async () => {
    await patch('/api/v1/users/00000000-0000-4000-8000-000000000000', adminCookie, {
      fullName: 'X',
    }).expect(404);
    await patch('/api/v1/users/not-a-uuid', adminCookie, { fullName: 'X' }).expect(400);
  });
});

describe('changing your own password', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('needs the current password, keeps this session and ends the others', async () => {
    const user = await createUser(t.prisma, ['SALES'], ['DXB']);
    const here = await signIn(t, user.email);
    const elsewhere = await signIn(t, user.email);
    const change = (body: object) =>
      t
        .http()
        .post('/api/v1/auth/password')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', here)
        .send(body);

    await change({ currentPassword: 'wrong', newPassword: NEW_PASSWORD }).expect(400);
    await change({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
    await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

    await t.http().get('/api/v1/auth/me').set('Cookie', here).expect(200);
    await t.http().get('/api/v1/auth/me').set('Cookie', elsewhere).expect(401);
    await signIn(t, user.email, NEW_PASSWORD);
  });
});
