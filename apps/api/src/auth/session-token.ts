import { createHash, randomBytes } from 'node:crypto';

/**
 * Host-only session cookie: `__Host-` makes browsers refuse it unless it is Secure, Path=/ and
 * has no Domain (docs/plans/01-auth-and-permissions.md, S2).
 */
export const SESSION_COOKIE = '__Host-nolon_session';

/** 32 random bytes, base64url. Only the browser ever holds this value. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores: SHA-256 of the token, hex (64 chars). */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Reads one cookie from a Cookie header without a parsing dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
