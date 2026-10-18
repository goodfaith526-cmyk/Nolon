import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentAuthorizeResponse,
  AgentClientCreatedDto,
  AgentTokenResponse,
} from '@nolon/shared';
import { expect, vi } from 'vitest';
import { APP_ORIGIN, type TestApp } from './auth-test-app.js';

// Shared by the entry draft integration tests: requests as a person (session cookie) and as the
// staff assistant (delegated token), and the assistant's sign-in. Users acting through the
// assistant keep the agent-it- prefix: agent_access_events is append-only and references them,
// so they are never deleted.

export const AGENT_PREFIX = 'agent-it-';
const REDIRECT = 'https://agent.test/auth/nolon/callback';

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export const draftKey = () => `turn-${randomUUID()}`;

export function requests(t: TestApp) {
  return {
    get: (path: string, cookie: string) => t.http().get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, cookie: string, body: object = {}) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    patch: (path: string, cookie: string, body: object = {}) =>
      t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    agentPatch: (path: string, token: string, body: object = {}) =>
      t.http().patch(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, cookie: string, body: object = {}) =>
      t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    agentGet: (path: string, token: string) =>
      t.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
    agentPost: (path: string, token: string, body: object = {}) =>
      t.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
  };
}

export async function registerClient(
  t: TestApp,
  adminCookie: string,
  name: string,
): Promise<AgentClientCreatedDto> {
  const res = await requests(t)
    .post('/agent-clients', adminCookie, {
      name,
      redirectUri: REDIRECT,
      audience: 'erp-agents',
      tenant: 'nolon-test',
    })
    .expect(201);
  return res.body as AgentClientCreatedDto;
}

/** The delegated sign-in (PKCE) a staff member makes from the assistant; its token. */
export async function tokenFor(
  t: TestApp,
  cookie: string,
  client: AgentClientCreatedDto,
): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorized = await requests(t)
    .post('/agent-auth/authorize', cookie, {
      clientId: client.client.clientId,
      redirectUri: REDIRECT,
      state: 'state-1234',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    .expect(200);
  const code = new URL((authorized.body as AgentAuthorizeResponse).redirectTo).searchParams.get(
    'code',
  );
  const res = await t
    .http()
    .post('/api/v1/agent-auth/token')
    .send({
      clientId: client.client.clientId,
      clientSecret: client.clientSecret,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    })
    .expect(200);
  return (res.body as AgentTokenResponse).accessToken;
}

/**
 * An approval refused by the kind's completeness and validity gate (no-required-fields plan,
 * 3.3): 422 DRAFT_INCOMPLETE naming what the draft misses and what it holds that is invalid.
 */
export function expectGateRefusal(
  res: { status: number; body: unknown },
  missing: string[],
  invalid: string[] = [],
): void {
  expect(res.status).toBe(422);
  expect(res.body).toMatchObject({
    statusCode: 422,
    code: 'DRAFT_INCOMPLETE',
    missingFields: missing,
    invalidFields: invalid,
    fields: [...missing, ...invalid],
  });
}

/**
 * Runs `request` with the user's membership of `branchId` removed just as `serviceFile` (e.g.
 * '/customer-drafts.service') starts a transaction: after the service checked the request against
 * the branches the user's request loaded, before its write. Says whether that moment came.
 */
export async function revokedBeforeTransaction<T>(
  t: TestApp,
  serviceFile: string,
  membership: { userId: string; branchId: string },
  request: () => Promise<T>,
): Promise<{ result: T; revoked: boolean }> {
  const original = t.prisma.$transaction.bind(t.prisma) as (...args: unknown[]) => Promise<unknown>;
  let revoked = false;
  const spy = vi.spyOn(t.prisma, '$transaction').mockImplementation((...args: unknown[]) => {
    if (!revoked && new Error().stack?.includes(serviceFile)) {
      revoked = true;
      return t.prisma.userBranch.deleteMany({ where: membership }).then(() => original(...args));
    }
    return original(...args);
  });
  try {
    return { result: await request(), revoked };
  } finally {
    spy.mockRestore();
    await t.prisma.userBranch.upsert({
      where: { userId_branchId: membership },
      create: membership,
      update: {},
    });
  }
}
