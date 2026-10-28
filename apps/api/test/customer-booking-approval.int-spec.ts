import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsBookingRequestStaffDto,
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
import { uniquePhone, waitForLockWaiter } from './test-data.js';

/**
 * Approval of a bot's booking request (plan 04a, R3-ج2): the booking is made with the ordinary
 * create checks and the request approved in one transaction, after the price is computed again
 * under the card's lock and matched to the fingerprint staff saw. The bot then reads the booking's
 * number. Negative cases: a missing permission, another branch, a stale version, a decided request
 * or one awaiting routing, a customer of another branch or not the request's own, a price for
 * another route, a changed or cancelled price (also while the approval waits on the card), and an
 * inactive payment currency; none of them makes a booking.
 */
describe('Customer Service booking request approval (R3c2)', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', salesPts: '', salesJed: '', ops: '' };
  const ids: Record<string, string> = {};
  let category = '';
  let cardId = '';
  let createdById = '';
  let n = 0;
  const tag = `A${randomUUID().slice(0, 5).toUpperCase()}`;

  const staff = (cookie: string) => ({
    get: (path: string, query: object = {}) =>
      t.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });

  async function request(origin: string) {
    const from = { channel: 'whatsapp', id: uniquePhone() };
    const made = (
      await t
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({
          sender: from,
          originId: origin,
          destinationId: ids.dest,
          category,
          quantity: '2',
          services: [],
          senderName: 'Sender',
          consigneeName: 'Consignee',
          consigneePhone: '0912345678',
          handover: 'PICKUP',
          language: 'ar',
          idempotencyKey: `approve-${randomUUID()}`,
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    return { id: made.requestId, header: `whatsapp:${from.id}` };
  }
  const detail = async (cookie: string, id: string) =>
    (await staff(cookie).get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
  const pricing = (origin: string, extra: object = {}) => ({
    originId: origin,
    destinationId: ids.dest!,
    mode: 'ROAD',
    category,
    quantity: '2',
    currency: 'USD',
    ...extra,
  });
  const priceOf = async (cookie: string, id: string, inputs: object) =>
    (await staff(cookie).get(`/cs-booking-requests/${id}/price`, inputs).expect(200))
      .body as CsApprovalPriceDto;
  const booking = (origin: string, customerId: string, extra: object = {}) => ({
    customerId,
    originLocationId: origin,
    destinationLocationId: ids.dest!,
    mode: 'ROAD',
    cargoType: 'GENERAL',
    services: [],
    items: [],
    ...extra,
  });
  const approve = (cookie: string, id: string, body: object) =>
    staff(cookie).post(`/cs-booking-requests/${id}/approve`, body);
  const bookingsOf = (customerId: string) => t.prisma.booking.count({ where: { customerId } });
  const customer = async (branch: string) =>
    (
      await t.prisma.customer.create({
        data: {
          number: `${tag}-${++n}`,
          branchId: branch,
          name: `${tag} customer ${n}`,
          phone: uniquePhone(),
          kind: 'COMPANY',
          createdById,
        },
      })
    ).id;

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const user = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      createUser(t.prisma, roles, branches, LEDGER_PREFIX);
    const admin = await user(['ADMINISTRATOR'], []);
    cookies.admin = await signIn(t, admin.email);
    const salesPts = await user(['SALES'], ['PTS']);
    createdById = salesPts.id;
    cookies.salesPts = await signIn(t, salesPts.email);
    cookies.salesJed = await signIn(t, (await user(['SALES'], ['JED'])).email);
    cookies.ops = await signIn(t, (await user(['OPERATIONS'], ['PTS'])).email);
    bot = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Approval',
          branchIds: [pts, jed],
          scopes: ['cs:booking_requests:create'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;

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
    const countryCode = `T${String.fromCharCode(65 + randomInt(26))}`;
    for (const [name, suffix] of [
      ['served', 'SRV'],
      ['two', 'TWO'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Approval ${tag}${suffix}`,
            nameAr: 'مكان اختبار الموافقة',
            countryCode,
          },
        })
      ).id;
    }
    for (const [place, branches] of [
      [ids.served, [pts]],
      [ids.two, [pts, jed]],
    ] as const) {
      await t
        .http()
        .put(`/api/v1/master-data/locations/${place}/routing-branches`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.admin)
        .send({ branchIds: branches })
        .expect(200);
    }
    cardId = (
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
          createdById,
          approvedById: createdById,
          approvedAt: new Date(),
        },
      })
    ).id;
    ids.customerPts = await customer(pts);
    ids.customerJed = await customer(jed);
  });

  afterAll(async () => {
    await t.close();
  });

  it('prices an approval for those who may approve in the request’s branch', async () => {
    const made = await request(ids.served!);
    const price = await priceOf(cookies.salesPts, made.id, pricing(ids.served!));
    expect(price).toMatchObject({
      state: 'priced',
      reason: null,
      rateCardId: cardId,
      currency: 'USD',
      unit: 'PER_SHIPMENT',
      unitPrice: '40',
      total: '80.00',
    });
    expect(price.pricingFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // 2 and 2.0 are the same input; another quantity is another fingerprint.
    expect(
      (await priceOf(cookies.salesPts, made.id, pricing(ids.served!, { quantity: '2.0' })))
        .pricingFingerprint,
    ).toBe(price.pricingFingerprint);
    const three = await priceOf(cookies.salesPts, made.id, pricing(ids.served!, { quantity: '3' }));
    expect(three.total).toBe('120.00');
    expect(three.pricingFingerprint).not.toBe(price.pricingFingerprint);
    // No approved card for this route: no price, and no fingerprint.
    expect(await priceOf(cookies.salesPts, made.id, pricing(ids.two!))).toMatchObject({
      state: 'none',
      reason: 'NO_RATE',
      pricingFingerprint: null,
    });

    await staff(cookies.ops)
      .get(`/cs-booking-requests/${made.id}/price`, pricing(ids.served!))
      .expect(403);
    await staff(cookies.salesJed)
      .get(`/cs-booking-requests/${made.id}/price`, pricing(ids.served!))
      .expect(404);
    expect((await detail(cookies.ops, made.id)).actions.canApprove).toBe(false);
    expect((await detail(cookies.salesPts, made.id)).actions.canApprove).toBe(true);
  });

  it('makes the booking and approves the request together, once; the bot reads its number', async () => {
    const made = await request(ids.served!);
    const { version } = await detail(cookies.salesPts, made.id);
    const price = await priceOf(cookies.salesPts, made.id, pricing(ids.served!));
    const body = {
      version,
      paymentCurrency: 'USD',
      pricing: pricing(ids.served!),
      pricingFingerprint: price.pricingFingerprint,
      booking: booking(ids.served!, ids.customerPts!),
    };
    const before = await bookingsOf(ids.customerPts!);

    await approve(cookies.ops, made.id, body).expect(403);
    await approve(cookies.salesJed, made.id, body).expect(404);
    await approve(cookies.salesPts, made.id, { ...body, version: version + 1 }).expect(409);
    expect(await bookingsOf(ids.customerPts!)).toBe(before);

    const done = (await approve(cookies.salesPts, made.id, body).expect(201))
      .body as CsBookingRequestStaffDto;
    expect(done).toMatchObject({
      status: 'approved',
      paymentCurrency: 'USD',
      version: version + 1,
      actions: { canRoute: false, canReject: false, canApprove: false },
    });
    expect(done.bookingNumber).not.toBeNull();
    const made1 = await t.prisma.booking.findUniqueOrThrow({ where: { id: done.bookingId! } });
    expect(made1).toMatchObject({
      branchId: pts,
      customerId: ids.customerPts,
      status: 'DRAFT',
      originLocationId: ids.served,
    });
    expect(await bookingsOf(ids.customerPts!)).toBe(before + 1);

    // Decided: neither another approval nor a rejection.
    await approve(cookies.salesPts, made.id, { ...body, version: version + 1 }).expect(409);
    await staff(cookies.salesPts)
      .post(`/cs-booking-requests/${made.id}/reject`, {
        version: version + 1,
        reasonCode: 'DUPLICATE',
      })
      .expect(409);
    expect(await bookingsOf(ids.customerPts!)).toBe(before + 1);

    const seen = (
      await t
        .http()
        .get(`/api/v1/cs/booking-requests/${made.id}`)
        .set('Authorization', `Bearer ${bot.key}`)
        .set('X-Cs-Sender', made.header)
        .expect(200)
    ).body as CsBookingRequestDto;
    expect(seen).toMatchObject({
      status: 'approved',
      bookingNumber: made1.number,
      customerReason: null,
    });
  });

  it('refuses an approval that does not fit the request, and makes no booking', async () => {
    const made = await request(ids.served!);
    const { version } = await detail(cookies.salesPts, made.id);
    const price = await priceOf(cookies.salesPts, made.id, pricing(ids.served!));
    const body = {
      version,
      paymentCurrency: 'USD',
      pricing: pricing(ids.served!),
      pricingFingerprint: price.pricingFingerprint,
      booking: booking(ids.served!, ids.customerPts!),
    };
    const ptsBefore = await bookingsOf(ids.customerPts!);
    const jedBefore = await bookingsOf(ids.customerJed!);
    const refused = async (cookie: string, change: object, status: number, code?: string) => {
      const res = await approve(cookie, made.id, { ...body, ...change }).expect(status);
      if (code) expect((res.body as { code?: string }).code).toBe(code);
    };

    // The price is for another route than the booking.
    await refused(
      cookies.salesPts,
      { booking: booking(ids.two!, ids.customerPts!) },
      400,
      'PRICING_MISMATCH',
    );
    // A customer of another branch: not one of PTS Sales', and not the request's branch.
    await refused(cookies.salesPts, { booking: booking(ids.served!, ids.customerJed!) }, 404);
    await refused(
      cookies.admin,
      { booking: booking(ids.served!, ids.customerJed!) },
      400,
      'BRANCH_MISMATCH',
    );
    // A request of a customer is booked for that customer only.
    const owner = await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id: made.id } });
    await t.prisma.csBookingRequest.update({
      where: { id: made.id },
      data: {
        customerId: await customer(pts),
        grantId: 'g_test',
        senderChannel: null,
        senderId: null,
      },
    });
    await refused(cookies.salesPts, {}, 400, 'CUSTOMER_MISMATCH');
    await t.prisma.csBookingRequest.update({
      where: { id: made.id },
      data: {
        customerId: null,
        grantId: null,
        senderChannel: owner.senderChannel,
        senderId: owner.senderId,
      },
    });
    // A price staff did not see, or none when there is one.
    await refused(cookies.salesPts, { pricingFingerprint: 'f'.repeat(64) }, 409, 'PRICE_STALE');
    await refused(cookies.salesPts, { pricingFingerprint: null }, 409, 'PRICE_STALE');
    await refused(
      cookies.salesPts,
      { pricing: pricing(ids.served!, { quantity: '3' }) },
      409,
      'PRICE_STALE',
    );
    // An unknown payment currency, a malformed body.
    await refused(cookies.salesPts, { paymentCurrency: 'XQZ' }, 400);
    await refused(cookies.salesPts, { pricingFingerprint: 'nope' }, 400);
    await refused(cookies.salesPts, { extra: true }, 400);

    expect(await bookingsOf(ids.customerPts!)).toBe(ptsBefore);
    expect(await bookingsOf(ids.customerJed!)).toBe(jedBefore);
    expect((await detail(cookies.salesPts, made.id)).status).toBe('pending');

    // One awaiting routing is routed first.
    const awaiting = await request(ids.two!);
    const v = (await detail(cookies.salesPts, awaiting.id)).version;
    await approve(cookies.salesPts, awaiting.id, {
      ...body,
      version: v,
      pricing: pricing(ids.two!),
      pricingFingerprint: null,
      booking: booking(ids.two!, ids.customerPts!),
    }).expect(409);
    // Once routed, with no approved price for its route, it is approved with no fingerprint.
    await staff(cookies.salesPts)
      .post(`/cs-booking-requests/${awaiting.id}/route`, { version: v, branchId: pts })
      .expect(201);
    await approve(cookies.salesPts, awaiting.id, {
      ...body,
      version: v + 1,
      pricing: pricing(ids.two!),
      pricingFingerprint: null,
      booking: booking(ids.two!, ids.customerPts!),
    }).expect(201);
    expect(await bookingsOf(ids.customerPts!)).toBe(ptsBefore + 1);
  });

  it('refuses a price cancelled after staff saw it, also while approval waits on the card', async () => {
    const made = await request(ids.served!);
    const { version } = await detail(cookies.salesPts, made.id);
    const price = await priceOf(cookies.salesPts, made.id, pricing(ids.served!));
    const body = {
      version,
      paymentCurrency: 'USD',
      pricing: pricing(ids.served!),
      pricingFingerprint: price.pricingFingerprint,
      booking: booking(ids.served!, ids.customerPts!),
    };
    const before = await bookingsOf(ids.customerPts!);
    try {
      // Cancelled before: the price is gone.
      await t.prisma.rateCard.update({ where: { id: cardId }, data: { status: 'CANCELLED' } });
      const gone = await approve(cookies.salesPts, made.id, body).expect(409);
      expect(gone.body).toMatchObject({ code: 'PRICE_STALE', price: { state: 'none' } });
      await t.prisma.rateCard.update({ where: { id: cardId }, data: { status: 'APPROVED' } });

      // Cancelled while the approval waits on the card's lock: it sees the cancellation.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const cancelling = t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "rate_cards" WHERE "id" = ${cardId}::uuid FOR UPDATE`;
        await tx.rateCard.update({ where: { id: cardId }, data: { status: 'CANCELLED' } });
        await held;
      });
      const approving = Promise.resolve(approve(cookies.salesPts, made.id, body));
      await waitForLockWaiter(t.prisma);
      release();
      await cancelling;
      const waited = await approving;
      expect(waited.status).toBe(409);
      expect((waited.body as { code?: string }).code).toBe('PRICE_STALE');
    } finally {
      await t.prisma.rateCard.update({ where: { id: cardId }, data: { status: 'APPROVED' } });
    }
    expect(await bookingsOf(ids.customerPts!)).toBe(before);
    expect((await detail(cookies.salesPts, made.id)).status).toBe('pending');
  });
});
