import { createHmac, randomUUID } from 'node:crypto';
import type { CsBookingRequestCreated, CsBookingRequestDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
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

/**
 * Plan 09 section 2 (N-C1): a customer cancels their bot booking request. The owner is proven by a
 * customer token or a signed channel identity of the request's sender, never by the key alone
 * (F161-1); an approved request is not cancelled but its ask is kept once for staff.
 */
describe('Customer Service booking request cancel (plan 09 section 2)', () => {
  let t: TestApp;
  let off: TestApp;
  let cookie = '';
  let dxb = '';
  const clientId = randomUUID();
  const otherId = randomUUID();
  const key = newApiKey();
  const otherKey = newApiKey();
  const secret = 'test-channel-assertion-secret-32-characters';
  const category = `X${randomUUID().slice(0, 6).toUpperCase()}`;
  const originId = randomUUID();
  const destinationId = randomUUID();

  const telegramId = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

  function body(senderId: string) {
    return {
      sender: { channel: 'telegram', id: senderId },
      originId,
      destinationId,
      category,
      quantity: '2',
      services: [],
      senderName: 'Sender',
      consigneeName: 'Consignee',
      consigneePhone: uniquePhone(),
      handover: 'BRANCH_DROP',
      language: 'ar',
      idempotencyKey: `idem-${randomUUID()}`,
    };
  }

  async function make(senderId: string, app = t): Promise<string> {
    const res = await app
      .http()
      .post('/api/v1/cs/booking-requests')
      .set('Authorization', `Bearer ${key.key}`)
      .send(body(senderId))
      .expect(201);
    return (res.body as CsBookingRequestCreated).requestId;
  }

  /** POST .../cancel, signed (plan 08) for `subjectId` when given; the key alone otherwise. */
  function cancel(
    id: string,
    opts: {
      subjectId?: string;
      sign?: string;
      token?: string;
      client?: string;
      payload?: object;
    } = {},
    app = t,
  ) {
    const path = `/api/v1/cs/booking-requests/${id}/cancel`;
    const rawBody = JSON.stringify(opts.payload ?? {});
    const req = app
      .http()
      .post(path)
      .set('Authorization', `Bearer ${opts.token ?? key.key}`)
      .set('Content-Type', 'application/json');
    if (opts.subjectId) {
      const rawContext = JSON.stringify({
        channel: 'TELEGRAM',
        subjectId: opts.subjectId,
        channelAccountId: 'test-bot',
        eventId: randomUUID(),
        observedAt: new Date().toISOString(),
      });
      const issued = Math.floor(Date.now() / 1000).toString();
      const payload = [
        'v1',
        opts.client ?? clientId,
        'POST',
        path,
        '',
        issued,
        sha256(rawContext),
        sha256(rawBody),
      ].join('\n');
      const signature = createHmac('sha256', opts.sign ?? secret)
        .update(payload)
        .digest('base64url');
      req
        .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
        .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'));
    }
    return req.send(rawBody);
  }

  const read = (id: string, senderId: string) =>
    t
      .http()
      .get(`/api/v1/cs/booking-requests/${id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Cs-Sender', `telegram:${senderId}`)
      .expect(200)
      .then((r) => r.body as CsBookingRequestDto);
  const audits = (id: string) =>
    t.prisma.auditEvent.findMany({ where: { entity: 'CS_BOOKING_REQUEST', entityId: id } });
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  beforeAll(async () => {
    const config = {
      secret,
      accounts: [{ channel: 'TELEGRAM', channelAccountId: 'test-bot' }],
    };
    const env = {
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: `cancel-${randomUUID()}`,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({ [clientId]: config, [otherId]: config }),
    };
    t = await createTestApp({ ...env, CS_BOOKING_CANCEL_ENABLED: true });
    off = await createTestApp(env);
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    cookie = await signIn(t, admin.email);
    dxb = await branchId(t.prisma, 'DXB');
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    for (const [id, suffix] of [
      [originId, 'O'],
      [destinationId, 'D'],
    ] as const) {
      await t.prisma.location.create({
        data: {
          id,
          code: `${category}${suffix}`,
          nameEn: `${category}${suffix}`,
          nameAr: 'مدينة اختبار',
          kind: 'CITY',
          countryCode: 'AE',
        },
      });
    }
    await t.prisma.branchRoutingRule.create({ data: { locationId: originId, branchId: dxb } });
    for (const [id, k] of [
      [clientId, key],
      [otherId, otherKey],
    ] as const) {
      await t.prisma.apiClient.create({
        data: {
          id,
          name: 'Cancel test',
          keyPrefix: k.prefix,
          keyHash: k.hash,
          createdById: admin.id,
          customersRead: false,
          branches: { create: [{ branchId: dxb }] },
          scopes: { create: [{ scope: 'BOOKING_REQUESTS_CREATE', grantedById: admin.id }] },
        },
      });
    }
  });

  afterAll(async () => {
    await t?.close();
    await off?.close();
  });

  it('is off until the bot accepts the cancelled state', async () => {
    const sender = telegramId();
    const id = await make(sender);
    const res = await cancel(id, { subjectId: sender }, off).expect(503);
    expect(code(res)).toBe('CANCEL_UNAVAILABLE');
  });

  it('needs the sender proven: the key alone, another sender or another key cancel nothing', async () => {
    const sender = telegramId();
    const id = await make(sender);
    // Two senders share one key: only a signed identity of this sender counts (F161-1).
    expect(code(await cancel(id).expect(403))).toBe('OWNER_PROOF_REQUIRED');
    await cancel(id, { subjectId: telegramId() }).expect(404);
    await cancel(id, {
      subjectId: sender,
      sign: 'another-secret-of-thirty-two-characters!',
    }).expect(401);
    await cancel(id, { subjectId: sender, token: otherKey.key, client: otherId }).expect(404);
    await cancel(randomUUID(), { subjectId: sender }).expect(404);
    await cancel(id, { subjectId: sender, payload: { reason: '' } }).expect(400);
    await cancel(id, { subjectId: sender, payload: { other: 1 } }).expect(400);
    expect((await read(id, sender)).status).toBe('pending');
  });

  it('cancels an undecided request once; again answers the same', async () => {
    const sender = telegramId();
    const id = await make(sender);
    const done = await cancel(id, { subjectId: sender, payload: { reason: 'غيرت رأيي' } }).expect(
      200,
    );
    expect(done.body).toMatchObject({ requestId: id, status: 'cancelled' });
    const again = await cancel(id, { subjectId: sender }).expect(200);
    expect(again.body).toEqual(done.body);
    const records = await audits(id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: 'API', userId: null, action: 'CANCELLED' });
    expect(await read(id, sender)).toMatchObject({ status: 'cancelled', cancelRequest: null });

    // Staff can no longer decide it; the open list leaves it out, the cancelled list has it.
    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'CANCELLED', cancelReason: 'غيرت رأيي' });
    await t
      .http()
      .post(`/api/v1/cs-booking-requests/${id}/reject`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .send({ version: row.version, reasonCode: 'NEED_MORE_INFO' })
      .expect(409);
    const list = async (state: string) =>
      (
        (
          await t
            .http()
            .get(`/api/v1/cs-booking-requests?state=${state}`)
            .set('Cookie', cookie)
            .expect(200)
        ).body as { id: string }[]
      ).map((r) => r.id);
    expect(await list('open')).not.toContain(id);
    expect(await list('cancelled')).toContain(id);
  });

  it('keeps one cancel ask on an approved request, for staff to close', async () => {
    const sender = telegramId();
    const id = await make(sender);
    await t.prisma.csBookingRequest.update({ where: { id }, data: { status: 'APPROVED' } });
    const first = await cancel(id, { subjectId: sender, payload: { reason: 'ما محتاج' } }).expect(
      409,
    );
    expect(first.body).toMatchObject({ code: 'ALREADY_DECIDED', status: 'approved' });
    const asked = (first.body as { cancelRequest: { requestedAt: string } }).cancelRequest;
    const second = await cancel(id, { subjectId: sender }).expect(409);
    expect((second.body as { cancelRequest: unknown }).cancelRequest).toEqual(asked);
    expect(await audits(id)).toHaveLength(1);
    expect((await read(id, sender)).cancelRequest).toEqual({
      requestedAt: asked.requestedAt,
      closedAt: null,
    });
    const asks = (
      await t
        .http()
        .get('/api/v1/cs-booking-requests?state=cancel_requested')
        .set('Cookie', cookie)
        .expect(200)
    ).body as { id: string }[];
    expect(asks.map((r) => r.id)).toContain(id);

    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'APPROVED', cancelRequestReason: 'ما محتاج' });
    const close = (version: number) =>
      t
        .http()
        .post(`/api/v1/cs-booking-requests/${id}/cancel-request/close`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send({ version });
    await close(row.version - 1).expect(409);
    const closed = (await close(row.version).expect(201)).body as {
      status: string;
      cancelRequest: { closedAt: string | null };
    };
    expect(closed.status).toBe('approved');
    expect(closed.cancelRequest.closedAt).toBeTruthy();
    await close(row.version + 1).expect(409);
    expect((await read(id, sender)).cancelRequest?.closedAt).toBeTruthy();
  });

  it('refuses a rejected or expired request, with no cancel ask', async () => {
    for (const data of [
      { status: 'REJECTED' as const },
      { expiresAt: new Date(Date.now() - 1000) },
    ]) {
      const sender = telegramId();
      const id = await make(sender);
      await t.prisma.csBookingRequest.update({ where: { id }, data });
      const res = await cancel(id, { subjectId: sender }).expect(409);
      expect(res.body).toMatchObject({ code: 'ALREADY_DECIDED', cancelRequest: null });
      expect(await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({
        cancelRequestedAt: null,
        cancelledAt: null,
      });
    }
  });

  it('is 404 once the key no longer serves the request’s branch', async () => {
    const sender = telegramId();
    const id = await make(sender);
    await t.prisma.csBookingRequest.update({
      where: { id },
      data: { branchId: await branchId(t.prisma, 'JED') },
    });
    await cancel(id, { subjectId: sender }).expect(404);
  });

  it('cancels once when cancels race', async () => {
    const sender = telegramId();
    const id = await make(sender);
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => cancel(id, { subjectId: sender })),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await audits(id)).toHaveLength(1);
  });
});
