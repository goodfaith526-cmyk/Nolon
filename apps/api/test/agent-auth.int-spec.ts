import { createHash, randomBytes } from 'node:crypto';
import type {
  AgentAuthorizeResponse,
  AgentClientCreatedDto,
  AgentTokenResponse,
  AuthMeResponse,
  CustomerSummaryDto,
  Page,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';

// Delegated sign-in of the staff AI assistant (agent-auth). Users here keep the agent-it- prefix:
// agent_access_events is append-only and references them, so they are never deleted.
const PREFIX = 'agent-it-';
const REDIRECT = 'https://agent.test/auth/nolon/callback';

let t: TestApp;
let adminCookie = '';
let client: AgentClientCreatedDto;
let otherClient: AgentClientCreatedDto;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(name: string): Promise<AgentClientCreatedDto> {
  const res = await t
    .http()
    .post('/api/v1/agent-clients')
    .set('Origin', APP_ORIGIN)
    .set('Cookie', adminCookie)
    .send({ name, redirectUri: REDIRECT, audience: 'erp-agents', tenant: 'nolon-staging' })
    .expect(201);
  return res.body as AgentClientCreatedDto;
}

async function authorize(
  cookie: string,
  challenge: string,
  c: AgentClientCreatedDto = client,
): Promise<{ code: string; redirectTo: string }> {
  const res = await t
    .http()
    .post('/api/v1/agent-auth/authorize')
    .set('Origin', APP_ORIGIN)
    .set('Cookie', cookie)
    .send({
      clientId: c.client.clientId,
      redirectUri: REDIRECT,
      state: 'state-1234',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    .expect(200);
  const { redirectTo } = res.body as AgentAuthorizeResponse;
  const code = new URL(redirectTo).searchParams.get('code');
  if (!code) throw new Error('No code');
  return { code, redirectTo };
}

/** Server to server: no Origin and no cookie, as the platform calls it. */
function exchange(
  code: string,
  verifier: string,
  c: AgentClientCreatedDto = client,
  secret?: string,
) {
  return t
    .http()
    .post('/api/v1/agent-auth/token')
    .send({
      clientId: c.client.clientId,
      clientSecret: secret ?? c.clientSecret,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });
}

async function tokenFor(cookie: string): Promise<AgentTokenResponse> {
  const { verifier, challenge } = pkce();
  const { code } = await authorize(cookie, challenge);
  const res = await exchange(code, verifier).expect(200);
  return res.body as AgentTokenResponse;
}

function asAgent(path: string, token: string) {
  return t.http().get(path).set('Authorization', `Bearer ${token}`);
}

async function staff(roles: Parameters<typeof createUser>[1] = ['SALES'], branches = ['DXB']) {
  const user = await createUser(t.prisma, roles, branches, PREFIX);
  return { ...user, cookie: await signIn(t, user.email) };
}

beforeAll(async () => {
  t = await createTestApp();
  const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], PREFIX);
  adminCookie = await signIn(t, admin.email);
  client = await registerClient('Agent platform');
  otherClient = await registerClient('Other platform');
});

afterAll(async () => {
  await t.close();
});

describe('agent clients', () => {
  it('shows the secret once and stores only its hash', async () => {
    expect(client.clientSecret).toMatch(/^nolags_/);
    expect(client.client.clientId).toMatch(/^nolagc_[0-9a-f]{24}$/);
    const row = await t.prisma.agentClient.findUniqueOrThrow({ where: { id: client.client.id } });
    expect(row.secretHash).not.toContain(client.clientSecret);
    const list = await t.http().get('/api/v1/agent-clients').set('Cookie', adminCookie).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(client.clientSecret);
  });

  it('can only be managed by those who manage users', async () => {
    const sales = await staff();
    await t.http().get('/api/v1/agent-clients').set('Cookie', sales.cookie).expect(403);
  });

  it('refuses a redirect URI that is not https', async () => {
    await t
      .http()
      .post('/api/v1/agent-clients')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', adminCookie)
      .send({ name: 'x', redirectUri: 'http://agent.test/cb', audience: 'a', tenant: 't' })
      .expect(400);
  });
});

describe('sign-in flow', () => {
  it('issues a one-time code to the registered address, then a short token for the user', async () => {
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code, redirectTo } = await authorize(user.cookie, challenge);
    const url = new URL(redirectTo);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect([...url.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(url.searchParams.get('state')).toBe('state-1234');

    const res = await exchange(code, verifier).expect(200);
    const token = res.body as AgentTokenResponse;
    expect(token.accessToken).toMatch(/^nolag_/);
    expect(redirectTo).not.toContain(token.accessToken);
    expect(token).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 600,
      subject: user.id,
      tenant: 'nolon-staging',
      audience: 'erp-agents',
    });
    expect(new Date(token.expiresAt).getTime() - new Date(token.issuedAt).getTime()).toBe(600_000);
    const stored = await t.prisma.agentToken.findUniqueOrThrow({ where: { id: token.jti } });
    expect(stored.tokenHash).not.toBe(token.accessToken);

    const me = await asAgent('/api/v1/auth/me', token.accessToken).expect(200);
    expect((me.body as AuthMeResponse).id).toBe(user.id);
  });

  it('needs a signed-in staff member to issue a code', async () => {
    await t
      .http()
      .post('/api/v1/agent-auth/authorize')
      .set('Origin', APP_ORIGIN)
      .send({
        clientId: client.client.clientId,
        redirectUri: REDIRECT,
        state: 'state-1234',
        codeChallenge: pkce().challenge,
        codeChallengeMethod: 'S256',
      })
      .expect(401);
  });

  it('never redirects to an unregistered address', async () => {
    const user = await staff();
    await t
      .http()
      .post('/api/v1/agent-auth/authorize')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        clientId: client.client.clientId,
        redirectUri: 'https://evil.test/cb',
        state: 'state-1234',
        codeChallenge: pkce().challenge,
        codeChallengeMethod: 'S256',
      })
      .expect(400);
  });

  it('accepts only the S256 PKCE method', async () => {
    const user = await staff();
    const { verifier } = pkce();
    await t
      .http()
      .post('/api/v1/agent-auth/authorize')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        clientId: client.client.clientId,
        redirectUri: REDIRECT,
        state: 'state-1234',
        codeChallenge: verifier,
        codeChallengeMethod: 'plain',
      })
      .expect(400);
  });

  it('does not let the assistant issue codes for itself', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await t
      .http()
      .post('/api/v1/agent-auth/authorize')
      .set('Origin', APP_ORIGIN)
      .set('Authorization', `Bearer ${token.accessToken}`)
      .send({
        clientId: client.client.clientId,
        redirectUri: REDIRECT,
        state: 'state-1234',
        codeChallenge: pkce().challenge,
        codeChallengeMethod: 'S256',
      })
      .expect(403);
  });
});

