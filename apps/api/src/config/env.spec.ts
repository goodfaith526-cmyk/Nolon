import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('loadEnv', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.SESSION_TTL_HOURS).toBe(12);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.LOGIN_IP_LIMIT_ENABLED).toBe(true);
  });

  it('parses the auth settings', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SESSION_TTL_HOURS: '8',
      TRUST_PROXY_HOPS: '2',
      LOGIN_IP_LIMIT_ENABLED: 'false',
    });
    expect(env.SESSION_TTL_HOURS).toBe(8);
    expect(env.TRUST_PROXY_HOPS).toBe(2);
    expect(env.LOGIN_IP_LIMIT_ENABLED).toBe(false);
  });

  it('treats empty seed admin values as unset', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SEED_ADMIN_EMAIL: '',
      SEED_ADMIN_PASSWORD: '',
    });
    expect(env.SEED_ADMIN_EMAIL).toBeUndefined();
    expect(env.SEED_ADMIN_PASSWORD).toBeUndefined();
  });

  it('rejects a short seed admin password', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        SEED_ADMIN_PASSWORD: 'short',
      }),
    ).toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it('splits CORS origins', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      CORS_ORIGINS: 'http://a.test, http://b.test',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
