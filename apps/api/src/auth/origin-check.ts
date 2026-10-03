import type { NextFunction, Request, Response } from 'express';

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

export function originCheck(allowedOrigins: readonly string[]) {
  const allowed = allowedOrigins.map((origin) => originOf(origin) ?? origin);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAllowedUnsafeRequest(req.method, req.headers.origin, req.headers.referer, allowed)) {
      next();
      return;
    }
    res.status(403).json({ statusCode: 403, message: 'Cross-site request blocked' });
  };
}
