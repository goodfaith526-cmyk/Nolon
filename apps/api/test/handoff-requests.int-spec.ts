import { randomInt, randomUUID } from 'node:crypto';
import type {
  AlertsDto,
  ApiClientCreatedDto,
  CsHandoffCreated,
  CsHandoffRequestDto,
  CsScope,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';

/**
 * 2026-11-12: a customer asks the bot for a person. The bot's key sends it (scope
 * cs:handoff_requests:create), once per idempotency key; the branch comes from the departure
 * city, else every branch of the key; staff of those branches see it, in the bell too, and mark
 * it contacted. Other branches see nothing.
 */
describe('Customer Service handoff requests', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let bot: ApiClientCreatedDto;
  let otherBot: ApiClientCreatedDto;
  let noScope: ApiClientCreatedDto;
  const cookies = { admin: '', ptsSales: '', jedSales: '', viewer: '' };
  let cityAr = '';

  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const send = (key: string, body: object) =>
    t.http().post('/api/v1/cs/handoff-requests').set('Authorization', `Bearer ${key}`).send(body);
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  function body(extra: object = {}) {
    return {
      idempotencyKey: `hand-${randomUUID()}`,
      channel: 'telegram',
      sender: String(randomInt(1, 2 ** 40)),
      customerName: 'Handoff Customer',
      customerPhone: `+2499${randomInt(10_000_000, 99_999_999)}`,
      reason: 'غسالة من القاهرة لبورتسودان، محتاج تسعير',
      ...extra,
    };
  }

  async function makeKey(branchIds: string[], scopes: CsScope[]): Promise<ApiClientCreatedDto> {
    return (
      await post('/api-clients', cookies.admin, { name: 'Handoff', branchIds, scopes }).expect(201)
    ).body as ApiClientCreatedDto;
  }

  const list = async (cookie: string, state = 'open') =>
    (await get(`/cs-handoff-requests?state=${state}`, cookie).expect(200))
      .body as CsHandoffRequestDto[];

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    cookies.admin = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX)).email,
    );
    cookies.ptsSales = await signIn(
      t,
      (await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX)).email,
    );
    cookies.jedSales = await signIn(
      t,
      (await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX)).email,
    );
    cookies.viewer = await signIn(
      t,
      (await createUser(t.prisma, ['DRIVER'], ['PTS'], LEDGER_PREFIX)).email,
    );
    bot = await makeKey([pts, jed], ['cs:handoff_requests:create']);
    otherBot = await makeKey([pts, jed], ['cs:handoff_requests:create']);
    noScope = await makeKey([pts], ['cs:catalog:read']);

    const tag = `H${randomUUID().slice(0, 5).toUpperCase()}`;
    cityAr = `مدينة ${tag}`;
    const city = await t.prisma.location.create({
      data: {
        code: `${tag}C`,
        kind: 'CITY',
        nameEn: `Handoff ${tag}`,
        nameAr: cityAr,
        countryCode: `W${String.fromCharCode(65 + randomInt(26))}`,
      },
    });
    await t
      .http()
      .put(`/api/v1/master-data/locations/${city.id}/routing-branches`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.admin)
      .send({ branchIds: [jed] })
      .expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  it('refuses a key without the scope (403) and a bad body (400)', async () => {
    expect((await send(noScope.key, body())).status).toBe(403);
    expect((await send(bot.key, body({ reason: '' }))).status).toBe(400);
    expect((await send(bot.key, body({ extra: 1 }))).status).toBe(400);
    expect((await send(bot.key, body({ channel: 'sms' }))).status).toBe(400);
  });

  it('makes one request per idempotency key, and refuses the key with other content', async () => {
    const b = body();
    const first = await send(bot.key, b).expect(201);
    const made = first.body as CsHandoffCreated;
    expect(made.status).toBe('open');
    const again = await send(bot.key, b).expect(200);
    expect((again.body as CsHandoffCreated).id).toBe(made.id);
    const other = await send(bot.key, { ...b, reason: 'سبب آخر' }).expect(409);
    expect(code(other)).toBe('IDEMPOTENCY_CONFLICT');
    // Another key with the same idempotency key is another request.
    const second = await send(otherBot.key, b).expect(201);
    expect((second.body as CsHandoffCreated).id).not.toBe(made.id);
    expect(
      await t.prisma.csHandoffRequest.count({ where: { idempotencyKey: b.idempotencyKey } }),
    ).toBe(2);
  });

  it('routes by the departure city: JED staff see it, PTS staff do not', async () => {
    const made = (await send(bot.key, body({ branchHint: cityAr })).expect(201))
      .body as CsHandoffCreated;
    const jedRows = await list(cookies.jedSales);
    const row = jedRows.find((r) => r.id === made.id);
    expect(row?.branchId).toBe(jed);
    expect(row?.branchHint).toBe(cityAr);
    expect((await list(cookies.ptsSales)).some((r) => r.id === made.id)).toBe(false);
    // Out of their branches: not found, and nothing changes.
    await post(`/cs-handoff-requests/${made.id}/contacted`, cookies.ptsSales).expect(404);
  });

  it('an unknown city goes to every branch of the key', async () => {
    const made = (await send(bot.key, body({ branchHint: 'مدينة غير معروفة' })).expect(201))
      .body as CsHandoffCreated;
    for (const cookie of [cookies.ptsSales, cookies.jedSales]) {
      const row = (await list(cookie)).find((r) => r.id === made.id);
      expect(row?.branchId).toBeNull();
    }
  });

  it('shows in the bell, and leaves it once marked contacted', async () => {
    const made = (await send(bot.key, body()).expect(201)).body as CsHandoffCreated;
    const alerts = (await get('/alerts', cookies.ptsSales).expect(200)).body as AlertsDto;
    const group = alerts.groups.find((g) => g.kind === 'HANDOFF_REQUEST_OPEN');
    expect(group?.items.some((a) => a.refId === made.id)).toBe(true);

    const done = (
      await post(`/cs-handoff-requests/${made.id}/contacted`, cookies.ptsSales).expect(201)
    ).body as CsHandoffRequestDto;
    expect(done.status).toBe('contacted');
    expect(done.contactedByName).not.toBeNull();
    // Twice: the same answer, not a second change.
    await post(`/cs-handoff-requests/${made.id}/contacted`, cookies.ptsSales).expect(201);

    const after = (await get('/alerts', cookies.ptsSales).expect(200)).body as AlertsDto;
    const still = after.groups.find((g) => g.kind === 'HANDOFF_REQUEST_OPEN');
    expect(still?.items.some((a) => a.refId === made.id) ?? false).toBe(false);
    expect((await list(cookies.ptsSales)).some((r) => r.id === made.id)).toBe(false);
    expect((await list(cookies.ptsSales, 'all')).some((r) => r.id === made.id)).toBe(true);

    const status = await t
      .http()
      .get(`/api/v1/cs/handoff-requests/${made.id}`)
      .set('Authorization', `Bearer ${bot.key}`)
      .expect(200);
    expect((status.body as CsHandoffCreated).status).toBe('contacted');
    // Another key does not read it.
    await t
      .http()
      .get(`/api/v1/cs/handoff-requests/${made.id}`)
      .set('Authorization', `Bearer ${otherBot.key}`)
      .expect(404);
  });

  it('refuses staff without the permission', async () => {
    await get('/cs-handoff-requests', cookies.viewer).expect(403);
    const made = (await send(bot.key, body()).expect(201)).body as CsHandoffCreated;
    await post(`/cs-handoff-requests/${made.id}/contacted`, cookies.viewer).expect(403);
  });
});
