import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { isAllowedUnsafeRequest, originCheck } from './origin-check.js';

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

describe('originCheck', () => {
  function run(headers: Record<string, string>): number {
    let status = 0;
    const res = {
      status: (code: number) => {
        status = code;
        return { json: () => undefined };
      },
    } as unknown as Response;
    const next: NextFunction = () => {
      status = 200;
    };
    originCheck(allowed)({ method: 'POST', path: '/api/v1/x', headers } as Request, res, next);
    return status;
  }

  it('lets an assistant bearer request through without an Origin (server to server)', () => {
    expect(run({ authorization: 'Bearer nolag_abc' })).toBe(200);
  });

  it('still blocks a cookie request from nowhere or elsewhere, and other bearer tokens', () => {
    expect(run({ cookie: 'nolon_session=x' })).toBe(403);
    expect(run({ cookie: 'nolon_session=x', origin: 'https://evil.test' })).toBe(403);
    expect(run({ authorization: 'Bearer something-else' })).toBe(403);
  });
});
