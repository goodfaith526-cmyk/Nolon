import { randomInt, randomUUID } from 'node:crypto';
import type {
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
 * Plan 09e sections 2 and 3 (owner, 2026-11-04). An explicit other sender gets a customer of their
 * own (linked by phone, or new and unverified) and the booking is theirs; the chat owner's file is
 * never touched, and the owner's own phone is the owner. The receiver gets a customer only when
 * staff approve, behind CS_RECEIVER_CUSTOMER_ENABLED: by international phone (the request's, or
 * one staff type), never the sender's, never an inactive one. Switched off, nothing is made.
 */
describe('Other sender and receiver customers (plan 09e)', () => {
  let on: TestApp;
  let off: TestApp;
  let pts = '';
  let bot: ApiClientCreatedDto;
  let cookie = '';
  let createdById = '';
  const ids: Record<string, string> = {};
  let category = '';
  const tag = `S${randomUUID().slice(0, 5).toUpperCase()}`;

  const staff = (app: TestApp) => ({
    get: (path: string, query: object = {}) =>
      app.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object) =>
      app.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });

  /** A bot request from a WhatsApp sender whose number is `owner`. */
  async function request(app: TestApp, extra: object = {}, owner = uniquePhone()) {
    const made = (
      await app
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({
          sender: { channel: 'whatsapp', id: owner },
          contactPhone: owner,
          originId: ids.served,
          destinationId: ids.dest,
          category,
          quantity: '2',
          services: [],
          senderName: 'Chat owner',
          consigneeName: 'Receiver',
          consigneePhone: '0912345678',
          handover: 'BRANCH_DROP',
          language: 'ar',
          idempotencyKey: `sr-${randomUUID()}`,
          ...extra,
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    return made.requestId;
  }
  const row = (id: string) => on.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } });
  const pricing = { mode: 'ROAD', category, quantity: '2', currency: 'USD' };
  async function approve(app: TestApp, id: string, extra: object = {}, status = 201) {
    const detail = (await staff(app).get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
    const inputs = { ...pricing, category, originId: ids.served, destinationId: ids.dest };
    const price = (await staff(app).get(`/cs-booking-requests/${id}/price`, inputs).expect(200))
      .body as CsApprovalPriceDto;
    return staff(app)
      .post(`/cs-booking-requests/${id}/approve`, {
        version: detail.version,
        paymentCurrency: 'USD',
        pricing: inputs,
        pricingFingerprint: price.pricingFingerprint,
        booking: { services: [] },
        ...extra,
      })
      .expect(status);
  }
  const customer = (phone: string, isActive = true, name = `${tag} existing`) =>
    on.prisma.customer.create({
      data: {
        number: `${tag}-${randomInt(100_000, 999_999)}`,
        name,
        phone,
        kind: 'COMPANY',
        isActive,
        createdById,
      },
    });

  beforeAll(async () => {
    on = await createTestApp({
      CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED: true,
      CS_RECEIVER_CUSTOMER_ENABLED: true,
    });
    off = await createTestApp({
      CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED: false,
      CS_RECEIVER_CUSTOMER_ENABLED: false,
    });
    pts = await branchId(on.prisma, 'PTS');
    const admin = await createUser(on.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    const adminCookie = await signIn(on, admin.email);
    const sales = await createUser(on.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    createdById = sales.id;
    cookie = await signIn(on, sales.email);
    bot = (
      await on
        .http()
        .post('/api/v1/api-clients')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', adminCookie)
        .send({ name: 'Sender receiver', branchIds: [pts], scopes: ['cs:booking_requests:create'] })
        .expect(201)
    ).body as ApiClientCreatedDto;
    category = `${tag}C`;
    await on.prisma.priceCategory.create({
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
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await on.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Sender ${tag}${suffix}`,
            nameAr: 'مكان اختبار المرسل',
            countryCode,
          },
        })
      ).id;
    }
    await on
      .http()
      .put(`/api/v1/master-data/locations/${ids.served}/routing-branches`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', adminCookie)
      .send({ branchIds: [pts] })
      .expect(200);
    await on.prisma.rateCard.create({
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
    });
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
  });

  it('opens a file for a new other sender and books it; the chat owner gets none', async () => {
    const owner = uniquePhone();
    const phone = uniquePhone();
    const id = await request(on, { otherSender: { name: 'Huda Other', phone } }, owner);
    const saved = await row(id);
    expect(saved).toMatchObject({ otherSenderName: 'Huda Other', otherSenderPhone: phone });
    const made = await on.prisma.customer.findUniqueOrThrow({
      where: { id: saved.otherSenderCustomerId! },
    });
    expect(made).toMatchObject({
      name: 'Huda Other',
      phone,
      kind: 'INDIVIDUAL',
      phoneUnverified: true,
      isActive: true,
    });
    expect(await on.prisma.customer.count({ where: { phone: owner } })).toBe(0);

    const done = (await approve(on, id)).body as CsBookingRequestStaffDto;
    expect(done.otherSender).toEqual({ name: 'Huda Other', phone, customerId: made.id });
    const booking = await on.prisma.booking.findUniqueOrThrow({ where: { id: done.bookingId! } });
    expect(booking.customerId).toBe(made.id);
    // The receiver's local phone: no file, and approval goes on.
    expect(done.receiverAccount).toEqual({ outcome: 'PHONE_LOCAL', customerId: null });
  });

  it('links an existing customer by phone, unchanged; the owner phone is the owner', async () => {
    const phone = uniquePhone();
    const existing = await customer(phone);
    const id = await request(on, { otherSender: { name: 'Another name', phone } });
    expect((await row(id)).otherSenderCustomerId).toBe(existing.id);
    const after = await on.prisma.customer.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toMatchObject({ name: existing.name, kind: 'COMPANY', phoneUnverified: false });

    const owner = uniquePhone();
    const same = await request(on, { otherSender: { name: 'Me again', phone: owner } }, owner);
    expect(await row(same)).toMatchObject({
      otherSenderName: null,
      otherSenderPhone: null,
      otherSenderCustomerId: null,
    });
    expect(await on.prisma.customer.count({ where: { phone: owner } })).toBe(0);
  });

  it('switched off when saved, the other sender is linked on approval', async () => {
    const phone = uniquePhone();
    const id = await request(off, { otherSender: { name: 'Late Sender', phone } });
    expect(await row(id)).toMatchObject({ otherSenderPhone: phone, otherSenderCustomerId: null });
    expect(await on.prisma.customer.count({ where: { phone } })).toBe(0);
    const done = (await approve(off, id, { receiverPhone: uniquePhone() }))
      .body as CsBookingRequestStaffDto;
    const made = await on.prisma.customer.findFirstOrThrow({ where: { phone } });
    expect(made).toMatchObject({ kind: 'INDIVIDUAL', phoneUnverified: true });
    expect(done.otherSender?.customerId).toBe(made.id);
    // The receiver switch off: no receiver file even with a phone typed.
    expect(done.receiverAccount).toBeNull();
  });

  it('refuses an inactive other sender, or a customer chosen for one, booking nothing', async () => {
    const phone = uniquePhone();
    const inactive = await customer(phone, false);
    const id = await request(on, { otherSender: { name: 'Stopped', phone } });
    expect((await row(id)).otherSenderCustomerId).toBe(inactive.id);
    const refused = await approve(on, id, {}, 409);
    expect((refused.body as { code?: string }).code).toBe('OTHER_SENDER_INACTIVE');
    const chosen = await approve(
      on,
      id,
      { booking: { services: [], customerId: inactive.id } },
      400,
    );
    expect((chosen.body as { code?: string }).code).toBe('OTHER_SENDER_CUSTOMER');
    expect(await row(id)).toMatchObject({ status: 'PENDING', bookingId: null });
    await approve(on, id, { newCustomerFromRequest: true }, 400);
  });

  it('opens the receiver a file on approval, then links the same phone again', async () => {
    const receiver = uniquePhone();
    const first = await request(on, {
      otherSender: { name: 'Sender A', phone: uniquePhone() },
      consigneeName: 'Receiver One',
      consigneePhone: receiver.replace('+', '00'),
    });
    // Nothing for the receiver before approval.
    expect(await on.prisma.customer.count({ where: { phone: receiver } })).toBe(0);
    const done = (await approve(on, first)).body as CsBookingRequestStaffDto;
    const made = await on.prisma.customer.findFirstOrThrow({ where: { phone: receiver } });
    expect(made).toMatchObject({ name: 'Receiver One', kind: 'INDIVIDUAL', phoneUnverified: true });
    expect(done.receiverAccount).toEqual({ outcome: 'CREATED', customerId: made.id });

    const second = await request(on, {
      otherSender: { name: 'Sender B', phone: uniquePhone() },
      consigneeName: 'Another spelling',
      consigneePhone: receiver,
    });
    const again = (await approve(on, second)).body as CsBookingRequestStaffDto;
    expect(again.receiverAccount).toEqual({ outcome: 'LINKED', customerId: made.id });
    expect((await on.prisma.customer.findUniqueOrThrow({ where: { id: made.id } })).name).toBe(
      'Receiver One',
    );
  });

  it('uses the phone staff type for a local one; never the sender, never an inactive file', async () => {
    const typed = uniquePhone();
    const local = await request(on, { otherSender: { name: 'Sender C', phone: uniquePhone() } });
    const done = (await approve(on, local, { receiverPhone: typed }))
      .body as CsBookingRequestStaffDto;
    const made = await on.prisma.customer.findFirstOrThrow({ where: { phone: typed } });
    expect(done.receiverAccount).toEqual({ outcome: 'CREATED', customerId: made.id });

    const senderPhone = uniquePhone();
    const self = await request(on, {
      otherSender: { name: 'Sender D', phone: senderPhone },
      consigneePhone: senderPhone,
    });
    expect(((await approve(on, self)).body as CsBookingRequestStaffDto).receiverAccount).toEqual({
      outcome: 'SAME_AS_SENDER',
      customerId: null,
    });

    const stopped = uniquePhone();
    await customer(stopped, false);
    const inactive = await request(on, {
      otherSender: { name: 'Sender E', phone: uniquePhone() },
      consigneePhone: stopped,
    });
    expect(
      ((await approve(on, inactive)).body as CsBookingRequestStaffDto).receiverAccount,
    ).toEqual({ outcome: 'CUSTOMER_INACTIVE', customerId: null });
    await approve(on, await request(on), { receiverPhone: '0912' }, 400);
  });
});
