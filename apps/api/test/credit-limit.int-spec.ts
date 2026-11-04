import type {
  AccountDto,
  BookingDto,
  ConsolidationDto,
  CustomerCreditDto,
  CustomerDto,
  CustomerInvoiceDto,
  ReceiptDto,
} from '@nolon/shared';
import { randomInt, randomUUID } from 'node:crypto';
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
 * Client decision ب6 (docs/plans/06-client-decisions-v2.md): a customer with a credit limit gets
 * no booking confirmed and no invoice approved over it; drafts are never refused. Posted entries
 * are never deleted, so the users are LEDGER users, every customer is this run's own and every
 * document is dated in a random year of this suite's range (2001-2024).
 */
describe('credit limit (ب6)', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let cashUsd: AccountDto;
  const year = String(randomInt(2001, 2025));
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const cookies = { admin: '', financePts: '', salesPts: '', opsJed: '', warehouseJed: '' };

  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  let sdpzu = '';
  let sdkrt = '';
  let sajed = '';

  async function newCustomer(limit: string | null, currency: string | null = 'USD') {
    const made = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Credit ${year} ${randomUUID().slice(0, 8)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    if (limit !== null) {
      await t.prisma.customer.update({
        where: { id: made.id },
        data: { creditLimit: limit, creditLimitCurrency: currency },
      });
    }
    return made;
  }

  async function draftBooking(customerId: string): Promise<BookingDto> {
    return (
      await post('/bookings', cookies.salesPts, {
        customerId,
        originLocationId: sdpzu,
        destinationLocationId: sdkrt,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm: '1', weightKg: '100' }],
      }).expect(201)
    ).body as BookingDto;
  }

  async function shipment(customerId: string): Promise<string> {
    const booking = await draftBooking(customerId);
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  /** A draft invoice of `amount` USD for a new shipment of the customer. */
  async function draftInvoice(customerId: string, amount: string): Promise<CustomerInvoiceDto> {
    const draft = (
      await post('/customer-invoices', cookies.financePts, {
        shipmentId: await shipment(customerId),
      }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      currency: 'USD',
      invoiceDate: d('03-01'),
      dueDate: d('03-01'),
      repriced: true,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: amount }],
    }).expect(200);
    return draft;
  }

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const approve = (id: string) => post(`/customer-invoices/${id}/approve`, cookies.financePts);

  async function receipt(customerId: string, amount: string, invoiceId?: string) {
    return (
      await post('/receipts', cookies.financePts, {
        customerId,
        receiptDate: d('03-02'),
        currency: 'USD',
        amount,
        cashAccountId: cashUsd.id,
        allocations: invoiceId ? [{ invoiceId, amount }] : [],
      }).expect(201)
    ).body as ReceiptDto;
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    sdpzu = await loc('SDPZU');
    sdkrt = await loc('SDKRT');
    sajed = await loc('SAJED');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
      warehouseJed: await createUser(t.prisma, ['WAREHOUSE'], ['JED'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    cashUsd = (
      await post('/accounting/accounts', cookies.admin, {
        code: `CL${suffix}`,
        nameEn: 'Credit limit test cash USD',
        nameAr: 'نقدية اختبار حد الائتمان',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'USD',
        branchId: pts,
      }).expect(201)
    ).body as AccountDto;
  });

  afterAll(async () => {
    await t.close();
  });

  it('checks nothing for a customer without a limit', async () => {
    const customer = await newCustomer(null);
    const big = await draftInvoice(customer.id, '1000000');
    await approve(big.id).expect(200);
    // Another booking confirms with that open balance.
    await shipment(customer.id);
  });

  it('refuses an approval that takes the balance over the limit, and leaves the draft as it was', async () => {
    const customer = await newCustomer('500');
    const invoice = await draftInvoice(customer.id, '600');
    const refused = await approve(invoice.id).expect(409);
    expect(refused.body).toMatchObject({
      code: 'CREDIT_LIMIT_EXCEEDED',
      params: { customer: customer.name, balance: '600', limit: '500', currency: 'USD' },
    });
    const row = await t.prisma.customerInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row).toMatchObject({ status: 'DRAFT', number: null, journalEntryId: null });
    // An advance of 100 brings it to 500: at the limit is allowed (over means greater).
    await receipt(customer.id, '100');
    const approved = (await approve(invoice.id).expect(200)).body as CustomerInvoiceDto;
    expect(approved.status).toBe('APPROVED');
  });

  it('refuses a confirmation while the balance is over the limit; draft bookings and invoices are still made', async () => {
    const customer = await newCustomer('1000');
    const first = await draftInvoice(customer.id, '900');
    await approve(first.id).expect(200);
    // Lowering the limit is a correction, never refused; it leaves the customer over it.
    await t.prisma.customer.update({ where: { id: customer.id }, data: { creditLimit: '800' } });
    const booking = await draftBooking(customer.id);
    const refused = await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(409);
    expect(refused.body).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });
    const row = await t.prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { shipment: true },
    });
    expect(row.status).toBe('DRAFT');
    expect(row.shipment).toBeNull();
    // Paying 100 of the invoice brings the balance to the limit: the confirmation goes through.
    await receipt(customer.id, '100', first.id);
    await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200);
  });

  it('treats a zero limit as cash: paid in advance first, then approved', async () => {
    const customer = await newCustomer('0');
    const invoice = await draftInvoice(customer.id, '250');
    await approve(invoice.id).expect(409);
    const advance = await receipt(customer.id, '250');
    await approve(invoice.id).expect(200);
    // Cancelling the receipt is never refused, and leaves the customer over the limit.
    await post(`/receipts/${advance.id}/cancel`, cookies.financePts, {
      reason: 'Bounced cheque',
    }).expect(200);
    const booking = await draftBooking(customer.id);
    await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(409);
  });

  it('refuses when a rate it needs is missing, rather than pass for want of data', async () => {
    const code = 'ZQC';
    await t.prisma.currency.upsert({
      where: { code },
      update: {},
      create: { code, nameEn: 'Credit test currency', nameAr: 'عملة اختبار' },
    });
    await t.prisma.fxRate.deleteMany({ where: { currency: code } });
    const customer = await newCustomer('1000000', code);
    const invoice = await draftInvoice(customer.id, '10');
    const refused = await approve(invoice.id).expect(409);
    expect(refused.body).toMatchObject({
      code: 'CREDIT_LIMIT_NO_RATE',
      params: { currency: code },
    });
  });

  it('lets one of two concurrent approvals through when together they pass the limit', async () => {
    const customer = await newCustomer('500');
    const a = await draftInvoice(customer.id, '300');
    const b = await draftInvoice(customer.id, '300');
    const results = await Promise.all([approve(a.id), approve(b.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const approved = await t.prisma.customerInvoice.count({
      where: { customerId: customer.id, status: 'APPROVED' },
    });
    expect(approved).toBe(1);
  });

  it('refuses a booking made inside a container over the limit, leaving nothing behind', async () => {
    // Over the limit: an invoice approved before the limit was set.
    const customer = await newCustomer(null);
    await approve((await draftInvoice(customer.id, '150')).id).expect(200);
    await t.prisma.customer.update({
      where: { id: customer.id },
      data: { creditLimit: '100', creditLimitCurrency: 'USD' },
    });
    const container = (
      await post('/consolidations', cookies.opsJed, {
        branchId: jed,
        originLocationId: sajed,
        destinationLocationId: sdpzu,
        containerTypeCode: '40HC',
        vesselName: 'Credit Test',
        shipmentIds: [],
      }).expect(201)
    ).body as ConsolidationDto;
    const before = await t.prisma.booking.count({ where: { customerId: customer.id } });
    const refused = await post(`/consolidations/${container.id}/bookings`, cookies.opsJed, {
      customerId: customer.id,
      destinationLocationId: sdpzu,
      cargoType: 'GENERAL',
      services: ['CUSTOMS'],
      items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '10', volumeCbm: '0.5' }],
    }).expect(409);
    expect(refused.body).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });
    expect(await t.prisma.booking.count({ where: { customerId: customer.id } })).toBe(before);
    expect(
      await t.prisma.consolidationShipment.count({ where: { consolidationId: container.id } }),
    ).toBe(0);
  });

  it('shows the position on screens, with a draft as its approval would see it', async () => {
    const customer = await newCustomer('500');
    const draft = await draftInvoice(customer.id, '600');
    const now = (await get(`/customer-credit/${customer.id}`, cookies.financePts).expect(200))
      .body as CustomerCreditDto;
    expect(now).toEqual({
      customerId: customer.id,
      state: 'WITHIN',
      balance: '0',
      limit: '500',
      currency: 'USD',
      missingRateCurrency: null,
    });
    const after = (
      await get(`/customer-credit/${customer.id}?invoiceId=${draft.id}`, cookies.financePts).expect(
        200,
      )
    ).body as CustomerCreditDto;
    expect(after).toMatchObject({ state: 'EXCEEDED', balance: '600' });
    // Another customer's draft, an unknown one, a bad query; no invoice view permission: 403.
    const other = await newCustomer(null);
    await get(`/customer-credit/${other.id}?invoiceId=${draft.id}`, cookies.financePts).expect(404);
    await get(`/customer-credit/${randomUUID()}`, cookies.financePts).expect(404);
    await get(`/customer-credit/${customer.id}?x=1`, cookies.financePts).expect(400);
    await get(`/customer-credit/${customer.id}`, cookies.warehouseJed).expect(403);
    const none = (await get(`/customer-credit/${other.id}`, cookies.financePts).expect(200))
      .body as CustomerCreditDto;
    expect(none.state).toBe('NO_LIMIT');
  });

  it('still records an opening item over the limit (debt from before the system)', async () => {
    const customer = await newCustomer('10');
    await post('/customer-invoices/opening', cookies.admin, {
      requestId: randomUUID(),
      customerId: customer.id,
      branchId: pts,
      entryDate: d('01-01'),
      reference: 'OLD-CREDIT',
      invoiceDate: d('01-01'),
      dueDate: d('01-31'),
      currency: 'USD',
      amount: '5000',
    }).expect(201);
    const booking = await draftBooking(customer.id);
    await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(409);
  });
});
