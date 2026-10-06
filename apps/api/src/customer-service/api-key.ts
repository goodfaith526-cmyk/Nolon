import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CS_KEY_PREFIX } from '@nolon/shared';

/**
 * Customer Service API keys: `nolcs_<12 hex>_<43 base64url>`. The hex part is public (it finds
 * the key's row and tells keys apart); the rest is 32 random bytes. Only the SHA-256 of the whole
 * key is stored, as for session tokens: a key this random needs no slow hash.
 */
const KEY_PATTERN = new RegExp(`^${CS_KEY_PREFIX}([0-9a-f]{12})_([A-Za-z0-9_-]{43})$`);

export interface NewApiKey {
  key: string;
  prefix: string;
  hash: string;
}

export function newApiKey(): NewApiKey {
  const prefix = randomBytes(6).toString('hex');
  const key = `${CS_KEY_PREFIX}${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The key in an `Authorization: Bearer <key>` header and its prefix, or null. */
export function readApiKey(header: string | undefined): { key: string; prefix: string } | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header.trim());
  const key = match?.[1];
  if (!key) return null;
  const parts = KEY_PATTERN.exec(key);
  const prefix = parts?.[1];
  return prefix ? { key, prefix } : null;
}

/** Compares a presented key with a stored hash in constant time. */
export function keyMatches(key: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(key), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
