import { randomInt, randomUUID } from 'node:crypto';
import type {
  AccountDto,
  ApiClientCreatedDto,
  CsBookingRequestCreated,
  CsQuoteDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestAutocycleService } from '../src/test-autocycle/test-autocycle.service.js';
import { AUTOCYCLE_STAFF, AUTOCYCLE_WINDOW } from '../src/test-autocycle/test-autocycle.js';
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
 * Owner, 2026-11-07 (staging trials): a bot request whose sender's name holds «اختبار» is approved
 * by «Test Autocycle», received at its window and paid there by «Test Autocycle (window)», through
 * the ordinary services, the delay apart (0 here). Negative cases: a request with another name is
 * never touched; the switch off, and the production stack with it on, do nothing. The receipt
 * posts entries, so the users are LEDGER users and the customers this run's own.
 */
describe('staging test autocycle', () => {
  const base = {
    CS_TEST_AUTOCYCLE_DELAY_S: 0,
    CS_APPROVE_CONFIRMS_ENABLED: true,
    WINDOW_DESK_ENABLED: true,
    WINDOW_COLLECT_ENABLED: true,
  };
  let on: TestApp;
  let off: TestApp;
  let production: TestApp;
  let pts = '';
  let bot: ApiClientCreatedDto;
  const tag = `TA${randomUUID().slice(0, 5).toUpperCase()}`;
  const ids: Record<string, string> = {};
  let category = '';

  const admin = (cookie: string) => ({
    put: (path: string, body: object) =>
      on.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    post: (path: string, body: object) =>
      on.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });

  /** A request in the one-item shape with the bot's quote (USD), as the bot sends one. */
  async function request(senderName: string, quantity = '2'): Promise<string> {
    const quote = (
      await on
        .http()
        .get('/api/v1/cs/quote')
        .query({ originId: ids.origin, destinationId: ids.dest, category, quantity })
        .set('Authorization', `Bearer ${bot.key}`)
        .expect(200)
    ).body as CsQuoteDto;
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
            senderName,
            consigneeName: 'Consignee',
            consigneePhone: '0912345678',
            handover: 'BRANCH_DROP',
            language: 'ar',
            idempotencyKey: `autocycle-${randomUUID()}`,
            category,
            quantity,
            quoteRef: quote.quoteRef,
          })
          .expect((res) => {
            if (res.status !== 201) throw new Error(JSON.stringify(res.body));
          })
      ).body as CsBookingRequestCreated
    ).requestId;
  }

  const rounds = (app: TestApp) => app.app.get(TestAutocycleService);

  beforeAll(async () => {
    on = await createTestApp({ ...base, CS_TEST_AUTOCYCLE_ENABLED: true });
    off = await createTestApp({ ...base, CS_TEST_AUTOCYCLE_ENABLED: false });
    production = await createTestApp({
      ...base,
      CS_TEST_AUTOCYCLE_ENABLED: true,
      NODE_ENV: 'production',
      DEPLOY_STACK: 'production',
    });
    pts = await branchId(on.prisma, 'PTS');
    const adminUser = await createUser(on.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    const cookie = await signIn(on, adminUser.email);
    bot = (
      await admin(cookie)
        .post('/api-clients', {
          name: 'Test autocycle',
          branchIds: [pts],
          scopes: ['cs:booking_requests:create', 'cs:quote:read'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;
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
            nameEn: `Autocycle ${tag}${suffix}`,
            nameAr: 'مكان الدورة الآلية',
            countryCode,
          },
        })
      ).id;
    }
    await admin(cookie)
      .put(`/master-data/locations/${ids.origin}/routing-branches`, { branchIds: [pts] })
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
        createdById: adminUser.id,
        approvedById: adminUser.id,
        approvedAt: new Date(),
      },
    });
    // The branch's window, first by code (the autocycle names the first window of several); an
    // earlier run's windows on the same database stop taking shipments.
    await on.prisma.warehouse.updateMany({
      where: { nameEn: 'Autocycle window', acceptsDropOff: true },
      data: { acceptsDropOff: false },
    });
    const partner = await on.prisma.partner.create({
      data: {
        number: `${tag}-P`,
        kind: 'SALES_OUTLET',
        branchId: pts,
        name: `${tag} outlet`,
        countryCode: 'SD',
        currency: 'USD',
        createdById: adminUser.id,
      },
    });
    ids.partner = partner.id;
    ids.window = (
      await on.prisma.warehouse.create({
        data: {
          branchId: pts,
          code: `0${tag}`,
          nameAr: 'نافذة الدورة الآلية',
          nameEn: 'Autocycle window',
          acceptsDropOff: true,
          partnerId: partner.id,
        },
      })
    ).id;
    const cash = (
      await admin(cookie)
        .post('/accounting/accounts', {
          code: `${tag}U`,
          nameEn: `Cash at window ${tag}`,
          nameAr: 'نقدية لدى نافذة',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency: 'USD',
          branchId: pts,
        })
        .expect(201)
    ).body as AccountDto;
    await admin(cookie)
      .put(`/warehouses/${ids.window}/cash-accounts/USD`, { accountId: cash.id })
      .expect(200);
  });

  afterAll(async () => {
    await production?.close();
    await off?.close();
    await on?.close();
  });

  it('does nothing while switched off, or on the production stack', async () => {
    ids.early = await request(`${tag} اختبار مبكر`);
    for (const app of [off, production]) {
      expect(await rounds(app).runOnce()).toEqual({ approved: 0, received: 0, paid: 0, failed: 0 });
    }
    const row = await on.prisma.csBookingRequest.findUniqueOrThrow({ where: { id: ids.early } });
    expect(row.status).toBe('PENDING');
  });

  it('approves, receives and collects a test request, as the test users', async () => {
    const id = await request(`${tag} اختبار أول`);
    const other = await request(`${tag} محمد أحمد`);
    const cycle = rounds(on);

    expect((await cycle.runOnce()).approved).toBeGreaterThanOrEqual(2);
    const approved = await on.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id },
      include: { decidedBy: { select: { fullName: true, email: true } } },
    });
    expect(approved.status).toBe('APPROVED');
    expect(approved.decidedBy).toEqual(AUTOCYCLE_STAFF);
    expect(approved.dropOffWarehouseId).toBe(ids.window);
    expect(approved.approvedTotal?.toFixed()).toBe('20');
    const booking = await on.prisma.booking.findUniqueOrThrow({
      where: { id: approved.bookingId! },
      include: { shipment: { select: { id: true } } },
    });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.dropOffWarehouseId).toBe(ids.window);

    expect((await cycle.runOnce()).received).toBeGreaterThanOrEqual(1);
    const [grn] = await on.prisma.warehouseMovement.findMany({
      where: { shipmentId: booking.shipment!.id, kind: 'RECEIPT' },
      include: { createdBy: { select: { fullName: true, email: true } } },
    });
    expect(grn).toMatchObject({ packages: 1, condition: 'GOOD', warehouseId: ids.window });
    expect(grn!.createdBy).toEqual(AUTOCYCLE_WINDOW);

    expect((await cycle.runOnce()).paid).toBeGreaterThanOrEqual(1);
    const invoice = await on.prisma.customerInvoice.findFirstOrThrow({
      where: { shipmentId: booking.shipment!.id, kind: 'MAIN' },
    });
    expect(invoice.status).toBe('APPROVED');
    expect(invoice.total.toFixed()).toBe('20');
    expect(invoice.paidAmount.toFixed()).toBe('20');
    const receipt = await on.prisma.receipt.findFirstOrThrow({
      where: { allocations: { some: { invoiceId: invoice.id } } },
      include: { createdBy: { select: { fullName: true, email: true } } },
    });
    expect(receipt).toMatchObject({
      status: 'POSTED',
      currency: 'USD',
      reference: 'TEST-AUTOCYCLE',
    });
    expect(receipt.amount.toFixed()).toBe('20');
    expect(receipt.createdBy).toEqual(AUTOCYCLE_WINDOW);

    // Done: another round takes no second receipt or payment.
    await cycle.runOnce();
    expect(
      await on.prisma.receipt.count({
        where: { allocations: { some: { invoiceId: invoice.id } } },
      }),
    ).toBe(1);
    expect(
      await on.prisma.warehouseMovement.count({
        where: { shipmentId: booking.shipment!.id, kind: 'RECEIPT' },
      }),
    ).toBe(1);
    // The request with another name is never touched.
    const untouched = await on.prisma.csBookingRequest.findUniqueOrThrow({ where: { id: other } });
    expect(untouched).toMatchObject({ status: 'PENDING', decidedById: null, bookingId: null });
  });

  it('cannot sign in as a test user', async () => {
    for (const email of [AUTOCYCLE_STAFF.email, AUTOCYCLE_WINDOW.email]) {
      await on
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', APP_ORIGIN)
        .send({ email, password: '!test-autocycle-no-login' })
        .expect(401);
    }
  });
});
