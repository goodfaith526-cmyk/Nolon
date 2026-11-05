import { createHmac, randomUUID } from 'node:crypto';
import type { CsBookingRequestCreated, CsOwnBookingRequestDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import {
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

/**
 * GET /cs/booking-requests (owner, 2026-11-05): the bot lists its customer's requests from NOLON.
 * The owner is proven as for cancelling: a signed channel identity of the sender, never the key
 * alone. Negative cases: no proof, a bad signature, another sender, another key, a branch the key
 * no longer serves.
 */
describe('Customer Service booking request list', () => {
  let t: TestApp;
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

  /** GET /cs/booking-requests, signed (plan 08) for `subjectId` when given; the key alone otherwise. */
  function list(
    opts: {
      subjectId?: string;
      sign?: string;
      token?: string;
      client?: string;
      query?: string;
    } = {},
  ) {
    const path = `/api/v1/cs/booking-requests${opts.query ? `?${opts.query}` : ''}`;
    const req = t
      .http()
      .get(path)
      .set('Authorization', `Bearer ${opts.token ?? key.key}`);
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
        'GET',
        path,
        '',
        issued,
        sha256(rawContext),
        sha256(''),
      ].join('\n');
      const signature = createHmac('sha256', opts.sign ?? secret)
        .update(payload)
        .digest('base64url');
      req
        .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
        .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'));
    }
    return req;
  }
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const listed = (res: { body: unknown }) => res.body as CsOwnBookingRequestDto[];

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
    t = await createTestApp(env);
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
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
  });

  it('needs the sender proven: the key alone or a bad signature lists nothing', async () => {
    const sender = telegramId();
    await make(sender);
    expect(code(await list().expect(403))).toBe('OWNER_PROOF_REQUIRED');
    await list({ subjectId: sender, sign: 'another-secret-of-at-least-32-characters' }).expect(401);
  });

  it("lists the proven sender's own requests, newest first, and no other sender's", async () => {
    const sender = telegramId();
    const other = telegramId();
    const first = await make(sender);
    const second = await make(sender);
    await make(other);
    const mine = listed(await list({ subjectId: sender }).expect(200));
    expect(mine.map((r) => r.requestId)).toEqual([second, first]);
    expect(mine[0]).toMatchObject({
      status: 'pending',
      bookingNumber: null,
      origin: { ar: 'مدينة اختبار', en: `${category}O` },
      destination: { ar: 'مدينة اختبار', en: `${category}D` },
      attention: null,
      shipment: null,
    });
    expect(mine[0]?.stage).not.toBeNull();
    expect(listed(await list({ subjectId: sender, query: 'limit=1' }).expect(200))).toHaveLength(1);
    await list({ subjectId: sender, query: 'limit=0' }).expect(400);
  });

  it('lists nothing through another key, and leaves out a branch the key no longer serves', async () => {
    const sender = telegramId();
    const id = await make(sender);
    // The same sender, signed for another key: requests belong to the key that made them.
    const viaOther = await list({ subjectId: sender, token: otherKey.key, client: otherId }).expect(
      200,
    );
    expect(listed(viaOther)).toEqual([]);
    const krt = await branchId(t.prisma, 'KRT');
    await t.prisma.csBookingRequest.update({ where: { id }, data: { branchId: krt } });
    expect(listed(await list({ subjectId: sender }).expect(200))).toEqual([]);
  });
});
