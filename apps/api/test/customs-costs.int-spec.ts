import type {
  BookingDto,
  CustomerDto,
  CustomsBrokerOptionDto,
  ShipmentCustomsDto,
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
 * Group Z2: the customs file links its broker to a supplier and shows the supplier bill lines
 * that are the shipment's customs costs, apart from its fees. Showing them records and posts
 * nothing. Bills are posted and never deleted, so these are LEDGER users and every bill is dated
 * in a random past year; the charge types are this run's own, so no other suite's bills match.
 */
describe('customs file: broker supplier and supplier costs (group Z2)', () => {
  let t: TestApp;
  let pts: string;
  let krt: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  let broker: SupplierDto;
  let otherSupplier: SupplierDto;
  let inactiveSupplier: SupplierDto;
  const year = randomInt(1901, 2000);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  /** A customs charge (service CUSTOMS) and a freight charge (another service), this run's own. */
  const customsCharge = `ZC${tag}`;
  const freightCharge = `ZF${tag}`;
  const cookies = {
    admin: '',
    salesPts: '',
    opsPts: '',
    financePts: '',
    managerPts: '',
    customsPts: '',
    customsJed: '',
    financeKrt: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const del = (path: string, cookie: string) =>
    t.http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);

  const customs = async (shipmentId: string, cookie: string) =>
    (await get(`/shipments/${shipmentId}/customs`, cookie).expect(200)).body as ShipmentCustomsDto;

  /** A confirmed Port Sudan → Khartoum road shipment of Port Sudan. */
  async function shipment(): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT', 'CUSTOMS'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '500' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  /** A draft bill of one shipment cost line; approved unless `approve` is false. */
  async function bill(input: {
    shipmentId: string;
    supplierId: string;
    chargeTypeCode: string;
    amount: string;
    currency?: string;
    branch?: string;
    cookie?: string;
    approve?: boolean;
  }): Promise<SupplierBillDto> {
    const cookie = input.cookie ?? cookies.financePts;
    const draft = (
      await post('/supplier-bills', cookie, {
        requestId: randomUUID(),
        supplierId: input.supplierId,
        branchId: input.branch ?? pts,
        currency: input.currency ?? 'USD',
        billDate: d('04-10'),
        dueDate: d('05-10'),
        lines: [
          {
            kind: 'SHIPMENT_COST',
            shipmentId: input.shipmentId,
            chargeTypeCode: input.chargeTypeCode,
            amount: input.amount,
          },
        ],
      }).expect(201)
    ).body as SupplierBillDto;
    if (input.approve === false) return draft;
    return (await post(`/supplier-bills/${draft.id}/approve`, cookie).expect(200))
      .body as SupplierBillDto;
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    krt = await branchId(t.prisma, 'KRT');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
      customsPts: await createUser(t.prisma, ['CUSTOMS'], ['PTS'], LEDGER_PREFIX),
      customsJed: await createUser(t.prisma, ['CUSTOMS'], ['JED'], LEDGER_PREFIX),
      financeKrt: await createUser(t.prisma, ['FINANCE'], ['KRT'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    for (const [code, service] of [
      [customsCharge, 'CUSTOMS'],
      [freightCharge, 'MAIN_FREIGHT'],
    ] as const) {
      await t.prisma.chargeType.create({
        data: { code, nameEn: `Z2 ${service}`, nameAr: 'رسم اختبار', service },
      });
    }
    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger Z2 ${tag}`,
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
    await put('/accounting/fx-rates', cookies.financePts, {
      currency: 'SDG',
      rateDate: d('01-01'),
      rate: '600',
    }).expect(200);
    const supplier = async (name: string) =>
      (await post('/suppliers', cookies.financePts, { name: `${name} ${tag}` }).expect(201))
        .body as SupplierDto;
    broker = await supplier('Z2 Broker');
    otherSupplier = await supplier('Z2 Shipping Line');
    inactiveSupplier = await supplier('Z2 Old Broker');
    await patch(`/suppliers/${inactiveSupplier.id}`, cookies.financePts, {
      isActive: false,
    }).expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('linking the broker', () => {
    it('lists active suppliers (id and name only) to those who edit the file', async () => {
      const id = await shipment();
      const options = (
        await get(`/shipments/${id}/customs/brokers`, cookies.customsPts).expect(200)
      ).body as CustomsBrokerOptionDto[];
      expect(options).toContainEqual({ id: broker.id, name: broker.name });
      expect(options.map((o) => o.id)).not.toContain(inactiveSupplier.id);
      for (const option of options) expect(Object.keys(option).sort()).toEqual(['id', 'name']);
      // Sales views the file but does not edit it; another branch does not see the shipment.
      await get(`/shipments/${id}/customs/brokers`, cookies.salesPts).expect(403);
      await get(`/shipments/${id}/customs/brokers`, cookies.customsJed).expect(404);
    });

    it('links an active supplier; its name fills an empty broker name, a typed one stays', async () => {
      const id = await shipment();
      const saved = (
        await put(`/shipments/${id}/customs`, cookies.customsPts, {
          status: 'PENDING',
          brokerSupplierId: broker.id,
        }).expect(200)
      ).body as ShipmentCustomsDto;
      expect(saved.clearance).toMatchObject({
        brokerSupplierId: broker.id,
        brokerSupplierName: broker.name,
        brokerName: broker.name,
      });
      const typed = (
        await put(`/shipments/${id}/customs`, cookies.customsPts, {
          status: 'PENDING',
          brokerName: 'Ahmed (desk 4)',
          brokerSupplierId: broker.id,
        }).expect(200)
      ).body as ShipmentCustomsDto;
      expect(typed.clearance).toMatchObject({
        brokerSupplierId: broker.id,
        brokerName: 'Ahmed (desk 4)',
      });
      // Free text only, as before: no supplier.
      const free = (
        await put(`/shipments/${id}/customs`, cookies.customsPts, {
          status: 'PENDING',
          brokerName: 'Independent broker',
        }).expect(200)
      ).body as ShipmentCustomsDto;
      expect(free.clearance).toMatchObject({
        brokerSupplierId: null,
        brokerSupplierName: null,
        brokerName: 'Independent broker',
      });
    });

    it('refuses an inactive or unknown supplier and saves nothing', async () => {
      const id = await shipment();
      await put(`/shipments/${id}/customs`, cookies.customsPts, {
        status: 'PENDING',
        brokerName: 'Typed',
        brokerSupplierId: inactiveSupplier.id,
      }).expect(400);
      await put(`/shipments/${id}/customs`, cookies.customsPts, {
        status: 'PENDING',
        brokerSupplierId: randomUUID(),
      }).expect(404);
      await put(`/shipments/${id}/customs`, cookies.customsPts, {
        status: 'PENDING',
        brokerSupplierId: 'not-a-uuid',
      }).expect(400);
      expect((await customs(id, cookies.customsPts)).clearance).toBeNull();
    });

    it("another branch's user cannot link a broker to the shipment (404)", async () => {
      const id = await shipment();
      await put(`/shipments/${id}/customs`, cookies.customsJed, {
        status: 'PENDING',
        brokerSupplierId: broker.id,
      }).expect(404);
      expect((await customs(id, cookies.customsPts)).clearance).toBeNull();
    });

    it('a broker deactivated after linking stays linked when the file is saved again', async () => {
      const id = await shipment();
      const later = (
        await post('/suppliers', cookies.financePts, { name: `Z2 Later ${tag}` }).expect(201)
      ).body as SupplierDto;
      await put(`/shipments/${id}/customs`, cookies.customsPts, {
        status: 'PENDING',
        brokerSupplierId: later.id,
      }).expect(200);
      await patch(`/suppliers/${later.id}`, cookies.financePts, { isActive: false }).expect(200);
      const resaved = (
        await put(`/shipments/${id}/customs`, cookies.customsPts, {
          status: 'SUBMITTED',
          brokerSupplierId: later.id,
        }).expect(200)
      ).body as ShipmentCustomsDto;
      expect(resaved.clearance).toMatchObject({ status: 'SUBMITTED', brokerSupplierId: later.id });
    });
  });

  describe('supplier costs on the file', () => {
    it('shows customs and broker bill lines apart from the fees, and posts nothing', async () => {
      const id = await shipment();
      await put(`/shipments/${id}/customs`, cookies.customsPts, {
        status: 'PENDING',
        brokerSupplierId: broker.id,
      }).expect(200);
      await post(`/shipments/${id}/customs/fees`, cookies.customsPts, {
        description: 'Port duty',
        amount: '100',
        currency: 'USD',
      }).expect(201);

      // A customs charge from another supplier, a broker's bill for another charge, a draft,
      // an SDG bill: all shown. A freight bill from another supplier is not a customs cost.
      const customsBill = await bill({
        shipmentId: id,
        supplierId: otherSupplier.id,
        chargeTypeCode: customsCharge,
        amount: '250.50',
      });
      const brokerBill = await bill({
        shipmentId: id,
        supplierId: broker.id,
        chargeTypeCode: freightCharge,
        amount: '40',
      });
      const draft = await bill({
        shipmentId: id,
        supplierId: broker.id,
        chargeTypeCode: customsCharge,
        amount: '999',
        approve: false,
      });
      const sdgBill = await bill({
        shipmentId: id,
        supplierId: otherSupplier.id,
        chargeTypeCode: customsCharge,
        amount: '30000',
        currency: 'SDG',
      });
      await bill({
        shipmentId: id,
        supplierId: otherSupplier.id,
        chargeTypeCode: freightCharge,
        amount: '700',
      });
      // Cancelled bills, draft and approved, are left out.
      const cancelledDraft = await bill({
        shipmentId: id,
        supplierId: broker.id,
        chargeTypeCode: customsCharge,
        amount: '11',
        approve: false,
      });
      await post(`/supplier-bills/${cancelledDraft.id}/cancel`, cookies.financePts, {
        reason: 'Duplicate',
      }).expect(200);
      const cancelledApproved = await bill({
        shipmentId: id,
        supplierId: broker.id,
        chargeTypeCode: customsCharge,
        amount: '22',
      });
      await post(`/supplier-bills/${cancelledApproved.id}/cancel`, cookies.financePts, {
        reason: 'Wrong shipment',
      }).expect(200);

      const entries = await t.prisma.journalEntry.count();
      const file = await customs(id, cookies.financePts);
      expect(file.showsCost).toBe(true);
      // The fees and their totals are the fees only, as before.
      expect(file.fees.map((f) => [f.description, f.amount, f.currency])).toEqual([
        ['Port duty', '100', 'USD'],
      ]);
      expect(file.totals).toEqual([{ currency: 'USD', amount: '100' }]);
      expect(
        file.costLines?.map((l) => [l.billId, l.billStatus, l.amount, l.currency, l.fromBroker]),
      ).toEqual(
        expect.arrayContaining([
          [customsBill.id, 'APPROVED', '250.5', 'USD', false],
          [brokerBill.id, 'APPROVED', '40', 'USD', true],
          [draft.id, 'DRAFT', '999', 'USD', true],
          [sdgBill.id, 'APPROVED', '30000', 'SDG', false],
        ]),
      );
      expect(file.costLines).toHaveLength(4);
      expect(file.costLines?.find((l) => l.billId === draft.id)?.billNumber).toBeNull();
      expect(file.costLines?.find((l) => l.billId === customsBill.id)).toMatchObject({
        billNumber: customsBill.number,
        supplierName: otherSupplier.name,
        chargeTypeCode: customsCharge,
        billDate: d('04-10'),
      });
      // Approved lines only, per currency; never added to the fees.
      expect(file.costTotals).toEqual([
        { currency: 'USD', amount: '290.5' },
        { currency: 'SDG', amount: '30000' },
      ]);

      // Reading the file and saving it with its broker posts nothing and records no cost.
      const bills = await t.prisma.supplierBill.count();
      await put(`/shipments/${id}/customs`, cookies.customsPts, {
        status: 'SUBMITTED',
        brokerSupplierId: broker.id,
      }).expect(200);
      await customs(id, cookies.managerPts);
      expect(await t.prisma.journalEntry.count()).toBe(entries);
      expect(await t.prisma.supplierBill.count()).toBe(bills);
      expect(await t.prisma.customsFee.count({ where: { shipmentId: id } })).toBe(1);
    });

    it('hides costs from users without shipment profitability', async () => {
      const id = await shipment();
      await bill({
        shipmentId: id,
        supplierId: otherSupplier.id,
        chargeTypeCode: customsCharge,
        amount: '75',
      });
      for (const cookie of [cookies.customsPts, cookies.salesPts]) {
        const file = await customs(id, cookie);
        expect(file).toMatchObject({ showsCost: false, costLines: null, costTotals: null });
      }
      const manager = await customs(id, cookies.managerPts);
      expect(manager.showsCost).toBe(true);
      expect(manager.costLines).toHaveLength(1);
    });

    it("unlinking the broker drops its other bills; another branch's bills never show", async () => {
      const id = await shipment();
      await patch(`/shipments/${id}`, cookies.opsPts, { sharedBranchIds: [krt] }).expect(200);
      await put(`/shipments/${id}/customs`, cookies.customsPts, {
        status: 'PENDING',
        brokerSupplierId: broker.id,
      }).expect(200);
      const ptsBill = await bill({
        shipmentId: id,
        supplierId: broker.id,
        chargeTypeCode: freightCharge,
        amount: '60',
      });
      // Khartoum works on the shipment and has its own customs bill for it.
      const krtBill = await bill({
        shipmentId: id,
        supplierId: otherSupplier.id,
        chargeTypeCode: customsCharge,
        amount: '80',
        branch: krt,
        cookie: cookies.financeKrt,
      });

      const ptsView = await customs(id, cookies.managerPts);
      expect(ptsView.costLines?.map((l) => l.billId)).toEqual([ptsBill.id]);
      const krtView = await customs(id, cookies.financeKrt);
      expect(krtView.costLines?.map((l) => l.billId)).toEqual([krtBill.id]);
      const adminView = await customs(id, cookies.admin);
      expect(adminView.costLines?.map((l) => l.billId).sort()).toEqual(
        [ptsBill.id, krtBill.id].sort(),
      );

      // Without the broker link, the broker's freight bill is no longer a customs cost.
      await put(`/shipments/${id}/customs`, cookies.customsPts, { status: 'PENDING' }).expect(200);
      expect((await customs(id, cookies.managerPts)).costLines).toEqual([]);
      // Another shipment's bills are never on this file.
      const other = await shipment();
      expect((await customs(other, cookies.admin)).costLines).toEqual([]);
    });

    it('removing a fee leaves the supplier costs as they are', async () => {
      const id = await shipment();
      const withFee = (
        await post(`/shipments/${id}/customs/fees`, cookies.customsPts, {
          description: 'Inspection',
          amount: '15',
          currency: 'USD',
        }).expect(201)
      ).body as ShipmentCustomsDto;
      await bill({
        shipmentId: id,
        supplierId: otherSupplier.id,
        chargeTypeCode: customsCharge,
        amount: '15',
      });
      const fee = withFee.fees[0];
      if (!fee) throw new Error('No fee');
      await del(`/shipments/${id}/customs/fees/${fee.id}`, cookies.admin).expect(200);
      const file = await customs(id, cookies.financePts);
      expect(file.fees).toEqual([]);
      expect(file.totals).toEqual([]);
      expect(file.costTotals).toEqual([{ currency: 'USD', amount: '15' }]);
    });
  });
});