describe('code exchange', () => {
  it('refuses a wrong PKCE verifier, and the code is spent after it', async () => {
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(user.cookie, challenge);
    await exchange(code, pkce().verifier).expect(400);
    await exchange(code, verifier).expect(400);
  });

  it('refuses a reused code and revokes the token it produced', async () => {
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(user.cookie, challenge);
    const first = (await exchange(code, verifier).expect(200)).body as AgentTokenResponse;
    await asAgent('/api/v1/auth/me', first.accessToken).expect(200);
    await exchange(code, verifier).expect(400);
    await asAgent('/api/v1/auth/me', first.accessToken).expect(401);
  });

  it('gives at most one token for two concurrent exchanges, and revokes it', async () => {
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(user.cookie, challenge);
    const results = await Promise.all([exchange(code, verifier), exchange(code, verifier)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results.find((r) => r.status === 200)?.body as AgentTokenResponse;
    await asAgent('/api/v1/auth/me', winner.accessToken).expect(401);
    expect(await t.prisma.agentToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it('refuses an expired code', async () => {
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(user.cookie, challenge);
    await t.prisma.agentAuthCode.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1000) },
    });
    await exchange(code, verifier).expect(400);
  });

  it('refuses a wrong client secret, and another client presenting the code', async () => {
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(user.cookie, challenge);
    await exchange(code, verifier, client, otherClient.clientSecret).expect(401);
    await exchange(code, verifier, otherClient).expect(400);
  });

  it('refuses a code whose staff session has ended', async () => {
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(user.cookie, challenge);
    await t.http().post('/api/v1/auth/logout').set('Origin', APP_ORIGIN).set('Cookie', user.cookie);
    await exchange(code, verifier).expect(400);
  });
});

describe('acting with a token', () => {
  it('reads with the user’s own branches and roles, rechecked on every request', async () => {
    const user = await staff(['SALES'], ['DXB']);
    const token = await tokenFor(user.cookie);
    const dxb = await branchId(t.prisma, 'DXB');
    const me = (await asAgent('/api/v1/auth/me', token.accessToken).expect(200))
      .body as AuthMeResponse;
    expect(me.branches.map((b) => b.code)).toEqual(['DXB']);
    const list = (await asAgent('/api/v1/customers', token.accessToken).expect(200))
      .body as Page<CustomerSummaryDto>;
    for (const c of list.items) expect(c.branchId).toBe(dxb);

    // A branch taken away is gone on the next request, not at the next token.
    await t.prisma.userBranch.deleteMany({ where: { userId: user.id } });
    const after = (await asAgent('/api/v1/auth/me', token.accessToken).expect(200))
      .body as AuthMeResponse;
    expect(after.branches).toEqual([]);
  });

  it('still needs the route’s permission', async () => {
    const warehouse = await staff(['WAREHOUSE'], ['DXB']);
    const token = await tokenFor(warehouse.cookie);
    await asAgent('/api/v1/customer-invoices', token.accessToken).expect(403);
  });

  it('is refused on routes not opened to the assistant, and on every write', async () => {
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], PREFIX);
    const token = await tokenFor(await signIn(t, admin.email));
    await asAgent('/api/v1/users', token.accessToken).expect(403);
    await asAgent('/api/v1/agent-clients', token.accessToken).expect(403);
    await asAgent('/api/v1/reports/shipments/export', token.accessToken).expect(403);
    await t
      .http()
      .post('/api/v1/customers')
      .set('Origin', APP_ORIGIN)
      .set('Authorization', `Bearer ${token.accessToken}`)
      .send({})
      .expect(403);
  });

  it('ignores a session cookie sent with the token', async () => {
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], PREFIX);
    const adminSession = await signIn(t, admin.email);
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await asAgent('/api/v1/users', token.accessToken).set('Cookie', adminSession).expect(403);
  });

  it('logs every attempt with the real user and the agent, without query values', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await asAgent('/api/v1/customers?search=secret-name', token.accessToken).expect(200);
    await asAgent('/api/v1/users', token.accessToken).expect(403);
    const rows = await t.prisma.agentAccessEvent.findMany({
      where: { agentTokenId: token.jti },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => [r.userId, r.agentClientId, r.method, r.route, r.allowed])).toEqual([
      [user.id, client.client.id, 'GET', '/api/v1/customers', true],
      [user.id, client.client.id, 'GET', '/api/v1/users', false],
    ]);
    await expect(
      t.prisma.$executeRawUnsafe('UPDATE "agent_access_events" SET "allowed" = true'),
    ).rejects.toThrow(/cannot be changed/);
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE "agent_access_events"')).rejects.toThrow(
      /cannot be changed/,
    );
  });
});

