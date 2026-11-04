import type {
  AccountDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  ReceiptDto,
  ShipmentDto,
  WarehouseDto,
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

/** A PNG signature header is enough for the content check (magic bytes). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const OWNER = '00000000-0000-0000-0000-000000000000';

/**
 * Plan 12 section 3: goods leave at the destination (a release from a warehouse there, a POD,
 * delivered by hand) only with a live approved MAIN invoice, and the shipment paid (no limit, or a
 * limit of 0) or the customer within a positive limit, read on the current state; or with the
 * override's permission and a reason. Releases at the origin are never gated. Posted entries are
 * never deleted, so the users are LEDGER users and every customer is this run's own.
 */
describe('handover gate (plan 12 section 3)', () => {
  let t: TestApp;
  let pts = '';
  let cash: AccountDto;
  const ids = { origin: '', dest: '' };
  const wh = { origin: '', dest: '' };
  const cookies = { admin: '', finance: '', sales: '', ops: '', overrider: '' };
  let adminId = '';
  const year = String(randomInt(2001, 2025));

  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);

  async function customer(limit: string | null): Promise<string> {
    const made = (
      await post('/customers', cookies.sales, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Handover ${randomUUID().slice(0, 8)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    if (limit !== null) {
      await t.prisma.customer.update({
        where: { id: made.id },
        data: { creditLimit: limit, creditLimitCurrency: 'USD' },
      });
    }
    return made.id;
  }

  async function shipment(customerId: string): Promise<string> {
    const booking = (
      await post('/bookings', cookies.sales, {
        customerId,
        originLocationId: ids.origin,
        destinationLocationId: ids.dest,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm: '1', weightKg: '100' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.sales).expect(200))
      .body as BookingDto;
    return confirmed.shipmentId!;
  }

  /** The shipment's MAIN invoice of `amount` USD, approved. */
  async function invoice(shipmentId: string, amount: string): Promise<CustomerInvoiceDto> {
    const draft = (await post('/customer-invoices', cookies.finance, { shipmentId }).expect(201))
      .body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.finance, {
      currency: 'USD',
      invoiceDate: `${year}-03-01`,
      dueDate: `${year}-03-01`,
      repriced: true,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: amount }],
    }).expect(200);
    return (await post(`/customer-invoices/${draft.id}/approve`, cookies.finance).expect(200))
      .body as CustomerInvoiceDto;
  }

  async function pay(customerId: string, amount: string, invoiceId: string): Promise<ReceiptDto> {
    return (
      await post('/receipts', cookies.finance, {
        customerId,
        receiptDate: `${year}-03-02`,
        currency: 'USD',
        amount,
        cashAccountId: cash.id,
        allocations: [{ invoiceId, amount }],
      }).expect(201)
    ).body as ReceiptDto;
  }

  const pod = (shipmentId: string, cookie = cookies.ops, extra: Record<string, string> = {}) => {
    let req = t
      .http()
      .post(`/api/v1/shipments/${shipmentId}/pods`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .field('recipientName', 'Consignee')
      .field('recipientCapacity', 'Consignee');
    for (const [key, value] of Object.entries(extra)) req = req.field(key, value);
    return req.attach('signature', PNG, 'signature.png');
  };
  const pods = (shipmentId: string) => t.prisma.proofOfDelivery.count({ where: { shipmentId } });

  beforeAll(async () => {
    t = await createTestApp({ HANDOVER_PAYMENT_GATE_ENABLED: true });
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    ids.origin = await loc('SDPZU');
    ids.dest = await loc('SDKRT');
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    adminId = admin.id;
    const users = {
      admin,
      finance: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      sales: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      ops: await createUser(t.prisma, ['OPERATIONS', 'WAREHOUSE'], ['PTS'], LEDGER_PREFIX),
      overrider: await createUser(t.prisma, ['OPERATIONS', 'WAREHOUSE'], ['PTS'], LEDGER_PREFIX),
    };
    // The override is granted by hand only (no role holds it).
    await t.prisma.userBranchPermission.create({
      data: {
        userId: users.overrider.id,
        branchId: pts,
        permission: 'handover_payment:approve',
        effect: 'ALLOW',
        sourceKey: OWNER,
        createdById: adminId,
      },
    });
    await t.prisma.accessState.update({ where: { id: 1 }, data: { version: { increment: 1 } } });
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    cash = (
      await post('/accounting/accounts', cookies.admin, {
        code: `HG${suffix}`,
        nameEn: 'Handover test cash USD',
        nameAr: 'نقدية اختبار التسليم',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'USD',
        branchId: pts,
      }).expect(201)
    ).body as AccountDto;
    for (const [key, locationId] of [
      ['origin', ids.origin],
      ['dest', ids.dest],
    ] as const) {
      wh[key] = (
        (
          await post('/warehouses', cookies.admin, {
            branchId: pts,
            code: `HG-${key}-${suffix}`,
            nameEn: `Handover ${key}`,
            nameAr: 'مستودع اختبار التسليم',
            locationId,
          }).expect(201)
        ).body as WarehouseDto
      ).id;
    }
  });

  afterAll(async () => {
    await t?.close();
  });

  it('refuses a POD without an approved invoice, then unpaid; passes once paid', async () => {
    const customerId = await customer(null);
    const id = await shipment(customerId);
    const none = await pod(id).expect(409);
    expect(none.body).toMatchObject({ code: 'HANDOVER_NOT_INVOICED' });
    expect(await pods(id)).toBe(0);

    const inv = await invoice(id, '120');
    const unpaid = await pod(id).expect(409);
    expect(unpaid.body).toMatchObject({
      code: 'HANDOVER_UNPAID',
      params: { balance: '120', currency: 'USD' },
    });
    await pay(customerId, '100', inv.id);
    await pod(id).expect(409);
    await pay(customerId, '20', inv.id);
    await pod(id).expect(201);
    expect(await pods(id)).toBe(1);
  });

  it('reads the current state: a cancelled receipt blocks again', async () => {
    const customerId = await customer(null);
    const id = await shipment(customerId);
    const inv = await invoice(id, '50');
    const receipt = await pay(customerId, '50', inv.id);
    await post(`/receipts/${receipt.id}/cancel`, cookies.finance, {
      reason: 'Bounced cheque',
    }).expect(200);
    const refused = await pod(id).expect(409);
    expect(refused.body).toMatchObject({ code: 'HANDOVER_UNPAID', params: { balance: '50' } });
  });

  it('with a limit of 0 (cash), an advance pays the shipment only once applied', async () => {
    const customerId = await customer('0');
    const id = await shipment(customerId);
    // Cash: the advance comes first, or the invoice is not approved (plan 06).
    const advance = (
      await post('/receipts', cookies.finance, {
        customerId,
        receiptDate: `${year}-03-01`,
        currency: 'USD',
        amount: '50',
        cashAccountId: cash.id,
        allocations: [],
      }).expect(201)
    ).body as ReceiptDto;
    const inv = await invoice(id, '50');
    const refused = await pod(id).expect(409);
    expect(refused.body).toMatchObject({ code: 'HANDOVER_UNPAID' });
    await post(`/receipts/${advance.id}/applications`, cookies.finance, {
      requestId: randomUUID(),
      invoiceId: inv.id,
      amount: '50',
      applicationDate: `${year}-03-02`,
    }).expect(200);
    await pod(id).expect(201);
  });

  it('with a positive limit, hands over unpaid within it, and refuses once it is lowered', async () => {
    const customerId = await customer('1000');
    const first = await shipment(customerId);
    await invoice(first, '400');
    await pod(first).expect(201);
    const second = await shipment(customerId);
    await invoice(second, '400');
    await t.prisma.customer.update({ where: { id: customerId }, data: { creditLimit: '500' } });
    const refused = await pod(second).expect(409);
    expect(refused.body).toMatchObject({
      code: 'HANDOVER_OVER_LIMIT',
      params: { limit: '500', currency: 'USD' },
    });
    // F192-1: no company-wide balance in the refusal.
    expect((refused.body as { params: object }).params).not.toHaveProperty('balance');
  });

  it('gates a release at the destination only, and delivered by hand', async () => {
    const customerId = await customer(null);
    const id = await shipment(customerId);
    const receive = (warehouseId: string) =>
      post(`/shipments/${id}/warehouse/receipts`, cookies.ops, {
        warehouseId,
        condition: 'GOOD',
        packages: 1,
      }).expect(201);
    await receive(wh.origin);
    // The origin release is a loading move: never gated.
    await post(`/shipments/${id}/warehouse/releases`, cookies.ops, {
      warehouseId: wh.origin,
      packages: 1,
    }).expect(201);
    await receive(wh.dest);
    const refused = await post(`/shipments/${id}/warehouse/releases`, cookies.ops, {
      warehouseId: wh.dest,
      packages: 1,
    }).expect(409);
    expect(refused.body).toMatchObject({ code: 'HANDOVER_NOT_INVOICED' });

    // Delivered by hand: every step before it passes, DELIVERED itself is gated.
    for (let i = 0; i < 12; i++) {
      const s = (await get(`/shipments/${id}`, cookies.ops).expect(200)).body as ShipmentDto;
      if (s.actions.transitions.includes('DELIVERED')) break;
      const next = s.actions.transitions.find(
        (x) => !['PARTIALLY_DELIVERED', 'DELIVERED', 'ON_HOLD', 'CANCELLED'].includes(x),
      );
      if (!next) throw new Error(`No way to delivery from ${s.status}`);
      await post(`/shipments/${id}/status`, cookies.ops, { status: next }).expect(200);
    }
    // Plan 12 section 6: with no proof of delivery, delivered by hand says why.
    const unexplained = await post(`/shipments/${id}/status`, cookies.ops, {
      status: 'DELIVERED',
    }).expect(400);
    expect(unexplained.body).toMatchObject({ code: 'DELIVERY_REASON_REQUIRED' });
    const byHand = await post(`/shipments/${id}/status`, cookies.ops, {
      status: 'DELIVERED',
      deliveryReason: 'Handed over at the office',
    }).expect(409);
    expect(byHand.body).toMatchObject({ code: 'HANDOVER_NOT_INVOICED' });
    expect((await t.prisma.shipment.findUniqueOrThrow({ where: { id } })).status).not.toBe(
      'DELIVERED',
    );
    // With the override: delivered, and in the audit log.
    await post(`/shipments/${id}/status`, cookies.overrider, {
      status: 'DELIVERED',
      deliveryReason: 'Handed over at the office',
      paymentOverrideReason: 'Owner agreed to collect later',
    }).expect(200);
    // The reason is the delivery event's.
    expect(
      (
        await t.prisma.shipmentEvent.findFirstOrThrow({
          where: { shipmentId: id, status: 'DELIVERED' },
          orderBy: { id: 'desc' },
        })
      ).reason,
    ).toBe('Handed over at the office');
    expect(
      await t.prisma.auditEvent.count({
        where: { entity: 'SHIPMENT', entityId: id, action: 'APPROVED' },
      }),
    ).toBe(1);
  });

  it('overrides only with the permission and a reason of 10 characters', async () => {
    const id = await shipment(await customer(null));
    await pod(id, cookies.ops, { paymentOverrideReason: 'Customer is trusted' }).expect(403);
    await pod(id, cookies.overrider, { paymentOverrideReason: 'Too short' }).expect(400);
    expect(await pods(id)).toBe(0);
    await pod(id, cookies.overrider, { paymentOverrideReason: 'Carried free of charge' }).expect(
      201,
    );
    const row = await t.prisma.proofOfDelivery.findFirstOrThrow({ where: { shipmentId: id } });
    expect(row.paymentOverrideReason).toBe('Carried free of charge');
    expect(row.paymentOverrideById).not.toBeNull();
    expect(
      await t.prisma.auditEvent.count({
        where: { entity: 'SHIPMENT', entityId: id, action: 'APPROVED' },
      }),
    ).toBe(1);
  });
});
