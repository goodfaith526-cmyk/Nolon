import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsBookingRequestStaffDto,
  CsQuotesDto,
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
 * Plan 09 section 4 (N-C2) and the OTHER item of section 12: a bot request with several items,
 * priced per line on approval, each item a booking line only when its count is certain, and the
 * booking confirmed only once every item has its line (CARGO_INCOMPLETE otherwise, whatever the
 * path). Negative cases: items with the one-item fields, 11 items, a one-item approval of a request
 * with items, a wrong line count, a stale line price, an OTHER item without an estimate, mixed load
 * types, a line of another booking, a line already taken, an item resolved twice, a person without
 * bookings:update, and a linked line deleted (the item is open again).
 */
describe('Customer Service booking request items (plan 09 section 4)', () => {
  let t: TestApp;
  let pts = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', sales: '', viewer: '' };
  const ids: Record<string, string> = {};
  const cat = { barrel: '', cbm: '', box: '', ctr: '' };
  let createdById = '';
  const tag = `I${randomUUID().slice(0, 5).toUpperCase()}`;

  const staff = (cookie: string) => ({
    get: (path: string, query: object = {}) =>
      t.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const botPost = (path: string, body: object) =>
    t.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bot.key}`).send(body);

  const base = () => ({
    sender: { channel: 'whatsapp', id: uniquePhone() },
    originId: ids.origin,
    destinationId: ids.dest,
    services: [],
    senderName: 'Sender',
    consigneeName: 'Consignee',
    consigneePhone: '0912345678',
    handover: 'PICKUP',
    language: 'ar',
    idempotencyKey: `items-${randomUUID()}`,
  });
  const senders = new Map<string, string>();
  async function request(items: object[]): Promise<string> {
    const body = { ...base(), items };
    const made = (await botPost('/cs/booking-requests', body).expect(201))
      .body as CsBookingRequestCreated;
    senders.set(made.requestId, `whatsapp:${body.sender.id}`);
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
  const route = (mode = 'ROAD') => ({
    originId: ids.origin!,
    destinationId: ids.dest!,
    mode,
    currency: 'USD',
  });
  async function line(id: string, category: string, quantity: string) {
    const price = (
      await staff(cookies.sales)
        .get(`/cs-booking-requests/${id}/price`, { ...route(), category, quantity })
        .expect(200)
    ).body as CsApprovalPriceDto;
    return { category, quantity, pricingFingerprint: price.pricingFingerprint };
  }
  const approve = (id: string, body: object, cookie = cookies.sales) =>
    staff(cookie).post(`/cs-booking-requests/${id}/approve`, body);
  const approveBody = async (id: string, lines: object[]) => ({
    version: (await detail(id)).version,
    paymentCurrency: 'USD',
    pricing: route(),
    lines,
    booking: { customerId: ids.customer, services: [] },
  });
  const confirm = (bookingId: string) =>
    staff(cookies.sales).post(`/bookings/${bookingId}/confirm`, {});
  const resolve = (id: string, itemId: string, bookingItemId: string, cookie = cookies.sales) =>
    staff(cookie).post(`/cs-booking-requests/${id}/items/${itemId}/resolve`, { bookingItemId });
  const addLine = async (bookingId: string, lineNo: number) =>
    (
      await t.prisma.bookingItem.create({
        data: { bookingId, lineNo, cargoType: 'GENERAL', quantity: 1, volumeCbm: '0.25' },
      })
    ).id;

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    const user = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      createUser(t.prisma, roles, branches, LEDGER_PREFIX);
    cookies.admin = await signIn(t, (await user(['ADMINISTRATOR'], [])).email);
    const sales = await user(['SALES'], ['PTS']);
    createdById = sales.id;
    cookies.sales = await signIn(t, sales.email);
    // A Branch Manager sees and approves requests but does not edit bookings.
    cookies.viewer = await signIn(t, (await user(['BRANCH_MANAGER'], ['PTS'])).email);
    bot = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Items',
          branchIds: [pts],
          scopes: ['cs:booking_requests:create', 'cs:quote:read'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;

    const categories = [
      ['barrel', 'B', 'BARREL', 'PER_BARREL', '10'],
      ['cbm', 'C', 'GENERAL', 'PER_CBM', '100'],
      ['box', 'X', 'GENERAL', 'PER_PIECE', '5'],
      ['ctr', 'K', 'CONTAINER', 'PER_CONTAINER', null],
    ] as const;
    const countryCode = `T${String.fromCharCode(65 + randomInt(26))}`;
    for (const [name, suffix] of [
      ['origin', 'ORG'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Items ${tag}${suffix}`,
            nameAr: 'مكان اختبار الأصناف',
            countryCode,
          },
        })
      ).id;
    }
    await t
      .http()
      .put(`/api/v1/master-data/locations/${ids.origin}/routing-branches`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.admin)
      .send({ branchIds: [pts] })
      .expect(200);
    for (const [key, suffix, cargoType, unit, price] of categories) {
      const code = `${tag}${suffix}`;
      cat[key] = code;
      await t.prisma.priceCategory.create({
        data: { code, nameEn: code, nameAr: code, cargoType, defaultUnit: unit },
      });
      if (price === null) continue;
      await t.prisma.rateCard.create({
        data: {
          branchId: pts,
          originLocationId: ids.origin!,
          destinationLocationId: ids.dest!,
          mode: 'ROAD',
          cargoType,
          priceCategoryCode: code,
          chargeTypeCode: 'FREIGHT',
          unit,
          price,
          currency: 'USD',
          validFrom: new Date(Date.now() - 30 * 86_400_000),
          status: 'APPROVED',
          createdById,
          approvedById: createdById,
          approvedAt: new Date(),
        },
      });
    }
    ids.customer = (
      await t.prisma.customer.create({
        data: {
          number: `${tag}-1`,
          branchId: pts,
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

  it('refuses items with the one-item fields, and more than 10 items', async () => {
    const both = await botPost('/cs/booking-requests', {
      ...base(),
      category: cat.box,
      quantity: '1',
      items: [{ category: cat.box, quantity: '1' }],
    }).expect(400);
    expect(both.body).toMatchObject({ code: 'ITEMS_AND_SINGLE' });
    const many = Array.from({ length: 11 }, () => ({ category: cat.box, quantity: '1' }));
    await botPost('/cs/booking-requests', { ...base(), items: many }).expect(400);
    // An OTHER item has no category, quantity or price of its own.
    await botPost('/cs/booking-requests', {
      ...base(),
      items: [{ kind: 'OTHER', description: 'A sofa', quantity: '1' }],
    }).expect(400);
  });

  it('keeps the items in order, and the same request is the same request', async () => {
    const body = {
      ...base(),
      items: [
        { category: cat.barrel, quantity: '3' },
        { category: cat.cbm, quantity: '0.25', pieces: 2, weightKg: '40' },
      ],
    };
    const first = (await botPost('/cs/booking-requests', body).expect(201))
      .body as CsBookingRequestCreated;
    const again = (await botPost('/cs/booking-requests', body).expect(200))
      .body as CsBookingRequestCreated;
    expect(again.requestId).toBe(first.requestId);
    const shown = await detail(first.requestId);
    expect(shown.items.map((i) => [i.lineNo, i.category, i.quantity, i.pieces])).toEqual([
      [1, cat.barrel, '3', null],
      [2, cat.cbm, '0.25', 2],
    ]);
    expect(shown.items[1]!.weightKg).toBe('40');
  });

  it('approves per line; an item without a certain count blocks confirmation until resolved', async () => {
    const id = await request([
      { category: cat.barrel, quantity: '3' },
      { category: cat.cbm, quantity: '0.25' },
    ]);
    expect((await botRead(id)).approvedPrice).toBeNull();
    const lines = [await line(id, cat.barrel, '3'), await line(id, cat.cbm, '0.25')];
    const body = await approveBody(id, lines);

    // A one-item approval, a wrong count of lines, or a stale line price: no booking.
    const single = await approve(id, {
      ...body,
      lines: undefined,
      pricing: { ...route(), category: cat.barrel, quantity: '3' },
      pricingFingerprint: lines[0]!.pricingFingerprint,
    }).expect(400);
    expect(single.body).toMatchObject({ code: 'LINES_MISMATCH' });
    const short = await approve(id, { ...body, lines: [lines[0]] }).expect(400);
    expect(short.body).toMatchObject({ code: 'LINES_MISMATCH' });
    await approve(id, {
      ...body,
      lines: [lines[0], { ...lines[1], pricingFingerprint: lines[0]!.pricingFingerprint }],
    }).expect(409);
    expect((await detail(id)).status).toBe('pending');

    const approved = (await approve(id, body).expect(201)).body as CsBookingRequestStaffDto;
    expect(approved.status).toBe('approved');
    // 3 barrels at 10, and 0.25 CBM at 100.
    expect(approved.approvedPricing?.total).toBe('55');
    expect(approved.items.map((i) => i.approvedTotal)).toEqual(['30', '25']);
    // The barrels are counted: one line. 0.25 CBM without pieces has no count: no line.
    expect(approved.bookingLines).toHaveLength(1);
    expect(approved.bookingLines[0]).toMatchObject({ cargoType: 'BARREL', quantity: 3 });
    expect(approved.items[0]!.bookingItemId).toBe(approved.bookingLines[0]!.id);
    expect(approved.items[1]!.bookingItemId).toBeNull();

    // The bot reads the approved total (amendment 4); before approval there is none.
    expect((await botRead(id)).approvedPrice).toEqual({ amount: '55', currency: 'USD' });

    const bookingId = approved.bookingId!;
    const incomplete = await confirm(bookingId).expect(409);
    expect(incomplete.body).toMatchObject({ code: 'CARGO_INCOMPLETE' });
    expect(await t.prisma.shipment.count({ where: { bookingId } })).toBe(0);

    // Staff add the missing line and link it; a person without bookings:update may not.
    const added = await addLine(bookingId, 2);
    const item = approved.items[1]!.id;
    await resolve(id, item, added, cookies.viewer).expect(403);
    // A line of another booking, or one already completing an item, is refused.
    const other = await request([{ category: cat.box, quantity: '2' }]);
    const otherApproved = (
      await approve(other, await approveBody(other, [await line(other, cat.box, '2')])).expect(201)
    ).body as CsBookingRequestStaffDto;
    const foreign = await resolve(id, item, otherApproved.bookingLines[0]!.id).expect(400);
    expect(foreign.body).toMatchObject({ code: 'LINE_NOT_OF_BOOKING' });
    const taken = await resolve(id, item, approved.bookingLines[0]!.id).expect(409);
    expect(taken.body).toMatchObject({ code: 'LINE_TAKEN' });

    const resolved = (await resolve(id, item, added).expect(201)).body as CsBookingRequestStaffDto;
    expect(resolved.items[1]!.bookingItemId).toBe(added);
    const twice = await resolve(id, item, added).expect(409);
    expect(twice.body).toMatchObject({ code: 'ITEM_RESOLVED' });
    expect(
      await t.prisma.auditEvent.count({
        where: { entityId: id, action: 'UPDATED', userId: createdById },
      }),
    ).toBe(1);

    // Deleting a linked line opens the item again: confirmation is refused once more.
    await t.prisma.bookingItem.delete({ where: { id: added } });
    expect(
      (await t.prisma.csBookingRequestItem.findUniqueOrThrow({ where: { id: item } }))
        .bookingItemId,
    ).toBeNull();
    await confirm(bookingId).expect(409);
    const again = await addLine(bookingId, 2);
    await resolve(id, item, again).expect(201);
    await confirm(bookingId).expect(200);
    expect(await t.prisma.shipment.count({ where: { bookingId } })).toBe(1);
    // The confirmed shipment's public tracking link (what its QR opens).
    const read = await botRead(id);
    expect(read.shipment?.trackingUrl).toMatch(/\/track\/[A-Za-z0-9_-]+$/);
  });

  it('makes a line from the pieces of a CBM item, with the volume priced', async () => {
    const id = await request([{ category: cat.cbm, quantity: '0.25', pieces: 2, weightKg: '40' }]);
    const approved = (
      await approve(id, await approveBody(id, [await line(id, cat.cbm, '0.25')])).expect(201)
    ).body as CsBookingRequestStaffDto;
    const made = await t.prisma.bookingItem.findUniqueOrThrow({
      where: { id: approved.items[0]!.bookingItemId! },
    });
    expect(made.quantity).toBe(2);
    expect(made.volumeCbm?.toString()).toBe('0.25');
    expect(made.weightKg?.toString()).toBe('40');
    expect(made.priceCategoryCode).toBe(cat.cbm);
    await confirm(approved.bookingId!).expect(200);
  });

  it('refuses an OTHER item without an estimate, and items of different load types', async () => {
    const other = await request([
      { category: cat.box, quantity: '1' },
      { kind: 'OTHER', description: 'A sofa', pieces: 1 },
    ]);
    const shown = await detail(other);
    expect(shown.items[1]).toMatchObject({ isOther: true, description: 'A sofa', category: null });
    const estimate = await approve(
      other,
      await approveBody(other, [await line(other, cat.box, '1')]),
    ).expect(409);
    expect(estimate.body).toMatchObject({ code: 'ESTIMATE_REQUIRED' });

    const mixed = await request([
      { category: cat.cbm, quantity: '1' },
      { category: cat.ctr, quantity: '1' },
    ]);
    const body = await approveBody(mixed, [
      { category: cat.cbm, quantity: '1', pricingFingerprint: null },
      { category: cat.ctr, quantity: '1', pricingFingerprint: null },
    ]);
    const refused = await approve(mixed, { ...body, pricing: route('SEA') }).expect(422);
    expect(refused.body).toMatchObject({ code: 'MIXED_LOAD' });
    expect((await detail(mixed)).status).toBe('pending');
  });

  it('prices several items at once, each with its own reference, and their sum', async () => {
    const quotes = (
      await botPost('/cs/quotes', {
        originId: ids.origin,
        destinationId: ids.dest,
        items: [
          { category: cat.barrel, quantity: '3' },
          { category: cat.box, quantity: '4' },
        ],
      }).expect(200)
    ).body as CsQuotesDto;
    expect(quotes.items.map((i) => i.quote?.total)).toEqual(['30.00', '20.00']);
    expect(quotes.items[0]!.quote!.quoteRef).not.toBe(quotes.items[1]!.quote!.quoteRef);
    expect(quotes.items[0]!.quote!.validUntil).toBe(quotes.items[0]!.quote!.quoteRefExpiresAt);
    expect(quotes).toMatchObject({ total: '50.00', currency: 'USD', totalReason: null });

    const partial = (
      await botPost('/cs/quotes', {
        originId: ids.origin,
        destinationId: ids.dest,
        items: [
          { category: cat.barrel, quantity: '3' },
          { category: cat.ctr, quantity: '1' },
        ],
      }).expect(200)
    ).body as CsQuotesDto;
    expect(partial.items[1]!.quote).toBeNull();
    expect(partial.items[1]!.error?.status).toBeGreaterThanOrEqual(400);
    expect(partial).toMatchObject({ total: null, currency: null, totalReason: 'ITEM_NOT_PRICED' });
    await botPost('/cs/quotes', {
      originId: ids.origin,
      destinationId: ids.dest,
      items: [],
    }).expect(400);
  });
});
