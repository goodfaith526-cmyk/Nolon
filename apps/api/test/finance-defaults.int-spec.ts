import type {
  AccountDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  ReceiptAllocationSuggestionDto,
  ShipmentPickPage,
  SupplierBillDto,
  SupplierDto,
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
 * Functional review, group C: the values finance screens start from. A supplier bill's due date
 * from the supplier's terms (C1), a receipt's split over open invoices (C3), an account's type
 * from its parent (C7) and finding a shipment by its exact number (C10). Invoices are approved
 * (posted entries are kept), so these are LEDGER users and dates are in a random past year.
 */
describe('finance defaults (functional review C1, C3, C7, C10)', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  let supplier: SupplierDto;
  let cashSdg: AccountDto;
  const year = randomInt(1901, 2000);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const cookies = { admin: '', financePts: '', financeJed: '', salesPts: '', opsPts: '' };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  async function shipment(): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  /** An approved invoice of `price` in `currency`, dated `monthDay`. */
  async function approvedInvoice(
    monthDay: string,
    price: string,
    currency = 'SDG',
  ): Promise<CustomerInvoiceDto> {
    const draft = (
      await post('/customer-invoices', cookies.financePts, {
        shipmentId: await shipment(),
      }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      currency,
      fxRate: currency === 'USD' ? null : '600',
      invoiceDate: d(monthDay),
      dueDate: d(monthDay),
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: price }],
      // The draft starts in the customer's currency; another one is priced afresh (group A).
      repriced: true,
    }).expect(200);
    return (await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as CustomerInvoiceDto;
  }

  const billBody = (overrides: object = {}) => ({
    requestId: randomUUID(),
    supplierId: supplier.id,
    branchId: pts,
    currency: 'SDG',
    fxRate: '600',
    billDate: d('04-10'),
    lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '1000' }],
    ...overrides,
  });

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger C ${suffix}`,
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
    supplier = (
      await post('/suppliers', cookies.financePts, {
        name: `LGC Supplier ${suffix}`,
        paymentTermsDays: 45,
      }).expect(201)
    ).body as SupplierDto;
    cashSdg = (
      await post('/accounting/accounts', cookies.admin, {
        code: `C${suffix}S`,
        nameEn: 'Test cash PTS (SDG)',
        nameAr: 'نقدية اختبار',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'SDG',
        branchId: pts,
      }).expect(201)
    ).body as AccountDto;
    await put('/accounting/fx-rates', cookies.financePts, {
      currency: 'SDG',
      rateDate: d('01-01'),
      rate: '600',
    }).expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('C1: a supplier bill is due after the supplier payment terms', () => {
    it('generates the due date when none is sent, and keeps one that is', async () => {
      const generated = (await post('/supplier-bills', cookies.financePts, billBody()).expect(201))
        .body as SupplierBillDto;
      // 45 days of terms after 10 April.
      expect(generated.dueDate).toBe(d('05-25'));

      const explicit = (
        await post('/supplier-bills', cookies.financePts, billBody({ dueDate: d('04-12') })).expect(
          201,
        )
      ).body as SupplierBillDto;
      expect(explicit.dueDate).toBe(d('04-12'));

      const nulled = (
        await post('/supplier-bills', cookies.financePts, billBody({ dueDate: null })).expect(201)
      ).body as SupplierBillDto;
      expect(nulled.dueDate).toBe(d('05-25'));

      // An explicit due date before the bill date is still refused.
      await post('/supplier-bills', cookies.financePts, billBody({ dueDate: d('04-09') })).expect(
        400,
      );
    });

    it('treats an exact retry without a due date as the same request', async () => {
      const body = billBody();
      const first = (await post('/supplier-bills', cookies.financePts, body).expect(201))
        .body as SupplierBillDto;
      const again = (await post('/supplier-bills', cookies.financePts, body).expect(201))
        .body as SupplierBillDto;
      expect(again.id).toBe(first.id);
      // Naming a different due date under the same request id is another request.
      await post('/supplier-bills', cookies.financePts, { ...body, dueDate: d('04-11') }).expect(
        409,
      );
    });

    it('returns the first bill on an exact retry after the supplier terms changed (F94-3)', async () => {
      const body = billBody();
      const first = (await post('/supplier-bills', cookies.financePts, body).expect(201))
        .body as SupplierBillDto;
      await t.prisma.supplier.update({
        where: { id: supplier.id },
        data: { paymentTermsDays: 60 },
      });
      try {
        const again = (await post('/supplier-bills', cookies.financePts, body).expect(201))
          .body as SupplierBillDto;
        expect(again).toMatchObject({ id: first.id, dueDate: d('05-25') });
        // The saved date sent explicitly is the same request; another one is not.
        await post('/supplier-bills', cookies.financePts, {
          ...body,
          dueDate: d('05-25'),
        }).expect(201);
        await post('/supplier-bills', cookies.financePts, {
          ...body,
          dueDate: d('06-09'),
        }).expect(409);
      } finally {
        await t.prisma.supplier.update({
          where: { id: supplier.id },
          data: { paymentTermsDays: 45 },
        });
      }
    });

    it('moves a generated due date with the bill date on edit; an explicit one is kept', async () => {
      const draft = (await post('/supplier-bills', cookies.financePts, billBody()).expect(201))
        .body as SupplierBillDto;
      const input = {
        branchId: pts,
        currency: 'SDG',
        fxRate: '600',
        lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '1000' }],
      };
      const moved = (
        await patch(`/supplier-bills/${draft.id}`, cookies.financePts, {
          ...input,
          billDate: d('06-01'),
        }).expect(200)
      ).body as SupplierBillDto;
      expect(moved.dueDate).toBe(d('07-16'));
      const kept = (
        await patch(`/supplier-bills/${draft.id}`, cookies.financePts, {
          ...input,
          billDate: d('06-01'),
          dueDate: d('06-30'),
        }).expect(200)
      ).body as SupplierBillDto;
      expect(kept.dueDate).toBe(d('06-30'));
    });

    it('uses no terms as the bill date, and still checks the branch', async () => {
      const cash = (
        await post('/suppliers', cookies.financePts, { name: `LGC Cash ${randomUUID()}` }).expect(
          201,
        )
      ).body as SupplierDto;
      const bill = (
        await post('/supplier-bills', cookies.financePts, billBody({ supplierId: cash.id })).expect(
          201,
        )
      ).body as SupplierBillDto;
      expect(bill.dueDate).toBe(d('04-10'));
      await post('/supplier-bills', cookies.financeJed, billBody()).expect(403);
    });
  });

  describe('C3: a receipt split over open invoices, oldest first', () => {
    let older: CustomerInvoiceDto;
    let newer: CustomerInvoiceDto;
    let paidPart: CustomerInvoiceDto;

    beforeAll(async () => {
      // Created out of date order: the split follows the invoice date, not creation.
      newer = await approvedInvoice('03-10', '1000');
      older = await approvedInvoice('03-05', '500.5');
      paidPart = await approvedInvoice('03-01', '300');
      await approvedInvoice('03-02', '700', 'USD');
      await post('/receipts', cookies.financePts, {
        customerId: customer.id,
        receiptDate: d('03-15'),
        currency: 'SDG',
        amount: '200',
        cashAccountId: cashSdg.id,
        allocations: [{ invoiceId: paidPart.id, amount: '200' }],
      }).expect(201);
    });

    const suggest = (amount: string, cookie = cookies.financePts, currency = 'SDG') =>
      get(
        `/receipts/allocation-suggestion?customerId=${customer.id}&currency=${currency}&amount=${amount}`,
        cookie,
      );

    it('pays each invoice up to its balance until the amount runs out', async () => {
      const part = (await suggest('900').expect(200)).body as ReceiptAllocationSuggestionDto;
      expect(part).toMatchObject({ currency: 'SDG', amount: '900', unallocated: '0' });
      expect(part.allocations).toEqual([
        expect.objectContaining({ invoiceId: paidPart.id, balance: '100', amount: '100' }),
        expect.objectContaining({ invoiceId: older.id, balance: '500.5', amount: '500.5' }),
        expect.objectContaining({ invoiceId: newer.id, balance: '1000', amount: '299.5' }),
      ]);

      const more = (await suggest('2000').expect(200)).body as ReceiptAllocationSuggestionDto;
      expect(more.allocations.map((a) => a.amount)).toEqual(['100', '500.5', '1000']);
      expect(more.unallocated).toBe('399.5');

      const usd = (await suggest('1000', cookies.financePts, 'USD').expect(200))
        .body as ReceiptAllocationSuggestionDto;
      expect(usd.allocations.map((a) => a.amount)).toEqual(['700']);
    });

    it('refuses another branch, a missing permission and a bad amount', async () => {
      await suggest('100', cookies.financeJed).expect(404);
      await suggest('100', cookies.salesPts).expect(403);
      await suggest('0').expect(400);
      await suggest('1.001').expect(400);
      await suggest('abc').expect(400);
    });
  });

  describe('C7: an account under a parent takes its type', () => {
    const code = () => `C7${randomUUID().slice(0, 6).toUpperCase()}`;
    const account = (body: object) => ({
      code: code(),
      nameEn: 'C7 test',
      nameAr: 'اختبار',
      isPostable: true,
      ...body,
    });

    it('fills the type from the parent and refuses a different one', async () => {
      const header = (
        await post(
          '/accounting/accounts',
          cookies.admin,
          account({ type: 'EXPENSE', isPostable: false }),
        ).expect(201)
      ).body as AccountDto;
      const child = (
        await post('/accounting/accounts', cookies.admin, account({ parentId: header.id })).expect(
          201,
        )
      ).body as AccountDto;
      expect(child.type).toBe('EXPENSE');
      await post(
        '/accounting/accounts',
        cookies.admin,
        account({ parentId: header.id, type: 'ASSET' }),
      ).expect(400);
      // A cash account is still an asset, whatever its parent gives.
      await post(
        '/accounting/accounts',
        cookies.admin,
        account({ parentId: header.id, isCash: true, currency: 'SDG' }),
      ).expect(400);
      // On edit too: the type left out is the parent's.
      const edited = (
        await patch(`/accounting/accounts/${child.id}`, cookies.admin, {
          code: child.code,
          nameEn: 'C7 renamed',
          nameAr: child.nameAr,
          parentId: header.id,
          isPostable: true,
        }).expect(200)
      ).body as AccountDto;
      expect(edited).toMatchObject({ type: 'EXPENSE', nameEn: 'C7 renamed' });
    });

    it('needs the type of a root account, and keeps the cash rules', async () => {
      await post('/accounting/accounts', cookies.admin, account({})).expect(400);
      const assets = (
        await post(
          '/accounting/accounts',
          cookies.admin,
          account({ type: 'ASSET', isPostable: false }),
        ).expect(201)
      ).body as AccountDto;
      const cash = (
        await post(
          '/accounting/accounts',
          cookies.admin,
          account({ parentId: assets.id, isCash: true, currency: 'SDG' }),
        ).expect(201)
      ).body as AccountDto;
      expect(cash).toMatchObject({ type: 'ASSET', isCash: true });
      await post(
        '/accounting/accounts',
        cookies.admin,
        account({ parentId: assets.id, isCash: true, currency: 'SDG', isPostable: false }),
      ).expect(400);
      // Missing permission.
      await post('/accounting/accounts', cookies.financePts, account({ type: 'ASSET' })).expect(
        403,
      );
    });
  });

  describe('C10: a shipment is found by its exact number', () => {
    let wanted: { id: string; number: string };

    beforeAll(async () => {
      const id = await shipment();
      const row = await t.prisma.shipment.findUniqueOrThrow({ where: { id } });
      wanted = { id, number: row.number };
    });

    const pick = (query: string, cookie = cookies.financePts) =>
      get(`/shipments/pick?${query}`, cookie);

    it('puts the exact match apart, however many others match', async () => {
      const page = (
        await pick(
          `branchId=${pts}&pageSize=1&q=${encodeURIComponent(wanted.number.toLowerCase())}`,
        ).expect(200)
      ).body as ShipmentPickPage;
      expect(page.exact?.id).toBe(wanted.id);
      expect(page.items.some((s) => s.id === wanted.id)).toBe(false);

      // Its prefix matches many: they page by number, the exact one is not among them.
      const prefix = wanted.number.slice(0, -1);
      const first = (
        await pick(`branchId=${pts}&pageSize=2&q=${encodeURIComponent(prefix)}`).expect(200)
      ).body as ShipmentPickPage;
      expect(first.exact).toBeNull();
      expect(first.items.length).toBeLessThanOrEqual(2);
      const numbers = first.items.map((s) => s.number);
      expect([...numbers].sort()).toEqual(numbers);
    });

    it('does not find a shipment of another branch, nor a cancelled one', async () => {
      const q = encodeURIComponent(wanted.number);
      // A Jeddah user searching Jeddah does not see the Port Sudan shipment.
      const other = (await pick(`branchId=${jed}&q=${q}`, cookies.financeJed).expect(200))
        .body as ShipmentPickPage;
      expect(other.exact).toBeNull();
      expect(other.items.some((s) => s.id === wanted.id)).toBe(false);
      // Nor may they search Port Sudan.
      await pick(`branchId=${pts}&q=${q}`, cookies.financeJed).expect(403);
      await pick(`q=${q}`).expect(400);

      const cancelled = await shipment();
      const number = (await t.prisma.shipment.findUniqueOrThrow({ where: { id: cancelled } }))
        .number;
      await post(`/shipments/${cancelled}/cancel`, cookies.opsPts, { reason: 'x' }).expect(200);
      const gone = (await pick(`branchId=${pts}&q=${encodeURIComponent(number)}`).expect(200))
        .body as ShipmentPickPage;
      expect(gone.exact).toBeNull();
      expect(gone.items.some((s) => s.id === cancelled)).toBe(false);
    });
  });
});
