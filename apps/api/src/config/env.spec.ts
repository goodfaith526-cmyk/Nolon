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

  it('reads the quotation validity days, 30 by default, and rejects one out of range', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    expect(loadEnv(base).QUOTATION_VALIDITY_DAYS).toBe(30);
    expect(loadEnv({ ...base, QUOTATION_VALIDITY_DAYS: '' }).QUOTATION_VALIDITY_DAYS).toBe(30);
    expect(loadEnv({ ...base, QUOTATION_VALIDITY_DAYS: '14' }).QUOTATION_VALIDITY_DAYS).toBe(14);
    expect(() => loadEnv({ ...base, QUOTATION_VALIDITY_DAYS: '0' })).toThrow(
      /QUOTATION_VALIDITY_DAYS/,
    );
    expect(() => loadEnv({ ...base, QUOTATION_VALIDITY_DAYS: '1.5' })).toThrow(
      /QUOTATION_VALIDITY_DAYS/,
    );
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

  it('accepts an https assistant URL, and treats an empty one as unset', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    expect(loadEnv(base).AGENT_ASSISTANT_URL).toBeUndefined();
    expect(loadEnv({ ...base, AGENT_ASSISTANT_URL: '' }).AGENT_ASSISTANT_URL).toBeUndefined();
    expect(
      loadEnv({ ...base, AGENT_ASSISTANT_URL: 'https://pilot.example.com/?tenant=nolon' })
        .AGENT_ASSISTANT_URL,
    ).toBe('https://pilot.example.com/?tenant=nolon');
    expect(
      loadEnv({ ...base, AGENT_ASSISTANT_URL: 'http://localhost:4100/?tenant=nolon' })
        .AGENT_ASSISTANT_URL,
    ).toBe('http://localhost:4100/?tenant=nolon');
  });

  it('accepts an https agent admin panel URL, treats an empty one as unset, refuses plain http', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    const url = 'https://assistant.example.com/agent-admin.html?tenant=nolon&signin=erp';
    expect(loadEnv(base).AGENT_ADMIN_URL).toBeUndefined();
    expect(loadEnv({ ...base, AGENT_ADMIN_URL: '' }).AGENT_ADMIN_URL).toBeUndefined();
    expect(loadEnv({ ...base, AGENT_ADMIN_URL: url }).AGENT_ADMIN_URL).toBe(url);
    expect(() =>
      loadEnv({ ...base, AGENT_ADMIN_URL: 'http://assistant.example.com/agent-admin.html' }),
    ).toThrow();
  });

  it('reads the assistant panel switch: off unless exactly true', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    expect(loadEnv(base).AGENT_ASSISTANT_PANEL).toBe(false);
    expect(loadEnv({ ...base, AGENT_ASSISTANT_PANEL: '' }).AGENT_ASSISTANT_PANEL).toBe(false);
    expect(loadEnv({ ...base, AGENT_ASSISTANT_PANEL: 'false' }).AGENT_ASSISTANT_PANEL).toBe(false);
    expect(loadEnv({ ...base, AGENT_ASSISTANT_PANEL: 'true' }).AGENT_ASSISTANT_PANEL).toBe(true);
    expect(() => loadEnv({ ...base, AGENT_ASSISTANT_PANEL: 'yes' })).toThrow(
      /AGENT_ASSISTANT_PANEL/,
    );
  });

  it('keeps the Outlet Staff role locked unless the switch is exactly true', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    expect(loadEnv(base).OUTLET_STAFF_ASSIGNABLE).toBe(false);
    expect(loadEnv({ ...base, OUTLET_STAFF_ASSIGNABLE: '' }).OUTLET_STAFF_ASSIGNABLE).toBe(false);
    expect(loadEnv({ ...base, OUTLET_STAFF_ASSIGNABLE: 'true' }).OUTLET_STAFF_ASSIGNABLE).toBe(
      true,
    );
    expect(() => loadEnv({ ...base, OUTLET_STAFF_ASSIGNABLE: 'yes' })).toThrow(
      /OUTLET_STAFF_ASSIGNABLE/,
    );
  });

  it('rejects an assistant URL that is not https', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    for (const value of ['http://pilot.example.com/', 'javascript:alert(1)', 'not a url']) {
      expect(() => loadEnv({ ...base, AGENT_ASSISTANT_URL: value })).toThrow(/AGENT_ASSISTANT_URL/);
    }
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

  it('visitor limits (identity, booking requests, quotes): none by default; 0 is off', () => {
    const DB = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    const env = loadEnv(DB);
    expect(env.CS_IDENTITY_KEY_OPERATIONS_PER_DAY).toBe(0);
    expect(env.CS_IDENTITY_PERSON_OPERATIONS_PER_HOUR).toBe(0);
    expect(env.CS_BOOKING_REQUESTS_PER_SENDER_DAY).toBe(0);
    expect(env.CS_QUOTES_PER_KEY_15MIN).toBe(0);
    expect(loadEnv({ ...DB, CS_QUOTES_PER_KEY_15MIN: '' }).CS_QUOTES_PER_KEY_15MIN).toBe(0);
    expect(() => loadEnv({ ...DB, CS_BOOKING_REQUESTS_PER_SENDER_DAY: '-1' })).toThrow();
    const empty = loadEnv({
      ...DB,
      CS_IDENTITY_KEY_OPERATIONS_PER_DAY: '',
      CS_IDENTITY_PERSON_OPERATIONS_PER_HOUR: '',
    });
    expect(empty.CS_IDENTITY_KEY_OPERATIONS_PER_DAY).toBe(0);
    expect(empty.CS_IDENTITY_PERSON_OPERATIONS_PER_HOUR).toBe(0);
    const set = loadEnv({
      ...DB,
      CS_IDENTITY_KEY_OPERATIONS_PER_DAY: '5000',
      CS_IDENTITY_PERSON_OPERATIONS_PER_HOUR: '0',
    });
    expect(set.CS_IDENTITY_KEY_OPERATIONS_PER_DAY).toBe(5000);
    expect(set.CS_IDENTITY_PERSON_OPERATIONS_PER_HOUR).toBe(0);
    expect(() => loadEnv({ ...DB, CS_IDENTITY_PERSON_OPERATIONS_PER_HOUR: '-1' })).toThrow();
    expect(() => loadEnv({ ...DB, CS_IDENTITY_KEY_OPERATIONS_PER_DAY: '1.5' })).toThrow();
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
