import type { AuthMeResponse } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../src/auth/session-token.js';
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

describe('sign-in, sessions and permissions', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('login', () => {
    it('sets a host-only, Secure, HttpOnly, SameSite=Lax session cookie', async () => {
      const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const res = await t
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', APP_ORIGIN)
        .send({ email: `  ${email.toUpperCase()} `, password: PASSWORD })
        .expect(204);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies).toHaveLength(1);
      const attributes = (cookies[0] ?? '').split('; ');
      expect(attributes[0]).toMatch(/^__Host-nolon_session=[A-Za-z0-9_-]{43}$/);
      expect(attributes).toEqual(
        expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
      );
      expect(attributes.some((a) => a.toLowerCase().startsWith('domain='))).toBe(false);
      expect(attributes.some((a) => a.startsWith('Expires='))).toBe(true);
    });

    it('stores only the hash of the token', async () => {
      const { id, email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      const token = cookie.split('=')[1] ?? '';
      const sessions = await t.prisma.session.findMany({ where: { userId: id } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.tokenHash).toBe(hashSessionToken(token));
      expect(sessions[0]?.tokenHash).not.toBe(token);
    });

    it('gives the same 401 for a wrong password, an unknown email and an inactive user', async () => {
      const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const inactive = await createUser(t.prisma, ['SALES'], ['DXB']);
      await t.prisma.user.update({ where: { id: inactive.id }, data: { isActive: false } });

      const attempts = [
        { email, password: 'wrong-password' },
        { email: 'it-nobody@nolon.test', password: PASSWORD },
        { email: inactive.email, password: PASSWORD },
      ];
      for (const body of attempts) {
        const res = await t
          .http()
          .post('/api/v1/auth/login')
          .set('Origin', APP_ORIGIN)
          .send(body)
          .expect(401);
        expect((res.body as { message: string }).message).toBe('Invalid email or password');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    });

    it('rejects a malformed body with 400', async () => {
      await t
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', APP_ORIGIN)
        .send({ email: 'x' })
        .expect(400);
    });
  });

  describe('session guard', () => {
    it('rejects requests with no cookie or an unknown token', async () => {
      await t.http().get('/api/v1/auth/me').expect(401);
      await t
        .http()
        .get('/api/v1/auth/me')
        .set('Cookie', '__Host-nolon_session=not-a-real-token')
        .expect(401);
    });

    it('keeps health public', async () => {
      await t.http().get('/api/v1/health').expect(200);
    });

    it('returns the user, roles, permissions and branches from /auth/me', async () => {
      const { id, email } = await createUser(t.prisma, ['SALES', 'FINANCE'], ['DXB', 'JED']);
      const cookie = await signIn(t, email);
      const res = await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      const me = res.body as AuthMeResponse;
      expect(me).toMatchObject({ id, email, roles: ['SALES', 'FINANCE'], allBranches: false });
      expect(me.permissions).toContain('quotations:create');
      expect(me.permissions).toContain('customer_invoices:approve');
      expect(me.permissions).not.toContain('users:view');
      expect(me.branches.map((b) => b.code)).toEqual(['DXB', 'JED']);
    });

    it('gives Administrator every branch through the role', async () => {
      const { email } = await createUser(t.prisma, ['ADMINISTRATOR']);
      const cookie = await signIn(t, email);
      const res = await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      const me = res.body as AuthMeResponse;
      expect(me.allBranches).toBe(true);
      expect(me.branches.length).toBeGreaterThanOrEqual(5);
    });
  });

  // Plan S3: deactivation, sign-out, expiry and role/branch changes apply to an existing cookie.
  describe('revocation takes effect at once', () => {
    it('rejects the same cookie after the user is deactivated', async () => {
      const { id, email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      await t.http().get('/api/v1/test-auth/protected').set('Cookie', cookie).expect(200);

      await t.prisma.user.update({ where: { id }, data: { isActive: false } });

      await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
      await t.http().get('/api/v1/test-auth/protected').set('Cookie', cookie).expect(401);
    });

    it('rejects the cookie after sign-out', async () => {
      const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      const res = await t
        .http()
        .post('/api/v1/auth/logout')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(/__Host-nolon_session=;/);
      await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    });

    it('rejects an expired session', async () => {
      const { id, email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      await t.prisma.session.updateMany({
        where: { userId: id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await t.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    });

    it('applies a removed role to the next request', async () => {
      const { id, email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      await t.http().get('/api/v1/test-auth/customers').set('Cookie', cookie).expect(200);
      await t.prisma.userRole.deleteMany({ where: { userId: id } });
      await t.http().get('/api/v1/test-auth/customers').set('Cookie', cookie).expect(403);
    });

    it('applies a removed branch to the next request', async () => {
      const { id, email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const dxb = await branchId(t.prisma, 'DXB');
      const cookie = await signIn(t, email);
      const path = `/api/v1/test-auth/branches/${dxb}/customers`;
      await t.http().get(path).set('Cookie', cookie).expect(200);
      await t.prisma.userBranch.deleteMany({ where: { userId: id } });
      await t.http().get(path).set('Cookie', cookie).expect(403);
    });
  });

  describe('permissions and branch scope', () => {
    it('returns 403 when a permission is missing', async () => {
      const { email } = await createUser(t.prisma, ['DRIVER'], ['KRT']);
      const cookie = await signIn(t, email);
      await t.http().get('/api/v1/test-auth/customers').set('Cookie', cookie).expect(403);
    });

    it('allows view but not create for a view-only role', async () => {
      const { email } = await createUser(t.prisma, ['OPERATIONS'], ['DXB']);
      const cookie = await signIn(t, email);
      await t.http().get('/api/v1/test-auth/customers').set('Cookie', cookie).expect(200);
      await t
        .http()
        .post('/api/v1/test-auth/customers')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .expect(403);
    });

    it('returns 403 for a branch the user is not assigned to', async () => {
      const { email } = await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']);
      const krt = await branchId(t.prisma, 'KRT');
      const cookie = await signIn(t, email);
      await t
        .http()
        .get(`/api/v1/test-auth/branches/${krt}/customers`)
        .set('Cookie', cookie)
        .expect(403);
    });

    it('lets Administrator reach any branch', async () => {
      const { email } = await createUser(t.prisma, ['ADMINISTRATOR']);
      const krt = await branchId(t.prisma, 'KRT');
      const cookie = await signIn(t, email);
      await t
        .http()
        .get(`/api/v1/test-auth/branches/${krt}/customers`)
        .set('Cookie', cookie)
        .expect(200);
    });
  });

  // Plan S2: CSRF.
  describe('cross-site writes', () => {
    it('blocks a write from a foreign origin even with a valid session', async () => {
      const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      await t
        .http()
        .post('/api/v1/test-auth/customers')
        .set('Origin', 'https://evil.test')
        .set('Cookie', cookie)
        .expect(403);
    });

    it('blocks a write with neither Origin nor Referer', async () => {
      const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      await t.http().post('/api/v1/test-auth/customers').set('Cookie', cookie).expect(403);
    });

    it('allows the write from the app origin, or a Referer on it', async () => {
      const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, email);
      await t
        .http()
        .post('/api/v1/test-auth/customers')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .expect(201);
      await t
        .http()
        .post('/api/v1/test-auth/customers')
        .set('Referer', `${APP_ORIGIN}/ar/customers`)
        .set('Cookie', cookie)
        .expect(201);
    });

    it('blocks a cross-site login (login CSRF)', async () => {
      const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
      await t
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', 'https://evil.test')
        .send({ email, password: PASSWORD })
        .expect(403);
    });
  });
});