describe('ending a token', () => {
  it('ends when it expires', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await t.prisma.agentToken.update({
      where: { id: token.jti },
      data: { issuedAt: new Date(Date.now() - 300_000), expiresAt: new Date(Date.now() - 1000) },
    });
    await asAgent('/api/v1/auth/me', token.accessToken).expect(401);
  });

  it('ends when the platform revokes it', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await t
      .http()
      .post('/api/v1/agent-auth/revoke')
      .send({
        clientId: client.client.clientId,
        clientSecret: client.clientSecret,
        token: token.accessToken,
      })
      .expect(204);
    await asAgent('/api/v1/auth/me', token.accessToken).expect(401);
  });

  it('is not revoked by another client', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await t
      .http()
      .post('/api/v1/agent-auth/revoke')
      .send({
        clientId: otherClient.client.clientId,
        clientSecret: otherClient.clientSecret,
        token: token.accessToken,
      })
      .expect(204);
    await asAgent('/api/v1/auth/me', token.accessToken).expect(200);
  });

  it('ends at once when the staff member signs out of NOLON', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await t.http().post('/api/v1/auth/logout').set('Origin', APP_ORIGIN).set('Cookie', user.cookie);
    await asAgent('/api/v1/auth/me', token.accessToken).expect(401);
  });

  it('ends at once when the staff member is deactivated', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await t.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    await asAgent('/api/v1/auth/me', token.accessToken).expect(401);
  });

  it('ends for every user when the Administrator revokes the client', async () => {
    const temp = await registerClient('Temporary platform');
    const user = await staff();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(user.cookie, challenge, temp);
    const token = (await exchange(code, verifier, temp).expect(200)).body as AgentTokenResponse;
    await asAgent('/api/v1/auth/me', token.accessToken).expect(200);
    await t
      .http()
      .post(`/api/v1/agent-clients/${temp.client.id}/revoke`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', adminCookie)
      .expect(200);
    await asAgent('/api/v1/auth/me', token.accessToken).expect(401);
    await exchange(code, verifier, temp).expect(401);
  });

  it('cannot be stored with a lifetime over 10 minutes (database check)', async () => {
    const user = await staff();
    const token = await tokenFor(user.cookie);
    await expect(
      t.prisma.agentToken.update({
        where: { id: token.jti },
        data: { expiresAt: new Date(new Date(token.issuedAt).getTime() + 11 * 60_000) },
      }),
    ).rejects.toThrow(/agent_tokens_lifetime_check/);
  });
});
