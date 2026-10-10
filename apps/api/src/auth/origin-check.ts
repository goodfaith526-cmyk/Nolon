import type { NextFunction, Request, Response } from 'express';
import { isAgentAuthorization } from '../agent-auth/agent-secrets.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defence for cookie sessions (docs/plans/01-auth-and-permissions.md, S2). Every unsafe
 * method must come from an allowed origin, shown by its Origin header or, when a browser omits
 * that, its Referer. Requests with neither are rejected.
 */
export function isAllowedUnsafeRequest(
  method: string,
  origin: string | undefined,
  referer: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const source = origin ?? (referer ? originOf(referer) : undefined);
  return source !== undefined && allowedOrigins.includes(source);
}

/**
 * `exemptPaths`: exact paths of server-to-server endpoints that never read a session cookie
 * (the assistant's token exchange and revocation), so a browser cannot be used against them.
 *
 * A request carrying the assistant's bearer token (Authorization: Bearer nolag_...) is exempt
 * too: the auth guard then authenticates it by that token only and ignores any cookie, and a page
 * on another site can neither read such a token nor send an Authorization header without a CORS
 * preflight, which only the allowed origins pass. It reaches only the routes opened to the
 * assistant (AuthGuard).
 */
export function originCheck(
  allowedOrigins: readonly string[],
  exemptPaths: readonly string[] = [],
) {
  const allowed = allowedOrigins.map((origin) => originOf(origin) ?? origin);
  const exempt = new Set(exemptPaths);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (exempt.has(req.path) || isAgentAuthorization(req.headers.authorization)) {
      next();
      return;
    }
    if (isAllowedUnsafeRequest(req.method, req.headers.origin, req.headers.referer, allowed)) {
      next();
      return;
    }
    res.status(403).json({ statusCode: 403, message: 'Cross-site request blocked' });
  };
}
