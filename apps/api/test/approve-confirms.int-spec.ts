import { randomInt, randomUUID } from 'node:crypto';
import type {
  AlertsDto,
  ApiClientCreatedDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
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
import { uniquePhone } from './test-data.js';

/**
 * Plan 12 section 4: approving a bot request confirms its booking in the same transaction, behind
 * CS_APPROVE_CONFIRMS_ENABLED. On: the booking CONFIRMED, its shipment and its invoice made by the
 * approval; request.approved written before the shipment's own notices. A confirm refusal (the
 * customer's balance already over the credit limit) undoes the whole approval: the request stays
 * PENDING with no booking. Off: the booking stays a draft, and the alert
 * BOOKING_DRAFT_FROM_REQUEST lists it once past its wait. Approved invoices post entries, so the
 * users are LEDGER users and every customer is this run's own.
 */
describe('approving a bot request confirms its booking (plan 12 section 4)', () => {
  let on: TestApp;
  let off: TestApp;
  let pts = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', sales: '' };
  const userIds = { sales: '' };
  const ids: Record<string, string> = {};
  let category = '';
  const tag = `C${randomUUID().slice(0, 5).toUpperCase()}`;
  const route = { originId: '', destinationId: '', mode: 'ROAD', currency: 'USD' };

  const staff = (app: TestApp, cookie: string) => ({
    get: (path: string, query: object = {}) =>
      app.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      app.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });

  async function newCustomer(limit: string | null = null): Promise<string> {
    return (
      await on.prisma.customer.create({
        data: {
          number: `${tag}-${randomUUID().slice(0, 6)}`,
          name: `${tag} customer`,
          phone: uniquePhone(),
          kind: 'COMPANY',
          preferredCurrency: 'USD',
          createdById: userIds.sales,
          ...(limit === null ? {} : { creditLimit: limit, creditLimitCurrency: 'USD' }),
        },
      })
    ).id;
  }

  /** A bot request of 4 barrels at 10: 40. */
  async function request(): Promise<string> {
    return (
      (
        await on
          .http()
          .post('/api/v1/cs/booking-requests')
          .set('Authorization', `Bearer ${bot.key}`)
          .send({
            sender: { channel: 'whatsapp', id: uniquePhone() },
            originId: ids.origin,
            destinationId: ids.dest,
            services: [],
            senderName: 'Sender',
            consigneeName: 'Consignee',
            consigneePhone: '0912345678',
            handover: 'PICKUP',
            language: 'ar',
            idempotencyKey: `confirm-${randomUUID()}`,
            items: [{ category, quantity: '4' }],
          })
          .expect(201)
      ).body as CsBookingRequestCreated
    ).requestId;
  }

  /** Approves `id` for `customerId` through `app`, as sales staff. */
  async function approve(app: TestApp, id: string, customerId: string, status: number) {
    const sales = staff(app, cookies.sales);
    const price = (
      await sales
        .get(`/cs-booking-requests/${id}/price`, { ...route, category, quantity: '4' })
        .expect(200)
    ).body as CsApprovalPriceDto;
    const detail = (await sales.get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
    return sales
      .post(`/cs-booking-requests/${id}/approve`, {
        version: detail.version,
        paymentCurrency: 'USD',
        pricing: route,
        lines: [{ category, quantity: '4', pricingFingerprint: price.pricingFingerprint }],
        booking: { customerId, services: [] },
      })
      .expect(status);
  }

  beforeAll(async () => {
    on = await createTestApp({
      CS_APPROVE_CONFIRMS_ENABLED: true,
      BILLING_AUTO_APPROVE_ENABLED: true,
    });
    off = await createTestApp({
      CS_APPROVE_CONFIRMS_ENABLED: false,
      BILLING_AUTO_APPROVE_ENABLED: true,
    });
    pts = await branchId(on.prisma, 'PTS');
    const admin = await createUser(on.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    cookies.admin = await signIn(on, admin.email);
    const sales = await createUser(on.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    userIds.sales = sales.id;
    // One session serves both apps: they share the database.
    cookies.sales = await signIn(on, sales.email);
    bot = (
      await staff(on, cookies.admin)
        .post('/api-clients', {
          name: 'Approve confirms',
          branchIds: [pts],
          scopes: ['cs:booking_requests:create', 'cs:quote:read'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;
    // An approved webhook endpoint, so the request's notices are queued and their order shows.
    await on.prisma.csWebhookEndpoint.create({
      data: {
        apiClientId: bot.client.id,
        url: 'https://agent.example.com/api/v1/whatsapp/erp-events/nolon',
        audience: 'erp-agents:nolon',
        status: 'APPROVED',
        approvedKey: bot.client.id,
        createdById: sales.id,
        approvedById: admin.id,
        approvedAt: new Date(),
      },
    });

    const countryCode = `T${String.fromCharCode(65 + randomInt(26))}`;
    for (const [name, suffix] of [
      ['origin', 'ORG'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await on.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Confirm ${tag}${suffix}`,
            nameAr: 'مكان اختبار تأكيد الحجز',
            countryCode,
          },
        })
      ).id;
    }
    route.originId = ids.origin!;
    route.destinationId = ids.dest!;
    await on
      .http()
      .put(`/api/v1/master-data/locations/${ids.origin}/routing-branches`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.admin)
      .send({ branchIds: [pts] })
      .expect(200);
    category = `${tag}B`;
    await on.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'BARREL',
        defaultUnit: 'PER_BARREL',
      },
    });
    await on.prisma.rateCard.create({
      data: {
        branchId: pts,
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
        createdById: sales.id,
        approvedById: sales.id,
        approvedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await off?.close();
    await on?.close();
  });

  it('confirms the booking, makes its shipment and its invoice, with the switch on', async () => {
    const id = await request();
    const approved = (await approve(on, id, await newCustomer(), 201))
      .body as CsBookingRequestStaffDto;
    expect(approved.status).toBe('approved');
    const booking = await on.prisma.booking.findUniqueOrThrow({
      where: { id: approved.bookingId! },
      include: { shipment: true },
    });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.shipment).not.toBeNull();
    const invoices = await on.prisma.customerInvoice.findMany({
      where: { shipmentId: booking.shipment!.id },
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      status: 'APPROVED',
      autoRule: 'AGREED_PRICE',
      autoInitiatedById: userIds.sales,
    });
    expect(invoices[0]!.total.toString()).toBe('40');
    // request.approved is the request's first notice after its creation: shipment notices follow.
    const events = await on.prisma.csOutboxEvent.findMany({
      where: { requestId: id },
      orderBy: { sequence: 'asc' },
    });
    const approvedAt = events.findIndex((e) => e.type === 'request.approved');
    expect(approvedAt).toBeGreaterThanOrEqual(0);
    expect(events.slice(0, approvedAt).every((e) => e.type.startsWith('request.'))).toBe(true);
  });

  it('refuses the whole approval when the balance is already over the credit limit', async () => {
    const customerId = await newCustomer('50');
    // 40 of 50: approved with its invoice.
    await approve(on, await request(), customerId, 201);
    await on.prisma.customer.update({ where: { id: customerId }, data: { creditLimit: '30' } });

    const id = await request();
    const refused = await approve(on, id, customerId, 409);
    expect(refused.body).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });
    const row = await on.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.bookingId).toBeNull();
    expect(await on.prisma.booking.count({ where: { customerId } })).toBe(1);
    expect(
      await on.prisma.csOutboxEvent.count({ where: { requestId: id, type: 'request.approved' } }),
    ).toBe(0);
  });

  it('leaves the booking a draft with the switch off, and lists it once past its wait', async () => {
    const approved = (await approve(off, await request(), await newCustomer(), 201))
      .body as CsBookingRequestStaffDto;
    const bookingId = approved.bookingId!;
    const booking = await off.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { shipment: true },
    });
    expect(booking.status).toBe('DRAFT');
    expect(booking.shipment).toBeNull();

    const listed = async () =>
      ((await staff(off, cookies.sales).get('/alerts').expect(200)).body as AlertsDto).groups
        .find((g) => g.kind === 'BOOKING_DRAFT_FROM_REQUEST')
        ?.items.find((a) => a.refId === bookingId);
    // Made today: within the 1-day wait.
    expect(await listed()).toBeUndefined();
    await off.prisma.booking.update({
      where: { id: bookingId },
      data: { createdAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    expect(await listed()).toMatchObject({ number: booking.number, branchCode: 'PTS' });

    // Confirmed by hand: no longer listed.
    await staff(off, cookies.sales).post(`/bookings/${bookingId}/confirm`).expect(200);
    expect(await listed()).toBeUndefined();
  });
});
