import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { APP_ENV, type AppEnv } from '../config/env.js';
import {
  channelContext,
  type IdentityContext,
  type IdentitySender,
} from './customer-identity.contract.js';

export function identityError(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): never {
  throw new HttpException({ statusCode: status, code, message: code, ...extra }, status);
}
export const sha256 = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
export interface IdentityEnvelope {
  context: IdentityContext;
  rawBody: Buffer;
  method: string;
  path: string;
  idempotencyKey: string;
}
const configurations = z.record(
  z.uuid(),
  z
    .object({
      secret: z.string().min(32).max(256),
      accounts: z
        .array(
          z
            .object({
              channel: z.enum(['WHATSAPP', 'TELEGRAM']),
              channelAccountId: z.string().min(1).max(128),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
);

/** Trusted wrapper proof; no token or permission to read existing customer transactions. */
@Injectable()
export class CustomerIdentityAuth {
  private readonly clients: z.infer<typeof configurations>;
  readonly companyId: string;
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {
    try {
      this.clients = configurations.parse(JSON.parse(env.CS_CUSTOMER_IDENTITY_CLIENTS) as unknown);
    } catch {
      throw new Error('Invalid private channel assertion configuration');
    }
    this.companyId = env.CS_CUSTOMER_IDENTITY_COMPANY_ID ?? '';
    if (env.CS_CUSTOMER_IDENTITY_ENABLED && !this.companyId) {
      throw new Error('Customer identity requires an explicit company namespace');
    }
  }

  enabled(capability: 'core' | 'followup' | 'booking' = 'core'): void {
    if (
      !this.env.CS_CUSTOMER_IDENTITY_ENABLED ||
      (capability === 'followup' && !this.env.CS_CUSTOMER_FOLLOWUP_ENABLED) ||
      (capability === 'booking' && !this.env.CS_CUSTOMER_BOOKING_IDENTITY_ENABLED)
    )
      identityError(503, 'CUSTOMER_CAPTURE_UNAVAILABLE');
  }

  verify(
    clientId: string,
    req: Pick<Request, 'get' | 'method' | 'originalUrl'> & { rawBody?: Buffer },
    sender?: IdentitySender,
  ): IdentityEnvelope {
    this.enabled();
    const assertion = req.get('X-Nolon-Channel-Assertion') ?? '';
    const contextHeader = req.get('X-Nolon-Channel-Context') ?? '';
    if (contextHeader.length > 4096) identityError(401, 'INVALID_CHANNEL_ASSERTION');
    const match = /^v1:(\d{1,12}):([A-Za-z0-9_-]{43})$/.exec(assertion);
    if (!match || !/^[A-Za-z0-9_-]+$/.test(contextHeader))
      identityError(401, 'INVALID_CHANNEL_ASSERTION');
    const issuedAt = Number(match[1]);
    const now = Math.floor(Date.now() / 1000);
    if (issuedAt < now - 300 || issuedAt > now + 60)
      identityError(401, 'INVALID_CHANNEL_ASSERTION');
    const config = this.clients[clientId];
    if (!config) identityError(403, 'CHANNEL_NOT_ALLOWED');
    const rawContext = Buffer.from(contextHeader, 'base64url');
    let unknownContext: unknown;
    try {
      unknownContext = JSON.parse(rawContext.toString('utf8')) as unknown;
    } catch {
      identityError(401, 'INVALID_CHANNEL_ASSERTION');
    }
    const parsed = channelContext.safeParse(unknownContext);
    if (!parsed.success) identityError(401, 'INVALID_CHANNEL_ASSERTION');
    const context = parsed.data;
    if (
      !config.accounts.some(
        (a) => a.channel === context.channel && a.channelAccountId === context.channelAccountId,
      )
    ) {
      identityError(403, 'CHANNEL_NOT_ALLOWED');
    }
    const isGet = req.method === 'GET';
    const idempotencyKey = isGet ? '' : (req.get('Idempotency-Key') ?? '');
    const rawBody = isGet ? Buffer.alloc(0) : req.rawBody;
    if (!rawBody) identityError(401, 'INVALID_CHANNEL_ASSERTION');
    const url = new URL(req.originalUrl, 'http://local.invalid');
    url.searchParams.sort();
    const query = url.searchParams.toString();
    const path = url.pathname + (query ? `?${query}` : '');
    const payload = [
      'v1',
      clientId,
      req.method.toUpperCase(),
      path,
      idempotencyKey,
      match[1]!,
      sha256(rawContext),
      sha256(rawBody),
    ].join('\n');
    const expected = createHmac('sha256', config.secret).update(payload).digest();
    const given = Buffer.from(match[2]!, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      identityError(401, 'INVALID_CHANNEL_ASSERTION');
    if (
      sender &&
      Object.entries(context).some(([k, v]) => sender[k as keyof IdentityContext] !== v)
    ) {
      identityError(401, 'INVALID_CHANNEL_ASSERTION');
    }
    return { context, rawBody, method: req.method, path, idempotencyKey };
  }
}

export function parseIdentity<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    identityError(400, 'INVALID_INPUT', {
      fields: parsed.error.issues.map((i) => i.path.join('.')),
    });
  return parsed.data;
}
