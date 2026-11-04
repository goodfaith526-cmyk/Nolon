import { createHmac, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
  CsBookingRequestStaffDto,
  CsWebhooksDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/config/env.js';
import { CsOutboxWorker } from '../src/customer-service/cs-outbox.worker.js';
import type { DeliveryResult, NoticeTransport } from '../src/customer-service/webhook-delivery.js';
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

const SECRET = 'k'.repeat(32);
const HOST = 'agent.example.com';
const URL_OK = `https://${HOST}/api/v1/whatsapp/erp-events/nolon`;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { eventId: string; type: string; requestId: string; sequence: number };
  raw: Buffer;
}

/** A receiver that answers what `answer` says and keeps every notice it was sent. */
function fakeReceiver(
  answer: (sent: Sent) => DeliveryResult = () => ({ status: 200, error: null }),
) {
  const sent: Sent[] = [];
  const transport: NoticeTransport = {
    send(url, headers, raw) {
      const item = { url, headers, raw, body: JSON.parse(raw.toString('utf8')) as Sent['body'] };
      sent.push(item);
      return Promise.resolve(answer(item));
    },
  };
  return { sent, transport };
}

/**
 * Plan 09 section 5 (N-C5): endpoints approved by a second Administrator, one numbered stream of
 * notices per request written in the deciding transaction, and the worker sending them signed,
 * at least once, under the policy of the moment. Negative cases: same person approving, an address
 * not allowed, a missing permission, a rolled back decision, a revoked key, a branch the key no
 * longer serves, a 400 and a lease that ended.
 */
