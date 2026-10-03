import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  PASSWORD,
  type TestApp,
  createTestApp,
  createUser,
  deleteTestUsers,
} from './auth-test-app.js';

// Plan S1: failed sign-in limits, keyed on the real client IP behind a known number of proxies.

function login(t: TestApp, email: string, password: string, forwardedFor?: string) {
  const req = t.http().post('/api/v1/auth/login').set('Origin', APP_ORIGIN);
  if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
  return req.send({ email, password });
}

async function failMany(t: TestApp, count: number, forwardedFor: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    // A different unknown email each time, so only the per-IP bucket fills up.
    await login(t, `it-unknown-${i}-${Date.now()}@nolon.test`, 'x', forwardedFor).expect(401);
  }
}

describe('failed sign-in limits', () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    if (t) {
      await deleteTestUsers(t.prisma);
      await t.close();
      t = undefined;
    }
  });

  afterAll(async () => {
    if (t) await t.close();
  });

  it('blocks an email after 10 failures, even with the right password', async () => {
    t = await createTestApp();
    const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
    for (let i = 0; i < 10; i += 1) await login(t, email, 'wrong').expect(401);
    const res = await login(t, email, PASSWORD).expect(429);
    expect((res.body as { message: string }).message).toMatch(/Too many attempts/);
  });

  it('a success resets the email counter', async () => {
    t = await createTestApp();
    const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
    for (let i = 0; i < 9; i += 1) await login(t, email, 'wrong').expect(401);
    await login(t, email, PASSWORD).expect(204);
    for (let i = 0; i < 9; i += 1) await login(t, email, 'wrong').expect(401);
    await login(t, email, PASSWORD).expect(204);
  });

  it('keeps separate per-IP buckets for different clients behind a trusted proxy', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: 1 });
    const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
    await failMany(t, 50, '203.0.113.10');
    await login(t, email, PASSWORD, '203.0.113.10').expect(429);
    await login(t, email, PASSWORD, '203.0.113.20').expect(204);
  });

  it('ignores forged entries added in front of the trusted hop', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: 1 });
    const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
    // The proxy appends the address it saw (198.51.100.7); a client cannot escape its bucket by
    // prepending other addresses.
    await failMany(t, 50, '198.51.100.7');
    await login(t, email, PASSWORD, '192.0.2.99, 198.51.100.7').expect(429);
    await login(t, email, PASSWORD, '10.0.0.1, 192.0.2.98, 198.51.100.7').expect(429);
  });

  it('with no trusted proxies, X-Forwarded-For is ignored', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: 0 });
    const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
    await failMany(t, 50, '203.0.113.30');
    // Every request comes from the same socket, so a different header does not help.
    await login(t, email, PASSWORD, '203.0.113.31').expect(429);
  });

  it('with the IP limit disabled, a shared address never locks everyone out', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: 0, LOGIN_IP_LIMIT_ENABLED: false });
    const { email } = await createUser(t.prisma, ['SALES'], ['DXB']);
    await failMany(t, 50, '203.0.113.40');
    await login(t, email, PASSWORD).expect(204);
  });
});
