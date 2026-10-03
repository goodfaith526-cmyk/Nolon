import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, hashSessionToken, newSessionToken, readCookie } from './session-token.js';

describe('session tokens', () => {
  it('are random and stored only as a SHA-256 hex hash', () => {
    const a = newSessionToken();
    expect(a).not.toBe(newSessionToken());
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).not.toContain(a);
  });

  it('uses a host-only cookie name', () => {
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; __Host-nolon_session=tok; b=2', SESSION_COOKIE)).toBe('tok');
    expect(readCookie('nolon_session=tok', SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});
