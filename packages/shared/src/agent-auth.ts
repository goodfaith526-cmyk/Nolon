/**
 * Delegated sign-in for the staff AI assistant (a separate platform). A signed-in staff member
 * gets a one-time code that the platform exchanges, server to server and with PKCE, for a short
 * access token. The token acts as that staff member with their own roles and branches, on
 * read-only routes the API marks for the assistant, and is checked again on every request. No
 * token ever appears in a URL, and the platform holds no long-lived refresh token.
 */

/** Access tokens: `Authorization: Bearer nolag_<43 base64url>`. */
export const AGENT_TOKEN_PREFIX = 'nolag_';
/** Public client ids: `nolagc_<24 hex>`. */
export const AGENT_CLIENT_ID_PREFIX = 'nolagc_';
/** Client secrets: `nolags_<43 base64url>`, shown once. */
export const AGENT_CLIENT_SECRET_PREFIX = 'nolags_';

/** POST /agent-auth/authorize, by the signed-in staff member (the web app's authorize page). */
export interface AgentAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  /** Opaque value the platform checks on return (CSRF on its side). */
  state: string;
  /** base64url(SHA-256(code_verifier)), 43 characters. */
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface AgentAuthorizeResponse {
  /** The registered redirect URI with `code` and `state` added. The code is single use. */
  redirectTo: string;
}

/** POST /agent-auth/token, server to server. */
export interface AgentTokenRequest {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface AgentTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  /** Seconds until expiresAt. */
  expiresIn: number;
  /** The token id (jti). */
  jti: string;
  /** The staff member the token acts for (user id). */
  subject: string;
  /** The platform's tenant reference registered for this client. */
  tenant: string;
  /** The platform the token is for, registered with the client. */
  audience: string;
  issuedAt: string;
  expiresAt: string;
}

/** POST /agent-auth/revoke, server to server. Always 204, as RFC 7009. */
export interface AgentRevokeRequest {
  clientId: string;
  clientSecret: string;
  token: string;
}

export interface AgentClientCreateRequest {
  name: string;
  /** Exact https URI the code is sent back to. */
  redirectUri: string;
  audience: string;
  tenant: string;
}

export interface AgentClientDto {
  id: string;
  name: string;
  clientId: string;
  redirectUri: string;
  audience: string;
  tenant: string;
  isActive: boolean;
  createdByName: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface AgentClientCreatedDto {
  client: AgentClientDto;
  /** Shown once. */
  clientSecret: string;
}
