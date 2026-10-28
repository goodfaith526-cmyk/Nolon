import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsCustomerTokenAnswer,
  CsQuoteDto,
  CsScope,
  CustomerDto,
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
 * Booking requests from a customer-service client (R3, docs/plans/04 sections 6, 7.1, 7.2 and
 * 11): a draft only; the owner is a customer token's customer or a channel identity; one request
 * per idempotency key, at most five new ones a day; the branch from the origin's routing rules,
 * capped by the key's branches; read back by the same owner and key only.
 */
describe('Customer Service booking requests (R3)', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let dxb = '';
  let salesId = '';
  const cookies = { admin: '', sales: '' };
  const ids: Record<string, string> = {};
  let category = '';
  let bot: ApiClientCreatedDto;
  let otherBot: ApiClientCreatedDto;
  let noScope: ApiClientCreatedDto;
  let alpha: CustomerDto;
  let beta: CustomerDto;
  const alphaPhone = uniquePhone();
  const betaPhone = uniquePhone();

  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const create = (auth: string, body: object) =>
    t.http().post('/api/v1/cs/booking-requests').set('Authorization', `Bearer ${auth}`).send(body);
  const read = (auth: string, id: string, sender?: string) => {
    const req = t
      .http()
      .get(`/api/v1/cs/booking-requests/${id}`)
      .set('Authorization', `Bearer ${auth}`);
    return sender ? req.set('X-Cs-Sender', sender) : req;
  };
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  /** A WhatsApp sender of its own, so no other test's requests count toward its daily limit. */
  const newSender = () => ({ channel: 'whatsapp', id: uniquePhone() });

  function body(extra: object = {}) {
    return {
      originId: ids.served!,
      destinationId: ids.dest!,
      category,
      quantity: '2',
      services: ['PICKUP'],
      senderName: 'Sender',
      consigneeName: 'Consignee',
      consigneePhone: uniquePhone(),
      handover: 'PICKUP',
      language: 'ar',
      idempotencyKey: `idem-${randomUUID()}`,
      ...extra,
    };
  }

  async function makeKey(branchIds: string[], scopes: CsScope[]): Promise<ApiClientCreatedDto> {
    return (
      await post('/api-clients', cookies.admin, { name: 'Requests', branchIds, scopes }).expect(201)
    ).body as ApiClientCreatedDto;
  }

  async function tokenFor(key: string, phone: string): Promise<string> {
    const answer = (
      await t
        .http()
        .post('/api/v1/cs/customer-tokens')
        .set('Authorization', `Bearer ${key}`)
        .send({ phone })
        .expect(200)
    ).body as CsCustomerTokenAnswer;
    if (answer.kind !== 'token') throw new Error(`Expected a token, got ${answer.kind}`);
    return answer.token;
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    dxb = await branchId(t.prisma, 'DXB');
    // Requests reference the customers, the key and the users: LEDGER_PREFIX keeps them.
    const sales = await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    salesId = sales.id;
    cookies.sales = await signIn(t, sales.email);
    cookies.admin = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX)).email,
    );
    const all: CsScope[] = [
      'cs:customer_tokens:issue',
      'cs:booking_requests:create',
      'cs:quote:read',
    ];
    bot = await makeKey([pts], all);
    otherBot = await makeKey([pts], all);
    noScope = await makeKey([pts], ['cs:customer_tokens:issue', 'cs:quote:read']);

    const customer = async (phone: string, name: string) =>
      (
        await post('/customers', cookies.sales, {
          branchId: pts,
          kind: 'INDIVIDUAL',
          preferredCurrency: 'USD',
          phone,
          name,
        }).expect(201)
      ).body as CustomerDto;
    alpha = await customer(alphaPhone, 'Alpha Requests');
    beta = await customer(betaPhone, 'Beta Requests');

    const tag = `B${randomUUID().slice(0, 5).toUpperCase()}`;
    category = `${tag}S`;
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    const countryCode = `V${String.fromCharCode(65 + randomInt(26))}`;
    const place = async (suffix: string) =>
      (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Requests ${tag}${suffix}`,
            nameAr: 'مكان اختبار الطلبات',
            countryCode,
          },
        })
      ).id;
    for (const [name, suffix] of [
      ['served', 'SRV'],
      ['jedOnly', 'JED'],
      ['twoOk', 'TOK'],
      ['twoOut', 'TOU'],
      ['none', 'NON'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = await place(suffix);
    }
    const route = async (location: string, branchIds: string[]) =>
      t
        .http()
        .put(`/api/v1/master-data/locations/${location}/routing-branches`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.admin)
        .send({ branchIds })
        .expect(200);
    await route(ids.served!, [pts]);
    await route(ids.jedOnly!, [jed]);
    await route(ids.twoOk!, [pts, dxb]);
    await route(ids.twoOut!, [jed, dxb]);
    await t.prisma.rateCard.create({
      data: {
        branchId: pts,
        originLocationId: ids.served!,
        destinationLocationId: ids.dest!,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_SHIPMENT',
        price: '40',
        currency: 'USD',
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        status: 'APPROVED',
        createdById: salesId,
        approvedById: salesId,
        approvedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it('needs the booking-request scope, with the key or with a customer token', async () => {
    const res = await create(noScope.key, body({ sender: newSender() })).expect(403);
    expect(code(res)).toBe('SCOPE_REQUIRED');
    const token = await tokenFor(noScope.key, alphaPhone);
    expect(code(await create(token, body()).expect(403))).toBe('SCOPE_REQUIRED');
    await t.http().post('/api/v1/cs/booking-requests').send(body()).expect(401);
  });

  it('makes one request per idempotency key and refuses the key for other content', async () => {
    const sender = newSender();
    const first = body({ sender });
    const made = await create(bot.key, first).expect(201);
    const created = made.body as CsBookingRequestCreated;
    expect(created).toMatchObject({ status: 'pending' });
    expect(created.reference).toMatch(/^BR-\d{6,}$/);
    // The same content in another order is the same request.
    const again = await create(bot.key, { ...first, services: ['PICKUP'] }).expect(200);
    expect(again.body).toEqual(created);
    const other = await create(bot.key, { ...first, quantity: '3' }).expect(409);
    expect(code(other)).toBe('IDEMPOTENCY_CONFLICT');

    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(row).toMatchObject({
      apiClientId: bot.client.id,
      ownerRef: `s:whatsapp:${sender.id}`,
      senderChannel: 'whatsapp',
      senderId: sender.id,
      customerId: null,
      branchId: pts,
      status: 'PENDING',
      allowedBranchIds: [pts],
    });
  });

  it('keeps one row for ten concurrent sends, and a retry never counts toward the day', async () => {
    const sender = newSender();
    const same = body({ sender });
    const answers = await Promise.all(Array.from({ length: 10 }, () => create(bot.key, same)));
    const idsSeen = new Set(answers.map((a) => (a.body as CsBookingRequestCreated).requestId));
    expect(idsSeen.size).toBe(1);
    expect(answers.filter((a) => a.status === 201)).toHaveLength(1);
    expect(answers.every((a) => a.status === 201 || a.status === 200)).toBe(true);
    expect(
      await t.prisma.csBookingRequest.count({ where: { ownerRef: `s:whatsapp:${sender.id}` } }),
    ).toBe(1);

    for (let i = 0; i < 4; i += 1) await create(bot.key, body({ sender })).expect(201);
    const sixth = await create(bot.key, body({ sender })).expect(429);
    expect(code(sixth)).toBe('DAILY_LIMIT');
    await create(bot.key, same).expect(200);
  });

  it('takes the branch from the origin only, capped by the key', async () => {
    const sender = newSender();
    for (const origin of [ids.jedOnly!, ids.twoOut!, ids.none!]) {
      const res = await create(bot.key, body({ sender, originId: origin })).expect(422);
      expect(code(res)).toBe('ORIGIN_NOT_SERVED');
    }
    expect(
      await t.prisma.csBookingRequest.count({ where: { ownerRef: `s:whatsapp:${sender.id}` } }),
    ).toBe(0);
    const routing = (await create(bot.key, body({ sender, originId: ids.twoOk! })).expect(201))
      .body as CsBookingRequestCreated;
    expect(routing.status).toBe('awaiting_routing');
    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: routing.requestId },
    });
    expect(row).toMatchObject({ branchId: null, allowedBranchIds: [pts] });
  });

  it('is read back by its owner, through the same key, while the key serves its branch', async () => {
    const sender = newSender();
    const made = (await create(bot.key, body({ sender })).expect(201))
      .body as CsBookingRequestCreated;
    const header = `whatsapp:${sender.id}`;
    const got = (await read(bot.key, made.requestId, header).expect(200))
      .body as CsBookingRequestDto;
    expect(got).toMatchObject({
      requestId: made.requestId,
      reference: made.reference,
      status: 'pending',
      bookingNumber: null,
      customerReason: null,
      paymentInstructions: null,
    });
    await read(bot.key, made.requestId).expect(404);
    await read(bot.key, made.requestId, `whatsapp:${uniquePhone()}`).expect(404);
    await read(bot.key, made.requestId, 'nonsense').expect(404);
    await read(otherBot.key, made.requestId, header).expect(404);
    await read(bot.key, randomUUID(), header).expect(404);

    // Expired after its time with no decision.
    await t.prisma.csBookingRequest.update({
      where: { id: made.requestId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      ((await read(bot.key, made.requestId, header).expect(200)).body as CsBookingRequestDto)
        .status,
    ).toBe('expired');

    // The key no longer serves the request's branch: as if it did not exist.
    const narrow = await makeKey([pts], ['cs:booking_requests:create']);
    const mine = (await create(narrow.key, body({ sender })).expect(201))
      .body as CsBookingRequestCreated;
    await t.prisma.apiClientBranch.create({
      data: { apiClientId: narrow.client.id, branchId: jed },
    });
    await t.prisma.apiClientBranch.delete({
      where: { apiClientId_branchId: { apiClientId: narrow.client.id, branchId: pts } },
    });
    await read(narrow.key, mine.requestId, header).expect(404);
  });

  it("is a customer token's customer's, and refuses naming an owner beside the token", async () => {
    const token = await tokenFor(bot.key, alphaPhone);
    await create(token, body({ sender: newSender() })).expect(400);
    await create(token, body({ customerNumber: beta.number })).expect(400);
    await create(bot.key, body()).expect(400);

    const made = (await create(token, body()).expect(201)).body as CsBookingRequestCreated;
    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: made.requestId },
    });
    expect(row).toMatchObject({ customerId: alpha.id, senderChannel: null });
    expect(row.ownerRef).toMatch(new RegExp(`^c:${alpha.id}:g[0-9a-f]{40}$`));
    await read(token, made.requestId).expect(200);
    // Another customer's token, or the key alone with the customer's phone: not theirs.
    await read(await tokenFor(bot.key, betaPhone), made.requestId).expect(404);
    await read(bot.key, made.requestId, `whatsapp:${alphaPhone}`).expect(404);
    expect(await t.prisma.booking.count({ where: { customerId: alpha.id } })).toBe(0);
  });

  it('accepts a quote of the same key and inputs only, not expired', async () => {
    const sender = newSender();
    const quote = async (key: string, quantity: string) =>
      (
        (
          await t
            .http()
            .get('/api/v1/cs/quote')
            .query({ originId: ids.served!, destinationId: ids.dest!, category, quantity })
            .set('Authorization', `Bearer ${key}`)
            .expect(200)
        ).body as CsQuoteDto
      ).quoteRef;
    const one = await quote(bot.key, '1');
    const two = await quote(bot.key, '2');
    const others = await quote(otherBot.key, '2');
    for (const ref of [one, others, `q_${'x'.repeat(32)}`]) {
      const res = await create(bot.key, body({ sender, quoteRef: ref })).expect(422);
      expect(code(res)).toBe('QUOTE_MISMATCH');
    }
    const otherRoute = await create(
      bot.key,
      body({ sender, quoteRef: two, originId: ids.twoOk! }),
    ).expect(422);
    expect(code(otherRoute)).toBe('QUOTE_MISMATCH');

    const made = (await create(bot.key, body({ sender, quoteRef: two })).expect(201))
      .body as CsBookingRequestCreated;
    expect(
      (await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id: made.requestId } }))
        .quoteRef,
    ).toBe(two);

    // An expired quote (kept as written: a quote is never changed, so a new one is made old).
    const row = await t.prisma.csQuote.findUniqueOrThrow({ where: { ref: two } });
    const old = `q_${randomUUID().replaceAll('-', '')}`;
    await t.prisma.csQuote.create({
      data: { ...row, ref: old, expiresAt: new Date(Date.now() - 1000), createdAt: undefined },
    });
    expect(code(await create(bot.key, body({ sender, quoteRef: old })).expect(422))).toBe(
      'QUOTE_EXPIRED',
    );
  });

  it('refuses unknown fields, places and dates', async () => {
    const sender = newSender();
    await create(bot.key, body({ sender, price: '1' })).expect(400);
    await create(bot.key, body({ sender, services: ['CUSTOMS'] })).expect(400);
    await create(bot.key, body({ sender, services: ['PICKUP', 'PICKUP'] })).expect(400);
    await create(bot.key, body({ sender, quantity: '0' })).expect(400);
    await create(bot.key, body({ sender, category: 'NOPE' })).expect(400);
    await create(bot.key, body({ sender, originId: randomUUID() })).expect(400);
    await create(bot.key, body({ sender, requestedDate: '2000-01-01' })).expect(400);
    await create(bot.key, body({ sender: { channel: 'telegram', id: 'abc' } })).expect(400);
    await create(bot.key, body({ sender: { channel: 'sms', id: '+249912345678' } })).expect(400);
    const telegram = (
      await create(bot.key, {
        ...body({ sender: { channel: 'telegram', id: String(randomInt(1e8, 9e8)) } }),
        contactPhone: uniquePhone(),
      }).expect(201)
    ).body as CsBookingRequestCreated;
    expect(telegram.status).toBe('pending');
  });
});
