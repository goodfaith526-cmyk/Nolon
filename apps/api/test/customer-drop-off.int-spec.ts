import { randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  BranchSupportPhoneDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsBookingRequestStaffDto,
  CsCatalogDto,
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
          branchId: krt,
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
    // The key's branch only.
    expect((await catalog()).support).toEqual([
      expect.objectContaining({ branchId: krt, code: 'KRT', phone: '+249900000099' }),
    ]);
    await set(null).expect(200);
    expect((await catalog()).support).toEqual([]);
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
