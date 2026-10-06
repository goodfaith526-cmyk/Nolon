import { describe, expect, it } from 'vitest';
import { hashApiKey, keyMatches, newApiKey, readApiKey } from './api-key.js';

describe('Customer Service API keys', () => {
  it('makes random keys whose prefix finds them and whose hash checks them', () => {
    const a = newApiKey();
    const b = newApiKey();
    expect(a.key).toMatch(/^nolcs_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(readApiKey(`Bearer ${a.key}`)).toEqual({ key: a.key, prefix: a.prefix });
    expect(keyMatches(a.key, a.hash)).toBe(true);
    expect(keyMatches(b.key, a.hash)).toBe(false);
  });

  it('reads only a well-formed bearer key', () => {
    const { key } = newApiKey();
    expect(readApiKey(undefined)).toBeNull();
    expect(readApiKey(key)).toBeNull();
    expect(readApiKey(`Basic ${key}`)).toBeNull();
    expect(readApiKey(`Bearer ${key}x`)).toBeNull();
    expect(readApiKey(`Bearer ${key.replace('nolcs_', 'nolxx_')}`)).toBeNull();
    expect(readApiKey('Bearer ')).toBeNull();
  });
});
