import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { CsCustomerTokenAnswer, CustomerDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import { whatsappSenderHash } from '../src/customer-service/customer-tokens.service.js';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

type TokenAnswer = Extract<CsCustomerTokenAnswer, { kind: 'token' }>;

/**
 * Plan 14-1: a customer token from a Telegram sender's own shared contact, inside the signed
 * channel assertion of plan 08. Negative cases first: switch off, bad signature, WhatsApp context,
 * another user's contact, another phone, evidence without an assertion, an unconfigured key.
 */
describe('Customer tokens from a Telegram own contact (plan 14-1)', () => {
  let on: TestApp;
  let off: TestApp;
  let pts = '';
  let cookie = '';
  const clientId = randomUUID();
  const strangerId = randomUUID();
  const key = newApiKey();
  const strangerKey = newApiKey();
  const secret = 'test-channel-assertion-secret-32-characters';
  const tag = String(randomInt(100_000, 999_999));
  let alpha: CustomerDto;
  const alphaPhone = uniquePhone();
  const telegramId = () => `${Date.now()}${randomInt(10_000, 99_999)}`;
  const PATH = '/api/v1/cs/customer-tokens';

  function issue(
    app: TestApp,
    body: object,
    opts: {
      subjectId?: string;
      channel?: 'TELEGRAM' | 'WHATSAPP';
      sign?: string;
      client?: string;
      apiKey?: string;
    } = {},
  ) {
    const raw = JSON.stringify(body);
    const req = app
      .http()
      .post(PATH)
      .set('Authorization', `Bearer ${opts.apiKey ?? key.key}`)
      .set('Content-Type', 'application/json');
    if (opts.subjectId) {
      const rawContext = JSON.stringify({
        channel: opts.channel ?? 'TELEGRAM',
        subjectId: opts.subjectId,
        channelAccountId: 'test-bot',
        eventId: randomUUID(),
        observedAt: new Date().toISOString(),
      });
      const issued = Math.floor(Date.now() / 1000).toString();
      const idem = `idem-${randomUUID()}`;
      const payload = [
        'v1',
        opts.client ?? clientId,
        'POST',
        PATH,
        idem,
        issued,
        sha256(rawContext),
        sha256(raw),
      ].join('\n');
      const signature = createHmac('sha256', opts.sign ?? secret)
        .update(payload)
        .digest('base64url');
      req
        .set('Idempotency-Key', idem)
        .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
        .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'));
    }
    return req.send(raw);
  }

  const evidence = (subjectId: string, value: string) => ({
    kind: 'TELEGRAM_OWN_CONTACT',
    contactUserId: subjectId,
    value,
  });
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const tokenRows = (customerId: string) =>
    on.prisma.csCustomerToken.count({ where: { customerId } });

  beforeAll(async () => {
    const config = {
      secret,
      accounts: [
        { channel: 'TELEGRAM', channelAccountId: 'test-bot' },
        { channel: 'WHATSAPP', channelAccountId: 'test-bot' },
      ],
    };
    const identity = {
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: `tg-token-${randomUUID()}`,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({ [clientId]: config }),
    };
    on = await createTestApp({ ...identity, CS_TELEGRAM_TOKENS_ENABLED: true });
    off = await createTestApp({ ...identity, CS_TELEGRAM_TOKENS_ENABLED: false });
    pts = await branchId(on.prisma, 'PTS');
    const admin = await createUser(on.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    const sales = await createUser(on.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    cookie = await signIn(on, sales.email);
    for (const [id, k] of [
      [clientId, key],
      [strangerId, strangerKey],
    ] as const) {
      await on.prisma.apiClient.create({
        data: {
          id,
          name: `Telegram token test ${tag}`,
          keyPrefix: k.prefix,
          keyHash: k.hash,
          createdById: admin.id,
          customersRead: false,
          branches: { create: [{ branchId: pts }] },
          scopes: { create: [{ scope: 'CUSTOMER_TOKENS_ISSUE', grantedById: admin.id }] },
        },
      });
    }
    alpha = (
      await on
        .http()
        .post('/api/v1/customers')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send({
          branchId: pts,
          kind: 'INDIVIDUAL',
          preferredCurrency: 'USD',
          phone: alphaPhone,
          name: `Alpha ${tag}`,
        })
        .expect(201)
    ).body as CustomerDto;
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
  });

  it('is off by default: 503 and no token', async () => {
    const subject = telegramId();
    const before = await tokenRows(alpha.id);
    const res = await issue(
      off,
      { phone: alphaPhone, phoneEvidence: evidence(subject, alphaPhone) },
      { subjectId: subject },
    ).expect(503);
    expect(code(res)).toBe('TELEGRAM_TOKENS_UNAVAILABLE');
    expect(await tokenRows(alpha.id)).toBe(before);
  });

  it('refuses a bad signature, a WhatsApp context, another user, another phone', async () => {
    const subject = telegramId();
    const body = { phone: alphaPhone, phoneEvidence: evidence(subject, alphaPhone) };
    const before = await tokenRows(alpha.id);
    await issue(on, body, {
      subjectId: subject,
      sign: 'another-secret-of-at-least-32-characters',
    }).expect(401);
    // A WhatsApp assertion never carries Telegram evidence.
    const whatsapp = await issue(on, body, { subjectId: alphaPhone, channel: 'WHATSAPP' }).expect(
      401,
    );
    expect(code(whatsapp)).toBe('INVALID_CHANNEL_ASSERTION');
    const otherUser = await issue(
      on,
      { phone: alphaPhone, phoneEvidence: evidence(telegramId(), alphaPhone) },
      { subjectId: subject },
    ).expect(401);
    expect(code(otherUser)).toBe('INVALID_CHANNEL_ASSERTION');
    const otherPhone = await issue(
      on,
      { phone: alphaPhone, phoneEvidence: evidence(subject, uniquePhone()) },
      { subjectId: subject },
    ).expect(401);
    expect(code(otherPhone)).toBe('INVALID_CHANNEL_ASSERTION');
    const noEvidence = await issue(on, { phone: alphaPhone }, { subjectId: subject }).expect(401);
    expect(code(noEvidence)).toBe('INVALID_CHANNEL_ASSERTION');
    expect(await tokenRows(alpha.id)).toBe(before);
  });

  it('refuses evidence without an assertion, and a key with no Telegram account', async () => {
    const subject = telegramId();
    const body = { phone: alphaPhone, phoneEvidence: evidence(subject, alphaPhone) };
    expect(code(await issue(on, body).expect(400))).toBe('ASSERTION_REQUIRED');
    await issue(on, body, {
      subjectId: subject,
      client: strangerId,
      apiKey: strangerKey.key,
    }).expect(403);
  });

  it('issues a Telegram token for the own contact, and logs its reads as telegram', async () => {
    const subject = telegramId();
    const answer = (
      await issue(
        on,
        { phone: alphaPhone, phoneEvidence: evidence(subject, alphaPhone) },
        { subjectId: subject },
      ).expect(200)
    ).body as TokenAnswer;
    expect(answer).toMatchObject({
      kind: 'token',
      level: 'L1',
      customer: { number: alpha.number },
    });
    const row = await on.prisma.csCustomerToken.findFirstOrThrow({
      where: { customerId: alpha.id },
      orderBy: { issuedAt: 'desc' },
    });
    expect(row).toMatchObject({ channel: 'telegram', senderHash: null });
    const issued = await on.prisma.csAccessEvent.findFirstOrThrow({
      where: { tokenId: row.id, outcome: 'TOKEN' },
    });
    expect(issued.channel).toBe('telegram');
    await on
      .http()
      .get('/api/v1/cs/me/shipments')
      .set('Authorization', `Bearer ${answer.token}`)
      .expect(200);
    const read = await on.prisma.csAccessEvent.findFirstOrThrow({
      where: { tokenId: row.id, route: 'GET /cs/me/shipments' },
    });
    expect(read.channel).toBe('telegram');
  });

  it('a phone matching nobody is none; WhatsApp tokens keep their channel and sender hash', async () => {
    const subject = telegramId();
    const nobody = uniquePhone();
    const none = await issue(
      on,
      { phone: nobody, phoneEvidence: evidence(subject, nobody) },
      { subjectId: subject },
    ).expect(200);
    expect(none.body).toEqual({ kind: 'none' });
    const whatsapp = (await issue(on, { phone: alphaPhone }).expect(200)).body as TokenAnswer;
    expect(whatsapp.kind).toBe('token');
    const row = await on.prisma.csCustomerToken.findFirstOrThrow({
      where: { customerId: alpha.id, channel: 'whatsapp' },
      orderBy: { issuedAt: 'desc' },
    });
    expect(row.senderHash).toBe(whatsappSenderHash(alphaPhone));
    expect(whatsappSenderHash(alphaPhone.slice(1))).toBe(row.senderHash);
  });
  it('logs and counts a failed proof as INVALID_ASSERTION on telegram (F208-2)', async () => {
    const subject = telegramId();
    const since = new Date();
    await issue(
      on,
      { phone: alphaPhone, phoneEvidence: evidence(subject, alphaPhone) },
      { subjectId: subject, sign: 'another-secret-of-at-least-32-characters' },
    ).expect(401);
    await issue(
      on,
      { phone: alphaPhone, phoneEvidence: evidence(telegramId(), alphaPhone) },
      { subjectId: subject },
    ).expect(401);
    const rows = await on.prisma.csAccessEvent.findMany({
      where: { apiClientId: clientId, outcome: 'INVALID_ASSERTION', occurredAt: { gte: since } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.channel === 'telegram' && r.tokenId === null)).toBe(true);
  });

  it('a Telegram contact equal to an unverified customer phone grants nothing (F208-1)', async () => {
    const typed = uniquePhone();
    const unverified = (
      await on
        .http()
        .post('/api/v1/customers')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send({
          branchId: pts,
          kind: 'INDIVIDUAL',
          preferredCurrency: 'USD',
          phone: typed,
          name: `Unverified ${tag}`,
        })
        .expect(201)
    ).body as CustomerDto;
    await on.prisma.customer.update({
      where: { id: unverified.id },
      data: { phoneUnverified: true },
    });
    const subject = telegramId();
    const res = await issue(
      on,
      { phone: typed, phoneEvidence: evidence(subject, typed) },
      { subjectId: subject },
    ).expect(200);
    expect(res.body).toEqual({ kind: 'none' });
    expect(await tokenRows(unverified.id)).toBe(0);
  });

  it('Telegram numbers matching nobody count in the shared limiter: 429 (F208-1)', async () => {
    const nobody = uniquePhone();
    const subject = telegramId();
    const attempt = () =>
      issue(
        on,
        { phone: nobody, phoneEvidence: evidence(subject, nobody) },
        { subjectId: subject },
      );
    for (let i = 0; i < 10; i += 1)
      expect((await attempt().expect(200)).body).toEqual({ kind: 'none' });
    expect(code(await attempt().expect(429))).toBe('TOO_MANY');
    // The same phone through WhatsApp shares the limiter (per key and phone).
    expect(code(await issue(on, { phone: nobody }).expect(429))).toBe('TOO_MANY');
  });
});
