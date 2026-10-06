import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AGENT_CLIENT_ID_PREFIX,
  AGENT_CLIENT_SECRET_PREFIX,
  AGENT_TOKEN_PREFIX,
} from '@nolon/shared';

/**
 * Secrets of the assistant's delegated sign-in. Each is 32 random bytes; only its SHA-256 (hex) is
 * stored, as for session tokens: values this random need no slow hash.
 */

const RANDOM_PART = '[A-Za-z0-9_-]{43}';
const TOKEN_PATTERN = new RegExp(`^${AGENT_TOKEN_PREFIX}${RANDOM_PART}$`);
const SECRET_PATTERN = new RegExp(`^${AGENT_CLIENT_SECRET_PREFIX}${RANDOM_PART}$`);
const CODE_PATTERN = new RegExp(`^${RANDOM_PART}$`);
export const CLIENT_ID_PATTERN = new RegExp(`^${AGENT_CLIENT_ID_PREFIX}[0-9a-f]{24}$`);
/** RFC 7636: 43 to 128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function random32(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newClientId(): string {
  return `${AGENT_CLIENT_ID_PREFIX}${randomBytes(12).toString('hex')}`;
}

export function newClientSecret(): string {
  return `${AGENT_CLIENT_SECRET_PREFIX}${random32()}`;
}

export function newAuthCode(): string {
  return random32();
}

export function newAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${random32()}`;
}

export function isAgentTokenShape(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function isAuthCodeShape(value: string): boolean {
  return CODE_PATTERN.test(value);
}

/** Compares a presented secret with its stored hash in constant time. */
export function secretMatches(presented: string, storedHash: string): boolean {
  if (!SECRET_PATTERN.test(presented)) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** PKCE S256: base64url(SHA-256(verifier)) must equal the challenge, compared in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier) || !CHALLENGE_PATTERN.test(challenge)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

const AGENT_BEARER_PATTERN = new RegExp(`^bearer\\s+${AGENT_TOKEN_PREFIX}`, 'i');

/**
 * True when the header presents an assistant token (`Bearer nolag_...`), well-formed or not. Such
 * a request is the assistant's and is never treated as a staff or public request.
 */
export function isAgentAuthorization(header: string | undefined): boolean {
  return header !== undefined && AGENT_BEARER_PATTERN.test(header.trim());
}

/** The token in an `Authorization: Bearer nolag_...` header, or null for any other header. */
export function readAgentToken(header: string | undefined): string | null {
  const match = header ? /^bearer\s+(\S+)$/i.exec(header.trim()) : null;
  const token = match?.[1];
  return token && isAgentTokenShape(token) ? token : null;
}

/**
 * A redirect URI the Administrator may register: absolute https (http only for localhost in
 * development), no fragment, no credentials.
 */
export function isAllowedRedirectUri(value: string, allowHttpLocalhost: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return allowHttpLocalhost && url.protocol === 'http:' && local;
}
