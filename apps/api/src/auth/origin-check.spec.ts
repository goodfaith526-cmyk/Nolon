import { describe, expect, it } from 'vitest';
import { isAllowedUnsafeRequest } from './origin-check.js';

const allowed = ['https://app.test'];

describe('isAllowedUnsafeRequest', () => {
  it('lets safe methods through', () => {
    expect(isAllowedUnsafeRequest('GET', undefined, undefined, allowed)).toBe(true);
    expect(isAllowedUnsafeRequest('OPTIONS', 'https://evil.test', undefined, allowed)).toBe(true);
  });

  it('allows unsafe methods from an allowed Origin, or Referer when Origin is absent', () => {
    expect(isAllowedUnsafeRequest('POST', 'https://app.test', undefined, allowed)).toBe(true);
    expect(isAllowedUnsafeRequest('DELETE', undefined, 'https://app.test/x?y', allowed)).toBe(true);
  });

  it('rejects foreign, sibling, missing and malformed origins', () => {
    expect(isAllowedUnsafeRequest('POST', 'https://evil.test', undefined, allowed)).toBe(false);
    expect(isAllowedUnsafeRequest('POST', 'https://x.app.test', undefined, allowed)).toBe(false);
    expect(isAllowedUnsafeRequest('POST', 'http://app.test', undefined, allowed)).toBe(false);
    expect(isAllowedUnsafeRequest('PUT', undefined, undefined, allowed)).toBe(false);
    expect(isAllowedUnsafeRequest('PATCH', 'null', undefined, allowed)).toBe(false);
    expect(isAllowedUnsafeRequest('POST', undefined, 'not a url', allowed)).toBe(false);
  });

  it('does not fall back to Referer when a foreign Origin is present', () => {
    expect(isAllowedUnsafeRequest('POST', 'https://evil.test', 'https://app.test/', allowed)).toBe(
      false,
    );
  });
});
