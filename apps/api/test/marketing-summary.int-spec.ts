import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  MarketingSummaryDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/common/dates.js';
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
 * The marketing summary (docs/plans/11): read only, aggregates only, by a key holding
 * cs:marketing:read; revenue only with cs:marketing:revenue:read; requests, bookings and revenue
 * of the key's branches only.
 */
describe('Marketing summary', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let today = '';
  const tag = `MK${randomUUID().slice(0, 5).toUpperCase()}`;
  const year = randomInt(1000, 1800);
  const ids = { origin: '', dest: '', category: '', other: '', shipment: '' };
  const cookies = { admin: '', salesPts: '', salesJed: '', financePts: '', managerPts: '' };
  const keys = {
    marketing: null as ApiClientCreatedDto | null,
    revenue: null as ApiClientCreatedDto | null,
    jed: null as ApiClientCreatedDto | null,
    catalog: null as ApiClientCreatedDto | null,
  };
  let customer: CustomerDto;
  let botKeyId = '';

  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const summary = (key: ApiClientCreatedDto | null, query: string) =>
    t
      .http()
      .get(`/api/v1/marketing/summary?${query}`)
      .set('Authorization', `Bearer ${key?.key ?? ''}`);
  const ours = (body: MarketingSummaryDto) =>
    body.monthly.filter((r) => r.originId === ids.origin && r.destinationId === ids.dest);

  async function booking(
    cookie: string,
    customerId: string,
    category: string,
  ): Promise<BookingDto> {
    return (
      await post('/bookings', cookie, {
        customerId,
        originLocationId: ids.origin,
        destinationLocationId: ids.dest,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 2, priceCategoryCode: category }],
      }).expect(201)
    ).body as BookingDto;
  }

  let requestNo = 0;
  async function request(data: {
    branchId: string | null;
    allowed: string[];
    channel: string | null;
    category: string;
  }) {
    requestNo += 1;
    await t.prisma.csBookingRequest.create({
      data: {
        reference: `${tag}-${requestNo}`,
        apiClientId: botKeyId,
        ownerRef: `s:telegram:${requestNo}`,
        idempotencyKey: `${tag}-${requestNo}`,
        contentHash: 'a'.repeat(64),
        status: data.branchId === null ? 'AWAITING_ROUTING' : 'PENDING',
        branchId: data.branchId,
        allowedBranchIds: data.allowed,
        senderChannel: data.channel,
        senderId: data.channel === null ? null : String(requestNo),
        originLocationId: ids.origin,
        destinationLocationId: ids.dest,
        priceCategoryCode: data.category,
        quantity: '2',
        senderName: `${tag} Secret Sender`,
        consigneeName: `${tag} Secret Consignee`,
        consigneePhone: '+249900000001',
        handover: 'BRANCH_DROP',
        language: 'ar',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const ptsRow = await t.prisma.branch.findUniqueOrThrow({ where: { id: pts } });
    today = todayIn(ptsRow.timezone);
    // Approved invoices post entries that are never deleted: their users stay (LEDGER_PREFIX).
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }

    const countryCode = `X${String.fromCharCode(65 + randomInt(26))}`;
    const place = async (suffix: string) =>
      (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Marketing ${tag}${suffix}`,
            nameAr: 'مكان اختبار التسويق',
            countryCode,
          },
        })
      ).id;
    ids.origin = await place('O');
    ids.dest = await place('D');
    for (const [key, suffix] of [
      ['category', 'A'],
      ['other', 'B'],
    ] as const) {
      ids[key] = `${tag}${suffix}`;
      await t.prisma.priceCategory.create({
        data: {
          code: ids[key],
          nameEn: ids[key],
          nameAr: ids[key],
          cargoType: 'GENERAL',
          defaultUnit: 'PER_PIECE',
        },
      });
    }
    const card = (status: 'APPROVED' | 'DRAFT', price: string, validTo: Date | null = null) =>
      t.prisma.rateCard.create({
        data: {
          branchId: jed,
          originLocationId: ids.origin,
          destinationLocationId: ids.dest,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          priceCategoryCode: ids.category,
          chargeTypeCode: 'FREIGHT',
          unit: 'PER_PIECE',
          price,
          minimumCharge: '50',
          currency: 'USD',
          validFrom: new Date(Date.now() - 30 * 86_400_000),
          validTo,
          transitDays: 9,
          status,
          createdById: users.salesPts.id,
          ...(status === 'APPROVED'
            ? { approvedById: users.salesPts.id, approvedAt: new Date() }
            : {}),
        },
      });
    await card('APPROVED', '123.4567');
    await card('DRAFT', '999');
    await card('APPROVED', '888', new Date(Date.now() - 2 * 86_400_000));

    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'INDIVIDUAL',
        name: `${tag} Secret Customer`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;

    const make = async (name: string, branchIds: string[], scopes: string[]) =>
      (
        await post('/api-clients', cookies.admin, {
          name: `${tag} ${name}`,
          branchIds,
          scopes,
        }).expect(201)
      ).body as ApiClientCreatedDto;
    keys.marketing = await make('marketing', [pts], ['cs:marketing:read']);
    keys.revenue = await make('revenue', [pts], ['cs:marketing:read', 'cs:marketing:revenue:read']);
    keys.jed = await make('jed', [jed], ['cs:marketing:read']);
    keys.catalog = await make('catalog', [pts], ['cs:catalog:read', 'cs:marketing:revenue:read']);
    botKeyId = (await make('bot', [pts, jed], ['cs:booking_requests:create'])).client.id;

    // PTS: one confirmed and one cancelled branch booking; JED: one branch booking.
    const confirmed = await booking(cookies.salesPts, customer.id, ids.category);
    const shipped = (await post(`/bookings/${confirmed.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    ids.shipment = shipped.shipmentId ?? '';
    const cancelled = await booking(cookies.salesPts, customer.id, ids.category);
    await post(`/bookings/${cancelled.id}/cancel`, cookies.salesPts, {
      reason: 'Customer changed plans',
    }).expect(200);
    const jedCustomer = (
      await post('/customers', cookies.salesJed, {
        branchId: jed,
        kind: 'INDIVIDUAL',
        name: `${tag} Jed Secret`,
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
    await booking(cookies.salesJed, jedCustomer.id, ids.category);

    // Bot requests: PTS by Telegram, PTS by the website, awaiting routing with PTS a candidate
    // (WhatsApp), and JED's (not the PTS key's).
    await request({ branchId: pts, allowed: [pts], channel: 'telegram', category: ids.category });
    await request({ branchId: pts, allowed: [pts], channel: 'web', category: ids.category });
    await request({
      branchId: null,
      allowed: [pts, jed],
      channel: 'whatsapp',
      category: ids.other,
    });
    await request({ branchId: jed, allowed: [jed], channel: 'telegram', category: ids.category });

    // Revenue in a year of its own: an invoice of 1250 and a credit note of 200.25.
    const draft = (
      await post('/customer-invoices', cookies.financePts, { shipmentId: ids.shipment }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      currency: 'USD',
      invoiceDate: `${year}-03-01`,
      dueDate: `${year}-03-31`,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '1250' }],
    }).expect(200);
    await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200);
    const note = (
      await post('/credit-notes', cookies.financePts, {
        requestId: randomUUID(),
        invoiceId: draft.id,
        creditDate: `${year}-04-02`,
        amount: '200.25',
        reason: 'Marketing test discount',
      }).expect(201)
    ).body as { id: string };
    await post(`/credit-notes/${note.id}/approve`, cookies.managerPts).expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  it('is read by a key with the marketing scope only', async () => {
    await t.http().get(`/api/v1/marketing/summary?from=${today}&to=${today}`).expect(401);
    const refused = await summary(keys.catalog, `from=${today}&to=${today}`).expect(403);
    expect(refused.body).toMatchObject({ code: 'SCOPE_REQUIRED' });
    await summary(keys.marketing, `from=${today}&to=${today}`).expect(200);
  });

  it('has no write route', async () => {
    await t
      .http()
      .post('/api/v1/marketing/summary')
      .set('Origin', APP_ORIGIN)
      .set('Authorization', `Bearer ${keys.marketing?.key ?? ''}`)
      .send({})
      .expect(404);
  });

  it('refuses a period past 12 months, backwards, or not a date', async () => {
    const tooLong = await summary(keys.marketing, 'from=2025-01-01&to=2026-01-31').expect(400);
    expect(tooLong.body).toMatchObject({ code: 'RANGE_TOO_LONG' });
    await summary(keys.marketing, 'from=2025-01-01&to=2025-12-31').expect(200);
    const backwards = await summary(keys.marketing, 'from=2026-02-01&to=2026-01-01').expect(400);
    expect(backwards.body).toMatchObject({ code: 'BAD_RANGE' });
    await summary(keys.marketing, 'from=2026-02-30&to=2026-03-01').expect(400);
    await summary(keys.marketing, 'from=2026-01-01').expect(400);
    await summary(keys.marketing, `from=${today}&to=${today}&branchId=${jed}`).expect(400);
  });

  it("lists today's approved freight prices of every branch, with the route and its names", async () => {
    const body = (await summary(keys.marketing, `from=${today}&to=${today}`).expect(200))
      .body as MarketingSummaryDto;
    const prices = body.prices.filter((p) => p.originId === ids.origin);
    expect(prices).toEqual([
      {
        originId: ids.origin,
        destinationId: ids.dest,
        mode: 'ROAD',
        loadType: null,
        category: ids.category,
        unit: 'PER_PIECE',
        price: '123.4567',
        minimumCharge: '50',
        currency: 'USD',
        validFrom: prices[0]?.validFrom,
        validTo: null,
        transitDays: 9,
      },
    ]);
    expect(prices[0]?.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.routes.filter((r) => r.originId === ids.origin)).toEqual([
      {
        originId: ids.origin,
        destinationId: ids.dest,
        mode: 'ROAD',
        loadTypes: [],
        categories: [ids.category],
      },
    ]);
    expect(body.places.find((p) => p.id === ids.origin)).toMatchObject({ code: `${tag}O` });
    expect(body.categories.find((c) => c.code === ids.category)).toMatchObject({
      unit: 'PER_PIECE',
    });
  });

  it("counts the key's branches' requests by source and bookings by status", async () => {
    const body = (await summary(keys.marketing, `from=${today}&to=${today}`).expect(200))
      .body as MarketingSummaryDto;
    const month = today.slice(0, 7);
    expect(ours(body)).toEqual([
      {
        month,
        originId: ids.origin,
        destinationId: ids.dest,
        category: ids.category,
        requests: { total: 4, bot: 1, website: 1, branch: 2 },
        bookings: { confirmed: 1, cancelled: 1 },
      },
      {
        month,
        originId: ids.origin,
        destinationId: ids.dest,
        category: ids.other,
        requests: { total: 1, bot: 1, website: 0, branch: 0 },
        bookings: { confirmed: 0, cancelled: 0 },
      },
    ]);
    const jedBody = (await summary(keys.jed, `from=${today}&to=${today}`).expect(200))
      .body as MarketingSummaryDto;
    expect(ours(jedBody)).toEqual([
      expect.objectContaining({
        category: ids.category,
        requests: { total: 2, bot: 1, website: 0, branch: 1 },
        bookings: { confirmed: 0, cancelled: 0 },
      }),
      expect.objectContaining({
        category: ids.other,
        requests: { total: 1, bot: 1, website: 0, branch: 0 },
      }),
    ]);
  });

  it('gives revenue only to a key with the revenue scope, net of credit notes', async () => {
    const query = `from=${year}-01-01&to=${year}-12-31`;
    const plain = (await summary(keys.marketing, query).expect(200)).body as MarketingSummaryDto;
    expect(plain).not.toHaveProperty('revenue');
    const body = (await summary(keys.revenue, query).expect(200)).body as MarketingSummaryDto;
    expect(body.revenue?.filter((r) => r.originId === ids.origin)).toEqual([
      {
        month: `${year}-03`,
        originId: ids.origin,
        destinationId: ids.dest,
        currency: 'USD',
        invoiced: '1250',
        credited: '0',
        net: '1250',
      },
      {
        month: `${year}-04`,
        originId: ids.origin,
        destinationId: ids.dest,
        currency: 'USD',
        invoiced: '0',
        credited: '200.25',
        net: '-200.25',
      },
    ]);
    const jedBody = (await summary(keys.jed, query).expect(200)).body as MarketingSummaryDto;
    expect(jedBody).not.toHaveProperty('revenue');
  });

  it('counts a new person once, every branch, and names no customer', async () => {
    const query = `from=${today}&to=${today}`;
    const count = async () =>
      ((await summary(keys.jed, query).expect(200)).body as MarketingSummaryDto).newCustomers.find(
        (m) => m.month === today.slice(0, 7),
      )?.count ?? 0;
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(1);
    await post('/customers', cookies.salesPts, {
      branchId: pts,
      kind: 'INDIVIDUAL',
      name: `${tag} Second Secret`,
      phone: uniquePhone(),
    }).expect(201);
    expect(await count()).toBe(before + 1);

    const body = (await summary(keys.revenue, query).expect(200)).body as MarketingSummaryDto;
    const text = JSON.stringify(body);
    for (const secret of [customer.name, customer.number, customer.phone ?? '', 'Secret']) {
      expect(text).not.toContain(secret);
    }
  });
});
