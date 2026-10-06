import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isAllowedRedirectUri,
  newAgentToken,
  newAuthCode,
  newClientId,
  newClientSecret,
  pkceMatches,
  isAgentAuthorization,
  readAgentToken,
  secretMatches,
  sha256Hex,
  CLIENT_ID_PATTERN,
} from './agent-secrets.js';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = createHash('sha256').update(verifier).digest('base64url');

describe('agent secrets', () => {
  it('makes distinct values of the documented shapes', () => {
    expect(newAgentToken()).toMatch(/^nolag_[A-Za-z0-9_-]{43}$/);
    expect(newClientSecret()).toMatch(/^nolags_[A-Za-z0-9_-]{43}$/);
    expect(newAuthCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newClientId()).toMatch(CLIENT_ID_PATTERN);
    expect(newAgentToken()).not.toBe(newAgentToken());
  });

  it('matches a client secret only against its own hash', () => {
    const secret = newClientSecret();
    expect(secretMatches(secret, sha256Hex(secret))).toBe(true);
    expect(secretMatches(newClientSecret(), sha256Hex(secret))).toBe(false);
    expect(secretMatches('not-a-secret', sha256Hex('not-a-secret'))).toBe(false);
  });

  it('checks PKCE S256 (RFC 7636 appendix B example)', () => {
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches('short', challenge)).toBe(false);
    // Plain method (verifier sent as the challenge) is never accepted.
    expect(pkceMatches(verifier, verifier)).toBe(false);
  });

  it('reads only nolag_ bearer tokens', () => {
    const token = newAgentToken();
    expect(readAgentToken(`Bearer ${token}`)).toBe(token);
    expect(readAgentToken(undefined)).toBeNull();
    expect(readAgentToken(token)).toBeNull();
    expect(readAgentToken(`Bearer nolcs_abcdef012345_${'a'.repeat(43)}`)).toBeNull();
    expect(readAgentToken(`Basic ${token}`)).toBeNull();
  });

  it('recognizes any nolag_ bearer header as the assistant, well-formed or not', () => {
    const token = newAgentToken();
    expect(isAgentAuthorization(`Bearer ${token}`)).toBe(true);
    expect(isAgentAuthorization(`bearer  ${token}`)).toBe(true);
    expect(isAgentAuthorization('Bearer nolag_short')).toBe(true);
    expect(isAgentAuthorization(undefined)).toBe(false);
    expect(isAgentAuthorization(`Bearer nolcs_abcdef012345_${'a'.repeat(43)}`)).toBe(false);
    expect(isAgentAuthorization(`Basic ${token}`)).toBe(false);
  });

  it('allows https redirect URIs, and http only on localhost when asked', () => {
    expect(isAllowedRedirectUri('https://agent.example.com/auth/nolon/callback', false)).toBe(true);
    expect(isAllowedRedirectUri('http://agent.example.com/cb', false)).toBe(false);
    expect(isAllowedRedirectUri('http://localhost:4200/cb', false)).toBe(false);
    expect(isAllowedRedirectUri('http://localhost:4200/cb', true)).toBe(true);
    expect(isAllowedRedirectUri('https://agent.example.com/cb#x', false)).toBe(false);
    expect(isAllowedRedirectUri('https://u:p@agent.example.com/cb', false)).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)', true)).toBe(false);
  });
});