describe('Customer Service notices (plan 09 section 5)', () => {
  let t: TestApp;
  let krt = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', admin2: '', sales: '', ops: '' };
  const ids: Record<string, string> = {};
  let category = '';
  let createdById = '';
  const tag = `W${randomUUID().slice(0, 5).toUpperCase()}`;
  const worker = (transport: NoticeTransport, allowedHosts: string[] = [HOST]) =>
    new CsOutboxWorker(
      t.prisma,
      { CS_WEBHOOK_SECRET: SECRET, CS_WEBHOOK_ALLOWED_HOSTS: allowedHosts } as AppEnv,
      transport,
    );

  const staff = (cookie: string) => ({
    get: (path: string, query: object = {}) =>
      t.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  async function request(): Promise<string> {
    return (
      (
        await t
          .http()
          .post('/api/v1/cs/booking-requests')
          .set('Authorization', `Bearer ${bot.key}`)
          .send({
            sender: { channel: 'whatsapp', id: uniquePhone() },
            originId: ids.origin,
            destinationId: ids.dest,
            category,
            quantity: '2',
            services: [],
            senderName: 'Sender',
            consigneeName: 'Consignee',
            consigneePhone: '0912345678',
            handover: 'PICKUP',
            language: 'ar',
            idempotencyKey: `notice-${randomUUID()}`,
          })
          .expect(201)
      ).body as CsBookingRequestCreated
    ).requestId;
  }
  const detail = async (id: string) =>
    (await staff(cookies.sales).get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
  async function approve(id: string, status = 201, version?: number) {
    const inputs = {
      mode: 'ROAD',
      currency: 'USD',
      quantity: '2',
      originId: ids.origin!,
      destinationId: ids.dest!,
      category,
    };
    const price = (
      await staff(cookies.sales).get(`/cs-booking-requests/${id}/price`, inputs).expect(200)
    ).body as CsApprovalPriceDto;
    return staff(cookies.sales)
      .post(`/cs-booking-requests/${id}/approve`, {
        version: version ?? (await detail(id)).version,
        paymentCurrency: 'USD',
        pricing: inputs,
        pricingFingerprint: price.pricingFingerprint,
        booking: { customerId: ids.customer, services: [] },
      })
      .expect(status);
  }
  const stream = async (requestId: string) =>
    (
      await t.prisma.csOutboxEvent.findMany({ where: { requestId }, orderBy: { sequence: 'asc' } })
    ).map((e) => [e.sequence, e.type]);
  const webhooks = (cookie = cookies.admin) =>
    staff(cookie).get(`/api-clients/${bot.client.id}/webhooks`);

  beforeAll(async () => {
    t = await createTestApp({ CS_WEBHOOK_SECRET: SECRET, CS_WEBHOOK_ALLOWED_HOSTS: [HOST] });
    krt = await branchId(t.prisma, 'KRT');
    const user = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      createUser(t.prisma, roles, branches, LEDGER_PREFIX);
    cookies.admin = await signIn(t, (await user(['ADMINISTRATOR'], [])).email);
    cookies.admin2 = await signIn(t, (await user(['ADMINISTRATOR'], [])).email);
    const sales = await user(['SALES'], ['KRT']);
    createdById = sales.id;
    cookies.sales = await signIn(t, sales.email);
    cookies.ops = await signIn(t, (await user(['OPERATIONS'], ['KRT'])).email);
    bot = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Notices',
          branchIds: [krt],
          scopes: ['cs:booking_requests:create'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;
    for (const [name, suffix] of [
      ['origin', 'ORG'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Notices ${tag}${suffix}`,
            nameAr: 'مكان اختبار الإشعارات',
            countryCode: 'TD',
          },
        })
      ).id;
    }
    await t.prisma.branchRoutingRule.create({ data: { locationId: ids.origin!, branchId: krt } });
    category = `${tag}B`;
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'BARREL',
        defaultUnit: 'PER_BARREL',
      },
    });
    await t.prisma.rateCard.create({
      data: {
        branchId: krt,
        originLocationId: ids.origin!,
        destinationLocationId: ids.dest!,
        mode: 'ROAD',
        cargoType: 'BARREL',
        priceCategoryCode: category,
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_BARREL',
        price: '10',
        currency: 'USD',
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        status: 'APPROVED',
        createdById,
        approvedById: createdById,
        approvedAt: new Date(),
      },
    });
    ids.customer = (
      await t.prisma.customer.create({
        data: {
          number: `${tag}-1`,
          name: `${tag} customer`,
          phone: uniquePhone(),
          kind: 'COMPANY',
          createdById,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('queues nothing for a key without an approved endpoint', async () => {
    const id = await request();
    await approve(id);
    expect(await stream(id)).toEqual([]);
  });

  it('takes an endpoint added by one Administrator and approved by another', async () => {
    const add = (body: object, cookie = cookies.admin) =>
      staff(cookie).post(`/api-clients/${bot.client.id}/webhooks`, body);
    const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
    await add({ url: URL_OK, audience: 'erp-agents:nolon' }, cookies.sales).expect(403);
    await webhooks(cookies.ops).expect(403);
    expect(code(await add({ url: `http://${HOST}/x`, audience: 'a' }).expect(400))).toBe(
      'NOT_HTTPS',
    );
    expect(code(await add({ url: 'https://evil.example.org/x', audience: 'a' }).expect(400))).toBe(
      'HOST_NOT_ALLOWED',
    );
    expect(code(await add({ url: 'https://10.0.0.1/x', audience: 'a' }).expect(400))).toBe(
      'IP_HOST',
    );
    expect(code(await add({ url: `https://${HOST}:8443/x`, audience: 'a' }).expect(400))).toBe(
      'NOT_PORT_443',
    );

    const first = (await add({ url: URL_OK, audience: 'erp-agents:nolon' }).expect(201))
      .body as CsWebhooksDto;
    expect(first).toMatchObject({
      secretConfigured: true,
      workerEnabled: false,
      allowedHosts: [HOST],
    });
    const pending = first.endpoints[0]!;
    expect(pending).toMatchObject({ status: 'PENDING', canApprove: false });
    const approvePath = (endpointId: string) =>
      `/api-clients/${bot.client.id}/webhooks/${endpointId}/approve`;
    expect(code(await staff(cookies.admin).post(approvePath(pending.id), {}).expect(403))).toBe(
      'SAME_PERSON',
    );
    await staff(cookies.sales).post(approvePath(pending.id), {}).expect(403);
    expect(
      ((await webhooks(cookies.admin2).expect(200)).body as CsWebhooksDto).endpoints[0]!.canApprove,
    ).toBe(true);
    const approved = (await staff(cookies.admin2).post(approvePath(pending.id), {}).expect(200))
      .body as CsWebhooksDto;
    expect(approved.endpoints[0]?.status).toBe('APPROVED');
    expect(approved.endpoints[0]?.approvedByName).toBeTruthy();
    await staff(cookies.admin2).post(approvePath(pending.id), {}).expect(409);

    // A second one replaces it on approval: one approved endpoint per key, always.
    const second = (
      (await add({ url: `${URL_OK}?v=2`, audience: 'erp-agents:nolon' }).expect(201))
        .body as CsWebhooksDto
    ).endpoints[0]!;
    await staff(cookies.admin2).post(approvePath(second.id), {}).expect(200);
    const rows = await t.prisma.csWebhookEndpoint.findMany({
      where: { apiClientId: bot.client.id },
    });
    expect(rows.filter((r) => r.status === 'APPROVED').map((r) => r.id)).toEqual([second.id]);
    expect(rows.find((r) => r.id === pending.id)?.status).toBe('RETIRED');
    // The database refuses an endpoint approved by its own creator, or a second approved one.
    const [row] = rows;
    await expect(
      t.prisma.csWebhookEndpoint.create({
        data: {
          apiClientId: bot.client.id,
          url: URL_OK,
          audience: 'x',
          status: 'APPROVED',
          approvedKey: bot.client.id,
          createdById: row!.createdById,
          approvedById: row!.createdById,
        },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.csWebhookEndpoint.create({
        data: {
          apiClientId: bot.client.id,
          url: URL_OK,
          audience: 'x',
          status: 'APPROVED',
          approvedKey: bot.client.id,
          createdById: row!.createdById,
          approvedById: row!.approvedById ?? createdById,
        },
      }),
    ).rejects.toThrow();
    // F172-2: an endpoint never approved is retired with no approver.
    const unwanted = (
      (await add({ url: `${URL_OK}?v=3`, audience: 'erp-agents:nolon' }).expect(201))
        .body as CsWebhooksDto
    ).endpoints[0]!;
    expect(unwanted.status).toBe('PENDING');
    await staff(cookies.admin)
      .post(`/api-clients/${bot.client.id}/webhooks/${unwanted.id}/retire`, {})
      .expect(200);
    expect(
      await t.prisma.csWebhookEndpoint.findUniqueOrThrow({ where: { id: unwanted.id } }),
    ).toMatchObject({ status: 'RETIRED', approvedById: null, approvedKey: null });
    // Back to the first address for the rest of this file.
    await staff(cookies.admin)
      .post(`/api-clients/${bot.client.id}/webhooks/${second.id}/retire`, {})
      .expect(200);
    const third = (
      (await add({ url: URL_OK, audience: 'erp-agents:nolon' }).expect(201)).body as CsWebhooksDto
    ).endpoints[0]!;
    await staff(cookies.admin2).post(approvePath(third.id), {}).expect(200);
  });

  it('numbers one stream per request: decision, then shipment stages, then delivery', async () => {
    const id = await request();
    // A decision that fails (stale version) leaves no notice.
    await approve(id, 409, 999);
    expect(await stream(id)).toEqual([]);
    const approved = (await approve(id)).body as CsBookingRequestStaffDto;
    expect(await stream(id)).toEqual([[1, 'request.approved']]);

    const bookingId = (await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } }))
      .bookingId!;
    expect(approved.status).toBe('approved');
    await t.prisma.bookingItem.create({
      data: { bookingId, lineNo: 1, cargoType: 'BARREL', quantity: 2 },
    });
    await staff(cookies.sales).post(`/bookings/${bookingId}/confirm`, {}).expect(200);
    const shipment = await t.prisma.shipment.findUniqueOrThrow({ where: { bookingId } });
    for (const status of ['TRIP_SCHEDULED', 'ROAD_DEPARTED', 'ROAD_ARRIVED', 'DELIVERED']) {
      await staff(cookies.admin).post(`/shipments/${shipment.id}/status`, { status }).expect(200);
    }
    const events = await stream(id);
    // 1, 2, 3, ... with no gap and no repeat; a status that keeps the stage sends nothing.
    expect(events.map(([seq]) => seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]).toEqual([1, 'request.approved']);
    expect(events.slice(-2).map(([, type]) => type)).toEqual([
      'shipment.stage_changed',
      'shipment.delivered',
    ]);
    const stages = events.filter(([, type]) => type === 'shipment.stage_changed').length;
    expect(stages).toBeGreaterThanOrEqual(2);
    expect(stages).toBeLessThanOrEqual(5);
    expect(
      (await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } })).lastStageCode,
    ).toBe('DELIVERED');
    ids.streamed = id;
  });

  it('sends each notice signed, once, and retries or gives up as the receiver answers', async () => {
    const id = ids.streamed!;
    const receiver = fakeReceiver();
    const round = await worker(receiver.transport).runOnce();
    expect(round.leased).toBeGreaterThan(0);
    const mine = receiver.sent.filter((s) => s.body.requestId === id);
    expect(mine.map((s) => s.body.sequence)).toEqual((await stream(id)).map(([seq]) => seq));
    for (const s of mine) {
      expect(s.url).toBe(URL_OK);
      expect(s.headers['X-Nolon-Key-Id']).toBe(bot.client.id);
      const expected = createHmac('sha256', SECRET)
        .update(`v1\nerp-agents:nolon\n${bot.client.id}\n${s.headers['X-Nolon-Timestamp']}\n`)
        .update(s.raw)
        .digest('base64url');
      expect(s.headers['X-Nolon-Signature']).toBe(expected);
      expect(Object.keys(s.body).sort()).toEqual([
        'eventId',
        'occurredAt',
        'requestId',
        'sequence',
        'type',
      ]);
    }
    const rows = await t.prisma.csOutboxEvent.findMany({ where: { requestId: id } });
    expect(rows.every((r) => r.status === 'SENT' && r.sentAt !== null && r.attempts === 1)).toBe(
      true,
    );
    // Sent once: a second round has nothing of this request.
    const again = fakeReceiver();
    await worker(again.transport).runOnce();
    expect(again.sent.filter((s) => s.body.requestId === id)).toEqual([]);

    // 503 is tried again later; 400 is given up.
    const busy = await request();
    await approve(busy);
    await worker(fakeReceiver(() => ({ status: 503, error: null })).transport).runOnce();
    const retried = await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: busy } });
    expect(retried).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastStatus: 503,
      leaseUntil: null,
    });
    expect(retried.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // Not due yet: nothing is sent.
    const early = fakeReceiver();
    await worker(early.transport).runOnce();
    expect(early.sent.filter((s) => s.body.requestId === busy)).toEqual([]);
    await worker(fakeReceiver(() => ({ status: 400, error: null })).transport).runOnce(
      new Date(Date.now() + 60_000),
    );
    expect(
      await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: busy } }),
    ).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      lastStatus: 400,
    });
    const view = (await webhooks().expect(200)).body as CsWebhooksDto;
    expect(view.counts.FAILED).toBeGreaterThanOrEqual(1);
    expect(view.recent.find((r) => r.status === 'FAILED')).toMatchObject({ lastStatus: 400 });
  });

  it('sends a notice again with the same eventId when a lease ended, and once when two workers race', async () => {
    const id = await request();
    await approve(id);
    const row = await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: id } });
    // A worker leased it and stopped before recording: the lease ends, another sends it.
    await t.prisma.csOutboxEvent.update({
      where: { id: row.id },
      data: { status: 'SENDING', attempts: 1, leaseUntil: new Date(Date.now() - 1000) },
    });
    const receiver = fakeReceiver();
    await worker(receiver.transport).runOnce();
    expect(receiver.sent.filter((s) => s.body.requestId === id).map((s) => s.body.eventId)).toEqual(
      [row.id],
    );
    expect(await t.prisma.csOutboxEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject(
      {
        status: 'SENT',
        attempts: 2,
      },
    );

    const raced = await request();
    await approve(raced);
    const both = fakeReceiver();
    await Promise.all([worker(both.transport).runOnce(), worker(both.transport).runOnce()]);
    expect(both.sent.filter((s) => s.body.requestId === raced)).toHaveLength(1);
  });

  it('never sends a notice past its 24 hours, however late the worker runs (F172-3)', async () => {
    const late = await request();
    await approve(late);
    const old = new Date(Date.now() - 48 * 3600_000);
    await t.prisma.csOutboxEvent.updateMany({
      where: { requestId: late },
      data: { createdAt: old },
    });
    const recovered = await request();
    await approve(recovered);
    // A lease that ended after the deadline is not sent either.
    await t.prisma.csOutboxEvent.updateMany({
      where: { requestId: recovered },
      data: {
        createdAt: old,
        status: 'SENDING',
        attempts: 1,
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    const receiver = fakeReceiver();
    await worker(receiver.transport).runOnce();
    expect(
      receiver.sent.filter((s) => s.body.requestId === late || s.body.requestId === recovered),
    ).toEqual([]);
    for (const id of [late, recovered])
      expect(
        await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: id } }),
      ).toMatchObject({ status: 'FAILED', lastError: 'EXPIRED' });
  });

  it('does not send a notice that expires while the batch sends earlier ones (F172-3)', async () => {
    const first = await request();
    await approve(first);
    const second = await request();
    await approve(second);
    // Both expire 500 ms from now; the first send takes 750 ms.
    const created = new Date(Date.now() - 24 * 3600_000 + 500);
    await t.prisma.csOutboxEvent.updateMany({
      where: { requestId: { in: [first, second] } },
      data: { createdAt: created },
    });
    const sent: string[] = [];
    const slow: NoticeTransport = {
      async send(_url, _headers, raw) {
        const { requestId } = JSON.parse(raw.toString('utf8')) as { requestId: string };
        if (requestId === first || requestId === second) {
          sent.push(requestId);
          await new Promise((done) => setTimeout(done, 750));
        }
        return { status: 200, error: null };
      },
    };
    const [a, b] = [first, second].sort();
    await worker(slow).runOnce();
    expect(sent).toEqual([a]);
    expect(
      await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: b } }),
    ).toMatchObject({ status: 'FAILED', lastError: 'EXPIRED' });
  });

  it('sends nothing to a host no longer allowed (F172-1)', async () => {
    const id = await request();
    await approve(id);
    const receiver = fakeReceiver();
    await worker(receiver.transport, []).runOnce();
    expect(receiver.sent.filter((s) => s.body.requestId === id)).toEqual([]);
    expect(
      await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: id } }),
    ).toMatchObject({ status: 'CANCELLED_BY_POLICY' });
  });

  it('sends nothing once the key is revoked or no longer serves the branch', async () => {
    const moved = await request();
    await approve(moved);
    const pts = await branchId(t.prisma, 'PTS');
    await t.prisma.csBookingRequest.update({ where: { id: moved }, data: { branchId: pts } });
    const receiver = fakeReceiver();
    await worker(receiver.transport).runOnce();
    expect(receiver.sent.filter((s) => s.body.requestId === moved)).toEqual([]);
    expect(
      await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: moved } }),
    ).toMatchObject({
      status: 'CANCELLED_BY_POLICY',
    });

    const revoked = await request();
    await approve(revoked);
    await staff(cookies.admin).post(`/api-clients/${bot.client.id}/revoke`, {}).expect(200);
    const after = fakeReceiver();
    await worker(after.transport).runOnce();
    expect(after.sent.filter((s) => s.body.requestId === revoked)).toEqual([]);
    expect(
      await t.prisma.csOutboxEvent.findFirstOrThrow({ where: { requestId: revoked } }),
    ).toMatchObject({
      status: 'CANCELLED_BY_POLICY',
    });
  });
});
