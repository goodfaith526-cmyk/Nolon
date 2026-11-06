import { randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  BranchSupportPhoneDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  BookingDto,
  CsBookingRequestStaffDto,
  CsCatalogDto,
  CsDropOffChoiceDto,
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
 * Plan 09 section 11 (N-C8) and amendment 4: the drop-off point named on approval, read by the bot
 * from the point's current details, corrected by staff, and each branch's customer service number
 * in the catalog. Negative cases: no point while pending or rejected, a point of another branch,
 * one not taking shipments or turned off, two points and none named, a stale or unpermitted
 * correction, a non-https map link and a malformed phone.
 * Plan 13 section 1: the booking carries the window (copied on approval, updated by the
 * correction, named on a staff booking), the dropdown names the outlet, and the print's map QR.
 */
describe('Customer Service drop-off points (plan 09 section 11)', () => {
  let t: TestApp;
  let krt = '';
  let pts = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', sales: '', ops: '' };
  const ids: Record<string, string> = {};
  let category = '';
  let createdById = '';
  const tag = `D${randomUUID().slice(0, 5).toUpperCase()}`;

  const staff = (cookie: string) => ({
    get: (path: string, query: object = {}) =>
      t.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    patch: (path: string, body: object) =>
      t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    put: (path: string, body: object) =>
      t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const senders = new Map<string, string>();
  async function request(): Promise<string> {
    const sender = uniquePhone();
    const made = (
      await t
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({
          sender: { channel: 'whatsapp', id: sender },
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
          idempotencyKey: `drop-off-${randomUUID()}`,
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    senders.set(made.requestId, `whatsapp:${sender}`);
    return made.requestId;
  }
  const botRead = async (id: string) =>
    (
      await t
        .http()
        .get(`/api/v1/cs/booking-requests/${id}`)
        .set('Authorization', `Bearer ${bot.key}`)
        .set('X-Cs-Sender', senders.get(id)!)
        .expect(200)
    ).body as CsBookingRequestDto;
  const detail = async (id: string) =>
    (await staff(cookies.sales).get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
  const pricing = { mode: 'ROAD', currency: 'USD', quantity: '2' };
  async function approve(id: string, dropOff: { dropOffId?: string } = {}, status = 201) {
    const inputs = { ...pricing, originId: ids.origin!, destinationId: ids.dest!, category };
    const price = (
      await staff(cookies.sales).get(`/cs-booking-requests/${id}/price`, inputs).expect(200)
    ).body as CsApprovalPriceDto;
    return staff(cookies.sales)
      .post(`/cs-booking-requests/${id}/approve`, {
        version: (await detail(id)).version,
        paymentCurrency: 'USD',
        pricing: inputs,
        pricingFingerprint: price.pricingFingerprint,
        booking: { customerId: ids.customer, services: [] },
        ...dropOff,
      })
      .expect(status);
  }
  let seq = 0;
  async function point(branch: string, data: object = {}): Promise<string> {
    seq += 1;
    return (
      await t.prisma.warehouse.create({
        data: {
          branchId: branch,
          code: `${tag}-${seq}`,
          nameAr: `نقطة ${seq}`,
          nameEn: `Point ${seq}`,
          acceptsDropOff: true,
          ...data,
        },
      })
    ).id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    krt = await branchId(t.prisma, 'KRT');
    pts = await branchId(t.prisma, 'PTS');
    // Only this file makes KRT drop-off points: earlier runs' are taken out of the way.
    await t.prisma.warehouse.updateMany({
      where: { branchId: krt, acceptsDropOff: true },
      data: { acceptsDropOff: false },
    });
    const user = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      createUser(t.prisma, roles, branches, LEDGER_PREFIX);
    cookies.admin = await signIn(t, (await user(['ADMINISTRATOR'], [])).email);
    const sales = await user(['SALES'], ['KRT']);
    createdById = sales.id;
    cookies.sales = await signIn(t, sales.email);
    cookies.ops = await signIn(t, (await user(['OPERATIONS'], ['KRT'])).email);
    bot = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Drop-off',
          branchIds: [krt],
          scopes: ['cs:booking_requests:create', 'cs:catalog:read'],
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
            nameEn: `Drop-off ${tag}${suffix}`,
            nameAr: 'مكان اختبار التسليم',
            countryCode: 'TD',
          },
        })
      ).id;
    }
    await staff(cookies.admin)
      .put(`/master-data/locations/${ids.origin}/routing-branches`, { branchIds: [krt] })
      .expect(200);
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

  it('names no point while pending or rejected, nor on approval when the branch has none', async () => {
    const pending = await request();
    expect((await botRead(pending)).dropOff).toBeNull();
    const rejected = await request();
    await staff(cookies.sales)
      .post(`/cs-booking-requests/${rejected}/reject`, {
        version: (await detail(rejected)).version,
        reasonCode: 'NEED_MORE_INFO',
      })
      .expect(201);
    expect((await botRead(rejected)).dropOff).toBeNull();
    const none = await request();
    await approve(none);
    expect((await botRead(none)).status).toBe('approved');
    expect((await botRead(none)).dropOff).toBeNull();
  });

  it("names the branch's only point on approval, with a map link from its position", async () => {
    ids.full = await point(krt, {
      address: 'السوق العربي، الخرطوم',
      phone: '+249900000001',
      latitude: '15.600000',
      longitude: '32.530000',
      hoursAr: 'السبت إلى الخميس',
    });
    const id = await request();
    const shown = await detail(id);
    expect(shown.dropOffChoices.map((c) => c.id)).toEqual([ids.full]);
    await approve(id);
    expect((await botRead(id)).dropOff).toEqual({
      name: { ar: `نقطة ${seq}`, en: `Point ${seq}` },
      // The one language given is repeated.
      address: { ar: 'السوق العربي، الخرطوم', en: 'السوق العربي، الخرطوم' },
      phone: '+249900000001',
      mapUrl: 'https://www.google.com/maps/search/?api=1&query=15.6,32.53',
      hours: { ar: 'السبت إلى الخميس', en: 'السبت إلى الخميس' },
    });
    expect((await detail(id)).dropOffPoint?.id).toBe(ids.full);
    ids.approved = id;
    // Plan 13 section 1: its booking carries the same window, and the print draws its map QR.
    ids.approvedBooking = (await detail(id)).bookingId!;
    const booking = (await staff(cookies.sales).get(`/bookings/${ids.approvedBooking}`).expect(200))
      .body as BookingDto;
    expect(booking.dropOffWarehouseId).toBe(ids.full);
    expect(booking.dropOff).toMatchObject({ code: `${tag}-${seq}`, phone: '+249900000001' });
    const qr = await staff(cookies.sales)
      .get(`/bookings/${ids.approvedBooking}/drop-off-qr.svg`)
      .expect(200);
    expect(String(qr.text ?? qr.body)).toContain('<svg');
  });

  it('reads the point as it is now: an edit shows at once, no position and no link is no link', async () => {
    await staff(cookies.admin)
      .patch(`/warehouses/${ids.full}`, { hoursEn: 'Sat to Thu', latitude: null, longitude: null })
      .expect(200);
    const read = (await botRead(ids.approved!)).dropOff;
    expect(read?.hours).toEqual({ ar: 'السبت إلى الخميس', en: 'Sat to Thu' });
    expect(read?.mapUrl).toBeNull();
    const audit = await t.prisma.auditEvent.findFirst({
      where: { entity: 'WAREHOUSE', entityId: ids.full },
      orderBy: { id: 'desc' },
    });
    expect(JSON.stringify(audit?.changes)).toContain('hoursEn');
    // Only https links, only an outlet of the branch.
    await staff(cookies.admin)
      .patch(`/warehouses/${ids.full}`, { mapUrl: 'http://maps.example/p' })
      .expect(400);
    await staff(cookies.admin)
      .patch(`/warehouses/${ids.full}`, { mapUrl: 'https://maps.example/p' })
      .expect(200);
    expect((await botRead(ids.approved!)).dropOff?.mapUrl).toBe('https://maps.example/p');
  });

  it('names none of two points unless staff choose one, and only a usable point of the branch', async () => {
    ids.second = await point(krt, { mapUrl: 'https://maps.example/second' });
    const unnamed = await request();
    await approve(unnamed);
    expect((await botRead(unnamed)).dropOff).toBeNull();

    ids.other = await point(pts);
    ids.closed = await point(krt, { acceptsDropOff: false });
    ids.off = await point(krt, { isActive: false });
    const id = await request();
    for (const refused of [ids.other, ids.closed, ids.off]) {
      const res = await approve(id, { dropOffId: refused }, 400);
      expect(res.body).toMatchObject({ code: 'DROP_OFF_NOT_ALLOWED' });
    }
    await approve(id, { dropOffId: ids.second });
    expect((await botRead(id)).dropOff?.mapUrl).toBe('https://maps.example/second');
  });

  it('lets a staff booking name a window of its branch, labelled with its outlet (plan 13)', async () => {
    const outlet = await t.prisma.partner.create({
      data: {
        number: `${tag}-PTR`,
        kind: 'SALES_OUTLET',
        branchId: krt,
        name: `${tag} travel agency`,
        countryCode: 'SD',
        currency: 'USD',
        createdById,
      },
    });
    await t.prisma.warehouse.update({ where: { id: ids.second }, data: { partnerId: outlet.id } });
    const choices = (
      await staff(cookies.sales).get('/bookings/drop-off-points', { branchId: krt }).expect(200)
    ).body as CsDropOffChoiceDto[];
    expect(choices.map((c) => c.id)).toEqual([ids.full, ids.second]);
    expect(choices.find((c) => c.id === ids.second)?.outletName).toBe(`${tag} travel agency`);
    expect(choices.find((c) => c.id === ids.full)?.outletName).toBeNull();
    // The approval dropdown carries the same label.
    const pending = await request();
    expect(
      (await detail(pending)).dropOffChoices.find((c) => c.id === ids.second)?.outletName,
    ).toBe(`${tag} travel agency`);
    // Only a branch where the person writes bookings.
    await staff(cookies.sales).get('/bookings/drop-off-points', { branchId: pts }).expect(403);

    const body = {
      customerId: ids.customer,
      branchId: krt,
      originLocationId: ids.origin,
      destinationLocationId: ids.dest,
      mode: 'ROAD',
      services: [],
      items: [{ cargoType: 'BARREL', quantity: 1 }],
    };
    for (const refused of [ids.other, ids.closed, ids.off]) {
      const res = await staff(cookies.sales)
        .post('/bookings', { ...body, dropOffWarehouseId: refused })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'DROP_OFF_NOT_ALLOWED' });
    }
    const made = (
      await staff(cookies.sales)
        .post('/bookings', { ...body, dropOffWarehouseId: ids.second })
        .expect(201)
    ).body as BookingDto;
    expect(made.dropOffWarehouseId).toBe(ids.second);
    expect(made.dropOff?.mapUrl).toBe('https://maps.example/second');
    const edit = { ...body, customerId: undefined, branchId: undefined };
    // Left out on an edit, it stays; another branch's is refused; null clears it.
    const kept = (await staff(cookies.sales).patch(`/bookings/${made.id}`, edit).expect(200))
      .body as BookingDto;
    expect(kept.dropOffWarehouseId).toBe(ids.second);
    await staff(cookies.sales)
      .patch(`/bookings/${made.id}`, { ...edit, dropOffWarehouseId: ids.other })
      .expect(400);
    const cleared = (
      await staff(cookies.sales)
        .patch(`/bookings/${made.id}`, { ...edit, dropOffWarehouseId: null })
        .expect(200)
    ).body as BookingDto;
    expect(cleared.dropOffWarehouseId).toBeNull();
    expect(cleared.dropOff).toBeNull();
    await staff(cookies.sales).get(`/bookings/${made.id}/drop-off-qr.svg`).expect(404);
    // A bot request's booking changes its window on the request, never on the booking form.
    const res = await staff(cookies.sales)
      .patch(`/bookings/${ids.approvedBooking}`, { ...edit, dropOffWarehouseId: ids.second })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'DROP_OFF_FROM_REQUEST' });
  });

  it('lets staff who may approve correct the point of an approved request', async () => {
    const id = ids.approved!;
    const { version } = await detail(id);
    await staff(cookies.ops)
      .post(`/cs-booking-requests/${id}/drop-off`, { version, dropOffId: ids.second })
      .expect(403);
    await staff(cookies.sales)
      .post(`/cs-booking-requests/${id}/drop-off`, { version: version - 1, dropOffId: ids.second })
      .expect(409);
    await staff(cookies.sales)
      .post(`/cs-booking-requests/${id}/drop-off`, { version, dropOffId: ids.other })
      .expect(400);
    const fixed = (
      await staff(cookies.sales)
        .post(`/cs-booking-requests/${id}/drop-off`, { version, dropOffId: ids.second })
        .expect(201)
    ).body as CsBookingRequestStaffDto;
    expect(fixed.dropOffPoint?.id).toBe(ids.second);
    expect((await botRead(id)).dropOff?.name.en).toBe(`Point 2`);
    // Plan 13 section 1: the correction moves the booking's window too.
    const moved = (await staff(cookies.sales).get(`/bookings/${ids.approvedBooking}`).expect(200))
      .body as BookingDto;
    expect(moved.dropOffWarehouseId).toBe(ids.second);
    // A point turned off later reads as none.
    await t.prisma.warehouse.update({ where: { id: ids.second }, data: { isActive: false } });
    expect((await botRead(id)).dropOff).toBeNull();
    const pending = await request();
    await staff(cookies.sales)
      .post(`/cs-booking-requests/${pending}/drop-off`, {
        version: (await detail(pending)).version,
        dropOffId: ids.full,
      })
      .expect(409);
  });

  it("gives the bot its branches' customer service numbers", async () => {
    const set = (phone: string | null, cookie = cookies.admin) =>
      staff(cookie).put(`/master-data/branches/${krt}/support-phone`, { phone });
    await set('0912345678').expect(400);
    await set('+249900000099', cookies.sales).expect(403);
    const phones = (await set('+249900000099').expect(200)).body as BranchSupportPhoneDto[];
    expect(phones.find((p) => p.branchId === krt)?.phone).toBe('+249900000099');
    const catalog = async () =>
      (
        await t
          .http()
          .get('/api/v1/cs/catalog')
          .set('Authorization', `Bearer ${bot.key}`)
          .expect(200)
      ).body as CsCatalogDto;
    const krtOf = async () => (await catalog()).support.filter((p) => p.branchId === krt);
    expect(await krtOf()).toEqual([
      expect.objectContaining({ branchId: krt, code: 'KRT', phone: '+249900000099' }),
    ]);
    // Trial 2026-11-06: a branch the key does not serve is listed too (the destination answers).
    const dxb = (await t.prisma.branch.findUniqueOrThrow({ where: { code: 'DXB' } })).id;
    await staff(cookies.admin)
      .put(`/master-data/branches/${dxb}/support-phone`, { phone: '+971500000099' })
      .expect(200);
    expect((await catalog()).support).toContainEqual(
      expect.objectContaining({ branchId: dxb, code: 'DXB', phone: '+971500000099' }),
    );
    await staff(cookies.admin)
      .put(`/master-data/branches/${dxb}/support-phone`, { phone: null })
      .expect(200);
    await set(null).expect(200);
    expect(await krtOf()).toEqual([]);
  });

  it("lists its branches' open drop-off points in the catalog, and no other", async () => {
    const name = (n: string) => ({ nameAr: `مكتب ${tag} ${n}`, nameEn: `Office ${tag} ${n}` });
    await point(krt, {
      ...name('open'),
      address: 'السوق العربي، الخرطوم',
      phone: '+249900000098',
      latitude: '15.5',
      longitude: '32.5',
      hoursAr: 'من 8 إلى 5',
      locationId: ids.origin,
    });
    await point(krt, { ...name('closed'), acceptsDropOff: false });
    await point(krt, { ...name('off'), isActive: false });
    await point(pts, name('other-branch'));
    const listed = (
      (
        await t
          .http()
          .get('/api/v1/cs/catalog')
          .set('Authorization', `Bearer ${bot.key}`)
          .expect(200)
      ).body as CsCatalogDto
    ).dropOffPoints.filter((p) => p.name.en.startsWith(`Office ${tag}`));
    expect(listed).toEqual([
      {
        branchId: krt,
        branchCode: 'KRT',
        placeId: ids.origin,
        name: { ar: `مكتب ${tag} open`, en: `Office ${tag} open` },
        address: { ar: 'السوق العربي، الخرطوم', en: 'السوق العربي، الخرطوم' },
        phone: '+249900000098',
        mapUrl: 'https://www.google.com/maps/search/?api=1&query=15.5,32.5',
        hours: { ar: 'من 8 إلى 5', en: 'من 8 إلى 5' },
      },
    ]);
  });

  it('audits a rename alone, and never leaves half a position when edits race (Codex F169-1, F169-3)', async () => {
    const id = await point(krt, { latitude: '15', longitude: '32', acceptsDropOff: false });
    await staff(cookies.admin)
      .patch(`/warehouses/${id}`, { nameAr: 'اسم جديد', nameEn: 'New name' })
      .expect(200);
    const renamed = await t.prisma.auditEvent.findMany({
      where: { entity: 'WAREHOUSE', entityId: id },
    });
    expect(renamed).toHaveLength(1);
    expect(JSON.stringify(renamed[0]?.changes)).toContain('nameAr');
    expect(JSON.stringify(renamed[0]?.changes)).toContain('nameEn');
    // One moves the latitude while another clears the position: whichever goes second sees the
    // first, so the result is both or neither, never one of the two.
    for (let round = 0; round < 5; round += 1) {
      await t.prisma.warehouse.update({
        where: { id },
        data: { latitude: '15', longitude: '32' },
      });
      const answers = await Promise.all([
        staff(cookies.admin).patch(`/warehouses/${id}`, { latitude: '16' }),
        staff(cookies.admin).patch(`/warehouses/${id}`, { latitude: null, longitude: null }),
      ]);
      const row = await t.prisma.warehouse.findUniqueOrThrow({ where: { id } });
      // The clear always lands; a move checked after it is refused (it would leave half), and a
      // move before it is cleared with the rest.
      expect([row.latitude, row.longitude], `round ${round}`).toEqual([null, null]);
      expect(answers[1].status).toBe(200);
      expect([200, 400]).toContain(answers[0].status);
    }
  });
});
