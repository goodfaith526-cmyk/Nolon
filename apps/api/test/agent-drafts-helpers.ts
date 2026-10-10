import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentAuthorizeResponse,
  AgentClientCreatedDto,
  AgentTokenResponse,
} from '@nolon/shared';
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
