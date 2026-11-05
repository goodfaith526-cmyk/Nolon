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
import { nextSequenceValue } from '../src/common/numbering.js';
import { lockCustomerKeys } from '../src/customers/customers.service.js';
import { uniquePhone, waitForLockWaiter } from './test-data.js';

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
  let tokenKey: ApiClientCreatedDto;
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
    patch: (path: string, body: object) =>
      app.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
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
    tokenKey = (
      await on
        .http()
        .post('/api/v1/api-clients')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', adminCookie)
        .send({ name: 'Sender tokens', branchIds: [pts], scopes: ['cs:customer_tokens:issue'] })
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

  it('opens a file for a new other sender and books it; the chat owner keeps their own', async () => {
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
    // The chat owner has their own file (registered on arrival), not the other sender's details.
    const ownFile = await on.prisma.customer.findFirstOrThrow({ where: { phone: owner } });
    expect(ownFile.name).toBe('Chat owner');
    expect(saved.instantCustomerId).toBe(ownFile.id);

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
    // One file for the owner, never a second one for the same phone.
    expect(await on.prisma.customer.count({ where: { phone: owner } })).toBe(1);
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

  const tokenFor = async (phone: string) =>
    (
      (
        await on
          .http()
          .post('/api/v1/cs/customer-tokens')
          .set('Authorization', `Bearer ${tokenKey.key}`)
          .send({ phone })
          .expect(200)
      ).body as { kind: string }
    ).kind;

  it('grants no customer token on an unverified phone until staff confirm it (F191-1)', async () => {
    const senderPhone = uniquePhone();
    const receiverPhone = uniquePhone();
    const id = await request(on, {
      otherSender: { name: 'Token Sender', phone: senderPhone },
      consigneePhone: receiverPhone,
    });
    await approve(on, id);
    const sender = await on.prisma.customer.findFirstOrThrow({ where: { phone: senderPhone } });
    const receiver = await on.prisma.customer.findFirstOrThrow({ where: { phone: receiverPhone } });
    expect([sender.phoneUnverified, receiver.phoneUnverified]).toEqual([true, true]);
    expect(await tokenFor(senderPhone)).toBe('none');
    expect(await tokenFor(receiverPhone)).toBe('none');

    // Staff confirm the sender's phone: now it grants a token; the receiver's still does not.
    const confirmed = (
      await staff(on).patch(`/customers/${sender.id}`, { phoneVerified: true }).expect(200)
    ).body as { phoneUnverified: boolean };
    expect(confirmed.phoneUnverified).toBe(false);
    expect(await tokenFor(senderPhone)).toBe('token');
    expect(await tokenFor(receiverPhone)).toBe('none');
  });

  it('links no one when several customers hold the phone (F191-2)', async () => {
    const shared = uniquePhone();
    await customer(shared);
    await customer(shared);
    const id = await request(on, { otherSender: { name: 'Twice', phone: shared } });
    expect((await row(id)).otherSenderCustomerId).toBeNull();
    const refused = await approve(on, id, {}, 409);
    expect((refused.body as { code?: string }).code).toBe('OTHER_SENDER_AMBIGUOUS');
    expect(await row(id)).toMatchObject({ status: 'PENDING', bookingId: null });

    // Active and inactive together are ambiguous too, for the sender and for the receiver.
    const mixed = uniquePhone();
    await customer(mixed);
    await customer(mixed, false);
    const late = await request(off, { otherSender: { name: 'Mixed', phone: mixed } });
    expect(((await approve(on, late, {}, 409)).body as { code?: string }).code).toBe(
      'OTHER_SENDER_AMBIGUOUS',
    );
    const receiving = await request(on, {
      otherSender: { name: 'Sender F', phone: uniquePhone() },
      consigneePhone: mixed,
    });
    expect(
      ((await approve(on, receiving)).body as CsBookingRequestStaffDto).receiverAccount,
    ).toEqual({ outcome: 'PHONE_AMBIGUOUS', customerId: null });
  });

  it('links the sender while a customer edit holds its row, without a deadlock (F191-3)', async () => {
    const phone = uniquePhone();
    const existing = await customer(phone);
    // Saved with the identity switch off: approval links the sender late.
    const id = await request(off, { otherSender: { name: 'Edited', phone } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    // A customer edit's order: the row (FOR NO KEY UPDATE), then the customer-key lock.
    const editing = on.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${existing.id}::uuid FOR NO KEY UPDATE`;
      await held;
      await lockCustomerKeys(tx);
      await tx.customer.update({ where: { id: existing.id }, data: { city: 'Edited' } });
    });
    const approving = Promise.resolve(approve(on, id));
    await waitForLockWaiter(on.prisma);
    release();
    await editing;
    const done = (await approving).body as CsBookingRequestStaffDto;
    expect(done.otherSender?.customerId).toBe(existing.id);
  });

  it('takes its BK number after the customer-key lock, as staff booking does (F195-1)', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding: () => void = () => undefined;
    const holdingNow = new Promise<void>((resolve) => (holding = resolve));
    // Staff booking for a new customer: the customer-key lock, then the BOOKING counter.
    const staffSide = on.prisma.$transaction(
      async (tx) => {
        await lockCustomerKeys(tx);
        holding();
        await held;
        await nextSequenceValue(tx, 'BOOKING');
      },
      { timeout: 20_000 },
    );
    await holdingNow;
    // A new sender: the request waits for the customer-key lock holding no BOOKING counter.
    const arriving = request(on, {}, uniquePhone());
    await waitForLockWaiter(on.prisma);
    release();
    await staffSide;
    const saved = await row(await arriving);
    expect(saved.instantAccount).toBe('CREATED');
    expect(saved.reference).toMatch(/^BK\d{5,}$/);
  });

  it('registers a sender with no profile when the request arrives, once (owner 2026-11-04)', async () => {
    const owner = uniquePhone();
    const first = await request(on, {}, owner);
    const saved = await row(first);
    const made = await on.prisma.customer.findUniqueOrThrow({
      where: { id: saved.instantCustomerId! },
    });
    expect(saved.instantAccount).toBe('CREATED');
    expect(made).toMatchObject({
      name: 'Chat owner',
      phone: owner,
      kind: 'INDIVIDUAL',
      phoneUnverified: true,
    });
    // The same sender again: the same customer, no second file.
    const second = await request(on, {}, owner);
    expect(await row(second)).toMatchObject({
      instantAccount: 'REUSED',
      instantCustomerId: made.id,
    });
    expect(await on.prisma.customer.count({ where: { phone: owner } })).toBe(1);
    // Approval books that customer without staff choosing one, and makes no other.
    const done = (await approve(on, second)).body as CsBookingRequestStaffDto;
    const booking = await on.prisma.booking.findUniqueOrThrow({ where: { id: done.bookingId! } });
    expect(booking.customerId).toBe(made.id);
    await approve(on, first, { newCustomerFromRequest: true }, 400);

    // No international phone: a file with the name and no phone; the switch off: none.
    const named = await request(on, {
      sender: { channel: 'telegram', id: String(randomInt(100_000_000, 999_999_999)) },
      contactPhone: undefined,
      senderName: 'Local Sender',
    });
    const localRow = await row(named);
    expect(localRow.instantAccount).toBe('CREATED');
    expect(
      await on.prisma.customer.findUniqueOrThrow({ where: { id: localRow.instantCustomerId! } }),
    ).toMatchObject({ name: 'Local Sender', phone: null, phoneUnverified: false });
    const quiet = await request(off, {});
    expect(await row(quiet)).toMatchObject({ instantAccount: null, instantCustomerId: null });
  });

  /** A request in the bot's own words (the names form), as the website and WhatsApp bots send. */
  async function byNames(app: TestApp, extra: object) {
    const place = (suffix: string) => ({
      ar: `Sender ${tag}${suffix}`,
      en: `Sender ${tag}${suffix}`,
    });
    const made = (
      await app
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({
          idempotencyKey: randomUUID().replaceAll('-', ''),
          channel: 'whatsapp',
          origin: place('SRV'),
          destination: place('DES'),
          kind: { ar: category, en: category },
          quantity: 1,
          senderName: 'Names Sender',
          receiverName: 'Receiver',
          receiverPhone: '0912345678',
          handover: 'dropoff',
          ...extra,
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    return row(made.requestId);
  }

  it('reads a WhatsApp number in digits as international; leaves a local one unresolved (F191-4)', async () => {
    const known = uniquePhone();
    const existing = await customer(known);
    const linked = await byNames(on, { senderPhone: known.slice(1) });
    expect(linked).toMatchObject({ instantAccount: 'REUSED', instantCustomerId: existing.id });

    const fresh = uniquePhone();
    const made = await byNames(on, { senderPhone: fresh.slice(1) });
    expect(made.instantAccount).toBe('CREATED');
    expect(
      await on.prisma.customer.findUniqueOrThrow({ where: { id: made.instantCustomerId! } }),
    ).toMatchObject({ phone: fresh, phoneUnverified: true });

    // A local Telegram number: no country guessed, a file with no phone, the same one next time.
    const local = `09${randomInt(10_000_000, 99_999_999)}`;
    const first = await byNames(on, { channel: 'telegram', senderPhone: local });
    expect(first.instantAccount).toBe('CREATED');
    expect(
      await on.prisma.customer.findUniqueOrThrow({ where: { id: first.instantCustomerId! } }),
    ).toMatchObject({ phone: null });
    const again = await byNames(on, { channel: 'telegram', senderPhone: local });
    expect(again).toMatchObject({
      instantAccount: 'REUSED',
      instantCustomerId: first.instantCustomerId,
    });
  });
  it('names the sender and receiver with their phones on the booking, reused next time (owner 2026-11-05)', async () => {
    const owner = uniquePhone();
    const receiverPhone = uniquePhone();
    const partiesOf = async (requestId: string) => {
      const done = (await approve(on, requestId)).body as CsBookingRequestStaffDto;
      return on.prisma.booking.findUniqueOrThrow({
        where: { id: done.bookingId! },
        include: { shipper: true, consignee: true },
      });
    };
    const first = await partiesOf(
      await request(on, { consigneeName: 'Named Receiver', consigneePhone: receiverPhone }, owner),
    );
    expect(first.shipper).toMatchObject({
      customerId: first.customerId,
      name: 'Chat owner',
      phone: owner,
    });
    expect(first.consignee).toMatchObject({
      customerId: first.customerId,
      name: 'Named Receiver',
      phone: receiverPhone,
    });
    // The same people again: the same parties, no copies.
    const second = await partiesOf(
      await request(on, { consigneeName: 'Named Receiver', consigneePhone: receiverPhone }, owner),
    );
    expect(second.customerId).toBe(first.customerId);
    expect(second.shipperId).toBe(first.shipperId);
    expect(second.consigneeId).toBe(first.consigneeId);
    expect(await on.prisma.party.count({ where: { customerId: first.customerId } })).toBe(2);
  });

  it("adds a phone a later request brings to the sender's file that has none (owner 2026-11-05)", async () => {
    const chat = String(randomInt(100_000_000, 999_999_999));
    const sender = { channel: 'telegram', id: chat };
    const first = await row(
      await request(on, { sender, contactPhone: undefined, senderName: 'No Phone Yet' }),
    );
    expect(
      await on.prisma.customer.findUniqueOrThrow({ where: { id: first.instantCustomerId! } }),
    ).toMatchObject({ phone: null });
    // A later request of the same chat shares a phone: the file takes it, unverified.
    const phone = uniquePhone();
    const later = await row(await request(on, { sender, contactPhone: phone }));
    expect(later.instantCustomerId).toBe(first.instantCustomerId);
    expect(
      await on.prisma.customer.findUniqueOrThrow({ where: { id: first.instantCustomerId! } }),
    ).toMatchObject({ phone, phoneUnverified: true });
    // A phone already set is never replaced, and another customer's phone is never taken.
    const taken = (await customer(uniquePhone())).phone!;
    await request(on, { sender, contactPhone: taken });
    expect(
      await on.prisma.customer.findUniqueOrThrow({ where: { id: first.instantCustomerId! } }),
    ).toMatchObject({ phone });
  });
  it('fills the phone while a customer edit holds the row, without a deadlock (F200-1)', async () => {
    const sender = { channel: 'telegram', id: String(randomInt(100_000_000, 999_999_999)) };
    const first = await row(
      await request(on, { sender, contactPhone: undefined, senderName: 'Edit Race' }),
    );
    const customerId = first.instantCustomerId!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    // A customer edit's order: the row (FOR NO KEY UPDATE), then the customer-key lock.
    const editing = on.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${customerId}::uuid FOR NO KEY UPDATE`;
      await held;
      await lockCustomerKeys(tx);
      await tx.customer.update({ where: { id: customerId }, data: { city: 'Edited' } });
    });
    const phone = uniquePhone();
    const arriving = request(on, { sender, contactPhone: phone });
    await waitForLockWaiter(on.prisma);
    release();
    await editing;
    expect((await row(await arriving)).instantCustomerId).toBe(customerId);
    expect(await on.prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject(
      { phone, phoneUnverified: true, city: 'Edited' },
    );
  });

  it("makes an approval's parties while another approval holds the customer, without a deadlock (F200-2)", async () => {
    const owner = uniquePhone();
    const firstId = await request(on, {}, owner);
    const customerId = (await row(firstId)).instantCustomerId!;
    const secondId = await request(on, {}, owner);
    // Another approval of the same customer, holding its row FOR SHARE as approvals do.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let sharing: () => void = () => undefined;
    const shared = new Promise<void>((resolve) => (sharing = resolve));
    const other = on.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${customerId}::uuid FOR SHARE`;
      sharing();
      await held;
    });
    await shared;
    try {
      // Made while the share is held: the parties never wait to upgrade the row lock.
      const done = (await approve(on, firstId)).body as CsBookingRequestStaffDto;
      const booking = await on.prisma.booking.findUniqueOrThrow({ where: { id: done.bookingId! } });
      expect(booking.shipperId).not.toBeNull();
      expect(booking.consigneeId).not.toBeNull();
    } finally {
      release();
      await other;
    }
    // Two approvals of one customer at once: both pass, and the parties are made once.
    await Promise.all([approve(on, secondId), approve(on, await request(on, {}, owner))]);
    expect(await on.prisma.party.count({ where: { customerId } })).toBe(2);
  });
});
