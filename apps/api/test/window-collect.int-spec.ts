import { randomUUID } from 'node:crypto';
import type {
  AccountDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  WindowCashAccountDto,
  WindowDeskBookingDto,
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
 * Plan 13 section 4: the window takes the customer's money. The accountant gives the window a cash
 * account per currency; the payment approves the booking's pro forma invoice (owner, 2026-11-05)
 * and posts a receipt into that account, allocated by the server, never over what is owed.
 * Negative cases: no cash account, over the balance, nothing owed, a reused request id, another
 * window's booking, staff without the permission, the switch off. Posted entries are never
 * deleted, so every user is a LEDGER user and every customer this run's own.
 */
describe('Window collects the money (plan 13 section 4)', () => {
  let on: TestApp;
  let off: TestApp;
  let pts = '';
  const tag = `WC${randomUUID().slice(0, 5).toUpperCase()}`;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let cash: AccountDto;
  const today = new Date().toISOString().slice(0, 10);

  const as = (t: TestApp, cookie: string) => ({
    get: (path: string) => t.http().get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    patch: (path: string, body: object) =>
      t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    put: (path: string, body: object) =>
      t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });

  async function windowOf(name: string): Promise<{ partner: string; window: string }> {
    const partner = await on.prisma.partner.create({
      data: {
        number: `${tag}-${name}`,
        kind: 'SALES_OUTLET',
        branchId: pts,
        name: `${tag} ${name}`,
        countryCode: 'SD',
        currency: 'USD',
        createdById: ids.admin!,
      },
    });
    const window = await on.prisma.warehouse.create({
      data: {
        branchId: pts,
        code: `${tag}-${name}`,
        nameAr: `نافذة ${name}`,
        nameEn: `Window ${name}`,
        acceptsDropOff: true,
        partnerId: partner.id,
      },
    });
    return { partner: partner.id, window: window.id };
  }

  /** A confirmed booking at `window` with a pro forma MAIN invoice of `amount` USD. */
  async function proForma(
    window: string,
    amount: string,
  ): Promise<{ booking: string; invoice: string }> {
    const sales = as(on, cookies.sales!);
    const booking = (
      await sales
        .post('/bookings', {
          customerId: ids.customer,
          branchId: pts,
          originLocationId: ids.origin,
          destinationLocationId: ids.dest,
          mode: 'ROAD',
          services: ['MAIN_FREIGHT'],
          dropOffWarehouseId: window,
          items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm: '1', weightKg: '100' }],
        })
        .expect(201)
    ).body as BookingDto;
    const confirmed = (await sales.post(`/bookings/${booking.id}/confirm`).expect(200))
      .body as BookingDto;
    const finance = as(on, cookies.finance!);
    const draft = (
      await finance.post('/customer-invoices', { shipmentId: confirmed.shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    await finance
      .patch(`/customer-invoices/${draft.id}`, {
        currency: 'USD',
        invoiceDate: today,
        dueDate: today,
        repriced: true,
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: amount }],
      })
      .expect(200);
    return { booking: booking.id, invoice: draft.id };
  }

  const pay = (
    bookingId: string,
    amount: string,
    extra: object = {},
    t = on,
    cookie = cookies.staff!,
  ) =>
    as(t, cookie).post(`/window-desk/bookings/${bookingId}/payment`, {
      requestId: randomUUID(),
      amount,
      currency: 'USD',
      ...extra,
    });

  beforeAll(async () => {
    on = await createTestApp({ WINDOW_DESK_ENABLED: true, WINDOW_COLLECT_ENABLED: true });
    off = await createTestApp({ WINDOW_DESK_ENABLED: true, WINDOW_COLLECT_ENABLED: false });
    pts = await branchId(on.prisma, 'PTS');
    const loc = async (code: string) =>
      (await on.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    ids.origin = await loc('SDPZU');
    ids.dest = await loc('SDKRT');
    const admin = await createUser(on.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    ids.admin = admin.id;
    cookies.admin = await signIn(on, admin.email);
    const sales = await createUser(on.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    cookies.sales = await signIn(on, sales.email);
    const finance = await createUser(on.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX);
    cookies.finance = await signIn(on, finance.email);
    ids.customer = (
      (
        await as(on, cookies.sales)
          .post('/customers', {
            branchId: pts,
            kind: 'COMPANY',
            name: `${tag} customer`,
            phone: uniquePhone(),
            preferredCurrency: 'USD',
          })
          .expect(201)
      ).body as CustomerDto
    ).id;
    const a = await windowOf('A');
    const b = await windowOf('B');
    ids.windowA = a.window;
    ids.windowB = b.window;
    const staff = await createUser(on.prisma, ['OUTLET_STAFF'], ['PTS'], LEDGER_PREFIX);
    await on.prisma.userPartner.create({ data: { userId: staff.id, partnerId: a.partner } });
    ids.staff = staff.id;
    cookies.staff = await signIn(on, staff.email);
    cookies.staffOff = await signIn(off, staff.email);
    const other = await createUser(on.prisma, ['OUTLET_STAFF'], ['PTS'], LEDGER_PREFIX);
    await on.prisma.userPartner.create({ data: { userId: other.id, partnerId: a.partner } });
    cookies.otherStaff = await signIn(on, other.email);
    const account = (code: string, currency: string) =>
      as(on, cookies.admin!)
        .post('/accounting/accounts', {
          code,
          nameEn: `Cash at window ${code}`,
          nameAr: 'نقدية لدى نافذة',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency,
          branchId: pts,
        })
        .expect(201);
    cash = (await account(`${tag}U`, 'USD')).body as AccountDto;
    ids.sarCash = ((await account(`${tag}S`, 'SAR')).body as AccountDto).id;
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
  });

  it('lets the accountant give the window a cash account per currency, checked', async () => {
    const path = `/warehouses/${ids.windowA}/cash-accounts`;
    // Sales has no chart of accounts rights; the outlet reaches no staff route.
    await as(on, cookies.sales!).put(`${path}/USD`, { accountId: cash.id }).expect(403);
    await as(on, cookies.staff!).put(`${path}/USD`, { accountId: cash.id }).expect(403);
    // The account must hold the currency.
    await as(on, cookies.admin!).put(`${path}/USD`, { accountId: ids.sarCash }).expect(400);
    const set = (
      await as(on, cookies.admin!).put(`${path}/USD`, { accountId: cash.id }).expect(200)
    ).body as WindowCashAccountDto[];
    expect(set).toEqual([expect.objectContaining({ currency: 'USD', accountId: cash.id })]);
    // One account serves one window.
    const taken = await as(on, cookies.admin!)
      .put(`/warehouses/${ids.windowB}/cash-accounts/USD`, { accountId: cash.id })
      .expect(409);
    expect(taken.body).toMatchObject({ code: 'WINDOW_CASH_ACCOUNT_TAKEN' });
    const audit = await on.prisma.auditEvent.findFirst({
      where: { entity: 'WAREHOUSE', entityId: ids.windowA },
      orderBy: { id: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('approves the pro forma and posts the receipt into the window cash account', async () => {
    const { booking, invoice } = await proForma(ids.windowA!, '100');
    const requestId = randomUUID();
    const read = (await pay(booking, '40', { requestId, reference: 'CASH-1' }).expect(201))
      .body as WindowDeskBookingDto;
    expect(read.invoice).toMatchObject({ status: 'APPROVED', total: '100', balance: '60' });
    expect(read.todo).toContain('collect');
    expect(read.payments).toEqual([
      expect.objectContaining({
        id: requestId,
        amount: '40',
        currency: 'USD',
        reference: 'CASH-1',
        invoices: [expect.objectContaining({ amount: '40' })],
      }),
    ]);
    const approved = await on.prisma.customerInvoice.findUniqueOrThrow({ where: { id: invoice } });
    expect(approved).toMatchObject({
      status: 'APPROVED',
      approvalSource: 'WINDOW_PAYMENT',
      approvedById: null,
      autoInitiatedById: ids.staff,
      autoRule: null,
    });
    expect(approved.paidAmount.toFixed()).toBe('40');
    const shown = (await as(on, cookies.finance!).get(`/customer-invoices/${invoice}`).expect(200))
      .body as CustomerInvoiceDto;
    expect(shown.windowApproval).toEqual({ initiatedByName: expect.any(String) as unknown });
    expect(shown.autoApproval).toBeNull();
    const receipt = await on.prisma.receipt.findUniqueOrThrow({ where: { id: requestId } });
    expect(receipt).toMatchObject({
      cashAccountId: cash.id,
      branchId: pts,
      createdById: ids.staff,
    });
    ids.paid = booking;
    ids.paidRequest = requestId;
  });

  it('answers a retry with the same payment, and refuses the id reused for another', async () => {
    const again = await pay(ids.paid!, '40', {
      requestId: ids.paidRequest,
      reference: 'CASH-1',
    }).expect(201);
    expect((again.body as WindowDeskBookingDto).payments).toHaveLength(1);
    await pay(ids.paid!, '41', { requestId: ids.paidRequest, reference: 'CASH-1' }).expect(409);
    expect(await on.prisma.receipt.count({ where: { id: ids.paidRequest } })).toBe(1);
  });

  it('never takes more than is owed, and nothing once paid', async () => {
    const over = await pay(ids.paid!, '60.01').expect(409);
    expect(over.body).toMatchObject({
      code: 'WINDOW_OVER_BALANCE',
      params: { balance: '60', currency: 'USD' },
    });
    const done = (await pay(ids.paid!, '60').expect(201)).body as WindowDeskBookingDto;
    expect(done.invoice?.balance).toBe('0');
    expect(done.todo).not.toContain('collect');
    expect(done.payments).toHaveLength(2);
    const nothing = await pay(ids.paid!, '1').expect(409);
    expect(nothing.body).toMatchObject({ code: 'WINDOW_NOTHING_TO_COLLECT' });
  });

  it('refuses a currency the window has no cash account for, changing nothing', async () => {
    const { booking, invoice } = await proForma(ids.windowA!, '50');
    const refused = await pay(booking, '10', { currency: 'SAR' }).expect(409);
    expect(refused.body).toMatchObject({
      code: 'WINDOW_NO_CASH_ACCOUNT',
      params: { currency: 'SAR' },
    });
    const still = await on.prisma.customerInvoice.findUniqueOrThrow({ where: { id: invoice } });
    expect(still.status).toBe('DRAFT');
  });

  it('pays MAIN first, then additional invoices by date and number, in the currency only', async () => {
    const { booking } = await proForma(ids.windowA!, '100');
    const shipment = await on.prisma.shipment.findUniqueOrThrow({ where: { bookingId: booking } });
    const finance = as(on, cookies.finance!);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    // A rate for the SAR invoice's approval; one the run may already have is kept.
    await on.prisma.fxRate.upsert({
      where: { currency_rateDate: { currency: 'SAR', rateDate: new Date(today) } },
      create: { currency: 'SAR', rateDate: new Date(today), rate: '3.75', createdById: ids.admin! },
      update: {},
    });
    async function additional(currency: string, date: string, amount: string): Promise<string> {
      const draft = (
        await finance
          .post('/customer-invoices', { shipmentId: shipment.id, kind: 'ADDITIONAL' })
          .expect(201)
      ).body as CustomerInvoiceDto;
      await finance
        .patch(`/customer-invoices/${draft.id}`, {
          currency,
          invoiceDate: date,
          dueDate: today,
          repriced: true,
          lines: [{ chargeTypeCode: 'DOCS', quantity: '1', unitPrice: amount }],
        })
        .expect(200);
      await finance.post(`/customer-invoices/${draft.id}/approve`).expect(200);
      return draft.id;
    }
    // Made in another order than they are paid: the later one first.
    const later = await additional('USD', today, '20');
    const earlier = await additional('USD', yesterday, '30');
    const sar = await additional('SAR', today, '50');
    const requestId = randomUUID();
    await pay(booking, '140', { requestId }).expect(201);
    const main = await on.prisma.customerInvoice.findFirstOrThrow({
      where: { shipmentId: shipment.id, kind: 'MAIN' },
    });
    const allocations = await on.prisma.receiptAllocation.findMany({
      where: { receiptId: requestId },
    });
    expect(Object.fromEntries(allocations.map((a) => [a.invoiceId, a.amount.toFixed()]))).toEqual({
      [main.id]: '100',
      [earlier]: '30',
      [later]: '10',
    });
    const untouched = await on.prisma.customerInvoice.findUniqueOrThrow({ where: { id: sar } });
    expect(untouched.paidAmount.toFixed()).toBe('0');
    // The rest owed in USD is the later invoice's 10; the SAR invoice is not counted.
    const over = await pay(booking, '10.01').expect(409);
    expect(over.body).toMatchObject({ params: { balance: '10', currency: 'USD' } });
  });

  it('posts one receipt for the same request sent twice at once; another user may not reuse it', async () => {
    const { booking } = await proForma(ids.windowA!, '25');
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      pay(booking, '25', { requestId }),
      pay(booking, '25', { requestId }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await on.prisma.receipt.count({ where: { id: requestId } })).toBe(1);
    const read = second.body as WindowDeskBookingDto;
    expect(read.payments).toHaveLength(1);
    await pay(booking, '25', { requestId }, on, cookies.otherStaff).expect(409);
  });

  it('lets two payments race over one balance: one is posted, the other refused', async () => {
    const { booking } = await proForma(ids.windowA!, '30');
    const [first, second] = await Promise.all([pay(booking, '30'), pay(booking, '30')]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body).toMatchObject({ code: 'WINDOW_NOTHING_TO_COLLECT' });
    const read = (await as(on, cookies.staff!).get(`/window-desk/bookings/${booking}`).expect(200))
      .body as WindowDeskBookingDto;
    expect(read.payments).toHaveLength(1);
    expect(read.invoice?.balance).toBe('0');
  });

  it("refuses another window's booking, staff without the permission and the switch off", async () => {
    const atB = await proForma(ids.windowB!, '20');
    await pay(atB.booking, '5').expect(404);
    const mine = await proForma(ids.windowA!, '20');
    await pay(mine.booking, '5', {}, on, cookies.sales).expect(403);
    await pay(mine.booking, '5', {}, off, cookies.staffOff).expect(404);
    const untouched = await on.prisma.customerInvoice.findUniqueOrThrow({
      where: { id: mine.invoice },
    });
    expect(untouched.status).toBe('DRAFT');
  });
});
