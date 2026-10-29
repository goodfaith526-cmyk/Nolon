import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { CustomerIdentityAuth, sha256 } from './customer-identity-auth.js';
import {
  captureIdentityBody,
  updateIdentityBody,
  followUpIdentityBody,
} from './customer-identity.contract.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const secret = 'synthetic-channel-proof-secret-32-chars';
const sender = {
  channel: 'TELEGRAM',
  subjectId: '123456789',
  channelAccountId: 'bot',
  eventId: 'event',
  observedAt: '2026-10-29T12:00:00Z',
};
const env = () =>
  loadEnv({
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    CS_CUSTOMER_IDENTITY_ENABLED: 'true',
    CS_CUSTOMER_IDENTITY_COMPANY_ID: 'nolon-test',
    CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({
      [clientId]: { secret, accounts: [{ channel: 'TELEGRAM', channelAccountId: 'bot' }] },
    }),
  });
function signed(
  rawBody = '{"fields":{}}',
  originalUrl = '/api/v1/cs/customer-profiles/capture',
  issuedAt = Math.floor(Date.now() / 1000),
) {
  const rawContext = JSON.stringify(sender);
  const parsed = new URL(originalUrl, 'http://test.invalid');
  parsed.searchParams.sort();
  const path =
    parsed.pathname + (parsed.searchParams.size ? '?' + parsed.searchParams.toString() : '');
  const mac = createHmac('sha256', secret)
    .update(
      [
        'v1',
        clientId,
        'POST',
        path,
        'capture-1001',
        String(issuedAt),
        sha256(rawContext),
        sha256(rawBody),
      ].join('\n'),
    )
    .digest('base64url');
  const headers: Record<string, string> = {
    'Idempotency-Key': 'capture-1001',
    'X-Nolon-Channel-Context': Buffer.from(rawContext).toString('base64url'),
    'X-Nolon-Channel-Assertion': `v1:${issuedAt}:${mac}`,
  };
  return {
    method: 'POST',
    originalUrl,
    rawBody: Buffer.from(rawBody),
    get: (name: string) => headers[name],
  } as unknown as RawBodyRequest<Request>;
}
describe('Customer identity contract and trusted wrapper', () => {
  it('defaults closed; enabling requires a deployment company and a registered channel account', () => {
    expect(
      loadEnv({ DATABASE_URL: 'postgresql://test:test@localhost/test' })
        .CS_CUSTOMER_IDENTITY_ENABLED,
    ).toBe(false);
    expect(
      () => new CustomerIdentityAuth({ ...env(), CS_CUSTOMER_IDENTITY_COMPANY_ID: undefined }),
    ).toThrow(/namespace/);
    expect(() =>
      new CustomerIdentityAuth({ ...env(), CS_CUSTOMER_IDENTITY_ENABLED: false }).verify(
        clientId,
        signed(),
      ),
    ).toThrow(/CUSTOMER_CAPTURE_UNAVAILABLE/);
    expect(() =>
      new CustomerIdentityAuth({ ...env(), CS_CUSTOMER_IDENTITY_CLIENTS: '{}' }).verify(
        clientId,
        signed(),
      ),
    ).toThrow(/CHANNEL_NOT_ALLOWED/);
  });
  it('binds raw bytes, path, method, idempotency key and all channel context; never reserializes a retry', () => {
    const auth = new CustomerIdentityAuth(env());
    const req = signed('{ "fields": {} }', '/api/v1/cs/customer-profiles/capture?z=2&a=1');
    expect(auth.verify(clientId, req).context).toEqual(sender);
    expect(() => auth.verify(clientId, { ...req, rawBody: Buffer.from('{"fields":{}}') })).toThrow(
      /INVALID_CHANNEL_ASSERTION/,
    );
    expect(() => auth.verify(clientId, { ...req, method: 'PATCH' })).toThrow(
      /INVALID_CHANNEL_ASSERTION/,
    );
    expect(() =>
      auth.verify(clientId, { ...req, originalUrl: '/api/v1/cs/customer-profiles/other' }),
    ).toThrow(/INVALID_CHANNEL_ASSERTION/);
    expect(() =>
      auth.verify(clientId, req, { ...sender, channel: 'TELEGRAM', subjectId: '999' }),
    ).toThrow(/INVALID_CHANNEL_ASSERTION/);
  });
  it('rejects expired/future assertions and accepts a fresh signature on identical old body bytes', () => {
    const auth = new CustomerIdentityAuth(env());
    const now = Math.floor(Date.now() / 1000);
    expect(() => auth.verify(clientId, signed('{}', undefined, now - 301))).toThrow(
      /INVALID_CHANNEL_ASSERTION/,
    );
    expect(() => auth.verify(clientId, signed('{}', undefined, now + 61))).toThrow(
      /INVALID_CHANNEL_ASSERTION/,
    );
    expect(auth.verify(clientId, signed('{}')).rawBody.toString()).toBe('{}');
  });
  it('parses every complete shared fixture with the same schemas as the HTTP routes', () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL('../../../../docs/plans/08a-bot-customer-identity-examples.json', import.meta.url),
        'utf8',
      ),
    ) as { cases: { id: string; request?: { method?: string; path?: string; body?: unknown } }[] };
    const complete = fixtures.cases.filter((c) => c.request?.body);
    expect(complete.length).toBeGreaterThanOrEqual(6);
    for (const c of complete) {
      const schema = c.request!.path?.endsWith('/follow-up')
        ? followUpIdentityBody
        : c.request!.method === 'PATCH'
          ? updateIdentityBody
          : captureIdentityBody;
      expect(schema.safeParse(c.request!.body).success, c.id).toBe(true);
    }
  });
  it('keeps core identity usable with follow-up and booking identity independently closed', () => {
    const base = env();
    const coreOnly = new CustomerIdentityAuth(base);
    expect(() => coreOnly.enabled()).not.toThrow();
    expect(() => coreOnly.enabled('followup')).toThrow();
    expect(() => coreOnly.enabled('booking')).toThrow();
    const followup = new CustomerIdentityAuth({ ...base, CS_CUSTOMER_FOLLOWUP_ENABLED: true });
    expect(() => followup.enabled('followup')).not.toThrow();
    expect(() => followup.enabled('booking')).toThrow();
    const booking = new CustomerIdentityAuth({
      ...base,
      CS_CUSTOMER_BOOKING_IDENTITY_ENABLED: true,
    });
    expect(() => booking.enabled('booking')).not.toThrow();
    expect(() => booking.enabled('followup')).toThrow();
  });
  it('cannot promote typed input to trusted data, set a company/branch, or pass someone else contact as the sender', () => {
    const base = {
      schemaVersion: 'nolon.customer-identity/1',
      sender,
      conversationId: 'conversation',
      fields: {},
    };
    expect(captureIdentityBody.safeParse({ ...base, companyId: 'other' }).success).toBe(false);
    expect(captureIdentityBody.safeParse({ ...base, branchId: clientId }).success).toBe(false);
    expect(
      captureIdentityBody.safeParse({
        ...base,
        fields: { name: { value: 'Receiver', source: 'STAFF_VERIFIED' } },
      }).success,
    ).toBe(false);
    expect(
      captureIdentityBody.safeParse({
        ...base,
        sender: {
          ...sender,
          phoneEvidence: {
            value: '+249900000001',
            kind: 'TELEGRAM_OWN_CONTACT',
            contactUserId: 'someone-else',
          },
        },
      }).success,
    ).toBe(false);
  });
});
