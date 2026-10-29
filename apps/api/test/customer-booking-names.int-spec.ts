import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsCustomerTokenAnswer,
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
import { uniquePhone } from './test-data.js';

/**
 * Booking requests in the bot's own words (erp-agents #247, the agent project's
 * nolon-request-ar.md R3): places and type by name, matched by NOLON; a number of pieces; the
 * price the bot showed, kept for staff only. What does not match stays for staff, and its bot
 * reads it as pending. Still a draft, once per idempotency key, the branch from the origin's rules.
 */
describe('Customer Service booking requests by names (R3)', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let bot: ApiClientCreatedDto;
  let otherBot: ApiClientCreatedDto;
  let noScope: ApiClientCreatedDto;
  let cookie = '';
  const ids: Record<string, string> = {};
  const names: Record<string, { ar: string; en: string }> = {};
  let category = '';
  let tag = '';
  let kind = { ar: '', en: '' };

  const create = (auth: string, body: object) =>
    t.http().post('/api/v1/cs/booking-requests').set('Authorization', `Bearer ${auth}`).send(body);
  const read = (auth: string, id: string) =>
    t.http().get(`/api/v1/cs/booking-requests/${id}`).set('Authorization', `Bearer ${auth}`);
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  /** Digits as the bot sends them; a sender of its own keeps other tests off its daily limit. */
  const digits = () => uniquePhone().slice(1);

  function body(extra: object = {}) {
    return {
      idempotencyKey: randomUUID().replaceAll('-', ''),
      channel: 'whatsapp',
      origin: names.city,
      destination: names.dest,
      kind,
      quantity: 2,
      senderName: 'محمد',
      senderPhone: digits(),
      receiverName: 'أحمد',
      receiverPhone: '0912345678',
      handover: 'dropoff',
      quotedPrice: { amount: '550', currency: 'SAR' },
      ...extra,
    };
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    cookie = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX)).email,
    );
    const key = async (scopes: CsScope[]) =>
      (
        await t
          .http()
          .post('/api/v1/api-clients')
          .set('Origin', APP_ORIGIN)
          .set('Cookie', cookie)
          .send({ name: 'Names', branchIds: [pts], scopes })
          .expect(201)
      ).body as ApiClientCreatedDto;
    const all: CsScope[] = ['cs:booking_requests:create', 'cs:customer_tokens:issue'];
    bot = await key(all);
    otherBot = await key(all);
    noScope = await key(['cs:customer_tokens:issue']);

    tag = `N${randomUUID().slice(0, 5).toUpperCase()}`;
    category = `${tag}K`;
    kind = { ar: `برميل ${tag}`, en: `Barrel ${tag}` };
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: kind.en,
        nameAr: kind.ar,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    const countryCode = `U${String.fromCharCode(65 + randomInt(26))}`;
    const place = async (
      key: string,
      suffix: string,
      kindOf: 'CITY' | 'PORT',
      name: { ar: string; en: string },
      extra: object = {},
    ) => {
      names[key] = name;
      ids[key] = (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: kindOf,
            nameEn: name.en,
            nameAr: name.ar,
            countryCode,
            ...extra,
          },
        })
      ).id;
    };
    await place('city', 'CIT', 'CITY', { ar: `جدة ${tag}`, en: `Jeddah ${tag}` });
    // A port of the city with the same name: the city is what the name means.
    await place('port', 'PRT', 'PORT', names.city!, { cityId: ids.city });
    await place('dest', 'DES', 'CITY', { ar: `الخرطوم ${tag}`, en: `Khartoum ${tag}` });
    await place('jedOnly', 'JDO', 'CITY', { ar: `ينبع ${tag}`, en: `Yanbu ${tag}` });
    await place('loose', 'LSE', 'CITY', { ar: `مكة ${tag}`, en: `Makkah ${tag}` });
    await t.prisma.locationAlias.create({
      data: { locationId: ids.dest!, alias: `Khartoum North ${tag}` },
    });
    const route = (location: string, branchIds: string[]) =>
      t
        .http()
        .put(`/api/v1/master-data/locations/${location}/routing-branches`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send({ branchIds })
        .expect(200);
    await route(ids.city!, [pts]);
    await route(ids.jedOnly!, [jed]);
  });

  afterAll(async () => {
    await t.close();
  });

  it('matches the names, keeps the bot’s price for staff, and answers pending', async () => {
    // Another name of the place, in another case and spacing, is the place too.
    const first = body({ destination: { ar: 'ما في', en: `KHARTOUM   north ${tag}` } });
    const made = await create(bot.key, first).expect(201);
    const created = made.body as CsBookingRequestCreated;
    expect(created).toMatchObject({ status: 'pending' });
    expect(created.requestId).toMatch(/^[A-Za-z0-9_-]{8,200}$/);

    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(row).toMatchObject({
      status: 'PENDING',
      branchId: pts,
      allowedBranchIds: [pts],
      originLocationId: ids.city,
      destinationLocationId: ids.dest,
      priceCategoryCode: category,
      ownerRef: `s:whatsapp:+${first.senderPhone}`,
      senderChannel: 'whatsapp',
      contactPhone: first.senderPhone,
      consigneeName: 'أحمد',
      consigneePhone: '0912345678',
      handover: 'BRANCH_DROP',
      botQuotedCurrency: 'SAR',
      quoteRef: null,
      language: null,
      customerId: null,
    });
    expect(row.quantity.toFixed()).toBe('2');
    expect(row.botQuotedAmount?.toFixed()).toBe('550');
    expect(row.botNames).toEqual({
      origin: names.city,
      destination: first.destination,
      kind,
    });

    // Once per idempotency key; another content under the key is refused.
    const again = await create(bot.key, first).expect(200);
    expect(again.body).toEqual(created);
    expect(code(await create(bot.key, { ...first, quantity: 3 }).expect(409))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('keeps what does not match for staff, read back as pending by the same key only', async () => {
    const unknown = body({
      origin: { ar: 'مكان ما معروف', en: `Nowhere ${randomUUID()}` },
      kind: { ar: 'نوع ما معروف', en: 'Unknown kind' },
      channel: 'telegram',
      handover: 'pickup',
      quotedPrice: null,
      quantity: '1.5',
    });
    const created = (await create(bot.key, unknown).expect(201)).body as CsBookingRequestCreated;
    expect(created.status).toBe('pending');
    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(row).toMatchObject({
      status: 'AWAITING_ROUTING',
      branchId: null,
      allowedBranchIds: [pts],
      originLocationId: null,
      destinationLocationId: ids.dest,
      priceCategoryCode: null,
      ownerRef: `s:telegram:tel:${unknown.senderPhone}`,
      handover: 'PICKUP',
      botQuotedAmount: null,
      botQuotedCurrency: null,
    });

    // A matched origin with no routing rule awaits staff too, among the key's branches.
    const loose = (await create(bot.key, body({ origin: names.loose })).expect(201))
      .body as CsBookingRequestCreated;
    expect(
      await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id: loose.requestId } }),
    ).toMatchObject({ status: 'AWAITING_ROUTING', originLocationId: ids.loose });

    const seen = (await read(bot.key, created.requestId).expect(200)).body as CsBookingRequestDto;
    expect(seen).toMatchObject({
      requestId: created.requestId,
      reference: row.reference,
      status: 'pending',
      bookingNumber: null,
    });
    await read(otherBot.key, created.requestId).expect(404);
  });

  it('refuses an origin another branch serves, a token, a missing scope and bad fields', async () => {
    expect(code(await create(bot.key, body({ origin: names.jedOnly })).expect(422))).toBe(
      'ORIGIN_NOT_SERVED',
    );
    expect(code(await create(noScope.key, body()).expect(403))).toBe('SCOPE_REQUIRED');

    const phone = uniquePhone();
    const sales = await signIn(
      t,
      (await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX)).email,
    );
    await t
      .http()
      .post('/api/v1/customers')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', sales)
      .send({ branchId: pts, kind: 'INDIVIDUAL', preferredCurrency: 'USD', phone, name: 'Names' })
      .expect(201);
    const answer = (
      await t
        .http()
        .post('/api/v1/cs/customer-tokens')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({ phone })
        .expect(200)
    ).body as CsCustomerTokenAnswer;
    if (answer.kind !== 'token') throw new Error(`Expected a token, got ${answer.kind}`);
    expect(code(await create(answer.token, body()).expect(400))).toBe('SENDER_WITH_TOKEN');
    // A token the key issued never reads the key's requests by names: not its customer's (F126-5).
    const named = (await create(bot.key, body()).expect(201)).body as CsBookingRequestCreated;
    await read(bot.key, named.requestId).expect(200);
    await read(answer.token, named.requestId).expect(404);

    for (const bad of [
      { quantity: 0 },
      { quantity: -1 },
      { quantity: 1.23456 },
      { quantity: 'two' },
      { senderPhone: 'abc' },
      { handover: 'door' },
      { channel: 'sms' },
      { quotedPrice: { amount: '-5', currency: 'SAR' } },
      { quotedPrice: { amount: 550, currency: 'SAR' } },
      { price: '1' },
      { origin: { ar: 'جدة' } },
    ]) {
      await create(bot.key, body(bad)).expect(400);
    }
  });

  it("refuses pickup when the key's bot does not offer it, before any row is written", async () => {
    const res = await t
      .http()
      .post('/api/v1/api-clients')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .send({
        name: 'No pickup',
        branchIds: [pts],
        scopes: ['cs:booking_requests:create'],
        services: [],
      })
      .expect(201);
    const quiet = res.body as ApiClientCreatedDto;
    expect(quiet.client.services).toEqual([]);
    const before = await t.prisma.csBookingRequest.count({
      where: { apiClientId: quiet.client.id },
    });
    const refused = await create(quiet.key, body({ handover: 'pickup' })).expect(422);
    expect(code(refused)).toBe('SERVICE_NOT_OFFERED');
    expect(await t.prisma.csBookingRequest.count({ where: { apiClientId: quiet.client.id } })).toBe(
      before,
    );
    await create(quiet.key, body({ handover: 'dropoff' })).expect(201);
  });
});
