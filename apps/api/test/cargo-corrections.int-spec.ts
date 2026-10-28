import { randomInt, randomUUID } from 'node:crypto';
import type {
  AuditLogDto,
  BookingDto,
  ConsolidationDto,
  CreditNoteDto,
  CustomerDto,
  CustomerInvoiceDto,
  ShipmentDto,
  WarehouseDto,
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
 * B3-3 (docs/plans/05-correction-contracts.md, sections 0 and 3): correcting a confirmed
 * shipment's cargo lines. Invoices post entries that are never deleted, so these are LEDGER users
 * and every date is in a random past year; each test uses container types of its own.
 */
describe('cargo line corrections (B3-3)', () => {
  let t: TestApp;
  let jed: string;
  let jeddahPort: string;
  let portSudan: string;
  let customer: CustomerDto;
  let warehouse: WarehouseDto;
  let opsJedId: string;
  const year = randomInt(1901, 2000);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const at = (monthDay: string) => `${year}-${monthDay}T08:00:00+03:00`;
  const cookies = {
    admin: '',
    opsJed: '',
    salesJed: '',
    managerJed: '',
    financeJed: '',
    warehouseJed: '',
    opsPts: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  type Line = { quantity: number; volumeCbm?: string | null; weightKg?: string | null };
  const lines = (...items: Line[]) => items.map((i) => ({ cargoType: 'GENERAL', ...i }));

  /** A correction request on the revision the shipment shows now, with a new request id. */
  const request = async (shipmentId: string, items: Line[], reason = 'Weighed again') => ({
    requestId: randomUUID(),
    expectedRevision: (await view(shipmentId)).cargoRevision,
    reason,
    items: lines(...items),
  });
  const correct = (shipmentId: string, body: object, cookie = cookies.opsJed) =>
    put(`/shipments/${shipmentId}/items`, cookie, body);
  const view = async (id: string, cookie = cookies.opsJed) =>
    (await get(`/shipments/${id}`, cookie).expect(200)).body as ShipmentDto;

  /** A new container type with these limits (null: none). */
  async function containerType(
    maxVolumeCbm: string | null,
    maxPayloadKg: string | null,
  ): Promise<string> {
    const code = `ZC${randomInt(10_000_000, 99_999_999)}`;
    await post('/master-data/container-types', cookies.admin, {
      code,
      nameEn: `Test ${code}`,
      nameAr: `اختبار ${code}`,
    }).expect(201);
    await patch(`/master-data/container-types/${code}/capacity`, cookies.admin, {
      maxVolumeCbm,
      maxPayloadKg,
    }).expect(200);
    return code;
  }

  /** A confirmed Jeddah → Port Sudan LCL shipment with one cargo line; its id. */
  async function shipment(line: Line = { quantity: 1 }): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesJed, {
        customerId: customer.id,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: lines(line),
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesJed).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: confirmed.shipmentId },
      data: { occurredAt: new Date(at('01-02')) },
    });
    return confirmed.shipmentId;
  }

  async function container(type: string, shipmentIds: string[]): Promise<ConsolidationDto> {
    return (
      await post('/consolidations', cookies.opsJed, {
        branchId: jed,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        containerTypeCode: type,
        containerNumber: 'MSCU1234565',
        shipmentIds,
      }).expect(201)
    ).body as ConsolidationDto;
  }

  const close = (id: string) =>
    post(`/consolidations/${id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('03-01'),
    });

  beforeAll(async () => {
    t = await createTestApp();
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
      managerJed: await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      warehouseJed: await createUser(t.prisma, ['WAREHOUSE'], ['JED'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    opsJedId = users.opsJed.id;
    customer = (
      await post('/customers', cookies.salesJed, {
        branchId: jed,
        kind: 'COMPANY',
        name: `Cargo corrections ${year}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    // Not ZZ: test cleanup deletes those, and this one keeps the movements of LEDGER shipments.
    const code = `LC-${randomInt(100_000, 999_999)}`;
    warehouse = (
      await post('/warehouses', cookies.admin, {
        branchId: jed,
        code,
        nameEn: `Store ${code}`,
        nameAr: `مستودع ${code}`,
      }).expect(201)
    ).body as WarehouseDto;
  });

  afterAll(async () => {
    await t.close();
  });

  it('replaces the lines, keeps them before and after with the reason, and logs it', async () => {
    const id = await shipment({ quantity: 1, volumeCbm: '2', weightKg: '100' });
    const booking = (await view(id)).bookingId;
    expect((await view(id)).actions.canCorrectCargo).toBe(true);
    const body = await request(id, [
      { quantity: 3, volumeCbm: '2.5', weightKg: '120' },
      { quantity: 2, volumeCbm: null, weightKg: '40' },
    ]);
    const corrected = (await correct(id, body).expect(200)).body as ShipmentDto;
    expect(corrected.packages).toBe(5);
    expect(corrected.items.map((i) => [i.lineNo, i.quantity, i.volumeCbm, i.weightKg])).toEqual([
      [1, 3, '2.5', '120'],
      [2, 2, null, '40'],
    ]);
    expect(corrected.cargoRevision).toBe(1);
    expect(corrected.cargoCorrections).toEqual([
      expect.objectContaining({
        revision: 1,
        reason: 'Weighed again',
        containerNumber: null,
        itemsBefore: [expect.objectContaining({ lineNo: 1, quantity: 1, volumeCbm: '2' })],
        itemsAfter: [
          expect.objectContaining({ lineNo: 1, quantity: 3 }),
          expect.objectContaining({ lineNo: 2, quantity: 2 }),
        ],
      }),
    ]);
    // The booking keeps the lines it was confirmed with.
    const bookingItems = await t.prisma.bookingItem.findMany({ where: { bookingId: booking } });
    expect(bookingItems.map((i) => i.quantity)).toEqual([1]);

    const today = new Date().toISOString().slice(0, 10);
    const log = (
      await get(
        `/reports/audit-log?from=${today}&to=${today}&entity=SHIPMENT&userId=${opsJedId}`,
        cookies.admin,
      ).expect(200)
    ).body as AuditLogDto;
    const entry = log.entries.find((e) => e.reference === corrected.number);
    expect(entry).toMatchObject({
      action: 'UPDATED',
      detail: 'Weighed again',
      changes: [
        { field: 'lines', before: '1', after: '2' },
        { field: 'packages', before: '1', after: '5' },
        { field: 'weightKg', before: '100', after: '160' },
        { field: 'volumeCbm', before: '2', after: '2.5' },
      ],
    });

    // The row is insert-only.
    await expect(
      t.prisma.shipmentCargoCorrection.updateMany({
        where: { shipmentId: id },
        data: { reason: 'Changed' },
      }),
    ).rejects.toThrow(/cannot be changed or deleted/);
    await expect(
      t.prisma.shipmentCargoCorrection.deleteMany({ where: { shipmentId: id } }),
    ).rejects.toThrow(/cannot be changed or deleted/);
  });

  it('returns the stored result for a retry, even after later corrections (ABA), and refuses a reused key or an old revision', async () => {
    const id = await shipment({ quantity: 1 });
    const first = await request(id, [{ quantity: 2 }]);
    await correct(id, first).expect(200);
    // The same request again: no new correction.
    await correct(id, first).expect(200);
    expect((await view(id)).cargoRevision).toBe(1);
    // The same key with other content.
    const reused = await correct(id, { ...first, items: lines({ quantity: 4 }) }).expect(409);
    expect(reused.body).toMatchObject({ code: 'CORRECTION_KEY_REUSED' });

    // Back to one package: A, B, A.
    await correct(id, await request(id, [{ quantity: 1 }])).expect(200);
    // The first request, late: the stored result, nothing changes.
    await correct(id, first).expect(200);
    let shown = await view(id);
    expect([shown.cargoRevision, shown.packages]).toEqual([2, 1]);
    // An old revision under a new key is stale.
    const stale = await correct(id, { ...first, requestId: randomUUID() }).expect(409);
    expect(stale.body).toMatchObject({ code: 'CORRECTION_STALE' });
    shown = await view(id);
    expect([shown.cargoRevision, shown.packages]).toEqual([2, 1]);
  });

  it('replays a stored correction even once its container type is deactivated (F138-2)', async () => {
    const type = await containerType(null, null);
    const booking = (
      await post('/bookings', cookies.salesJed, {
        customerId: customer.id,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'CONTAINER', containerTypeCode: type, quantity: 1 }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesJed).expect(200))
      .body as BookingDto;
    const id = confirmed.shipmentId;
    if (!id) throw new Error('No shipment');
    const body = {
      requestId: randomUUID(),
      expectedRevision: (await view(id)).cargoRevision,
      reason: 'Two containers, not one',
      items: [{ cargoType: 'CONTAINER', containerTypeCode: type, quantity: 2 }],
    };
    await correct(id, body).expect(200);
    await post(`/master-data/container-types/${type}/deactivate`, cookies.admin).expect(200);
    // The same request again: the stored result, not a check of today's master data.
    const replayed = (await correct(id, body).expect(200)).body as ShipmentDto;
    expect([replayed.cargoRevision, replayed.packages]).toEqual([1, 2]);
    // A new correction naming the inactive type is checked as any other.
    const fresh = await correct(id, { ...body, requestId: randomUUID(), expectedRevision: 1 });
    expect(fresh.status).toBe(400);
  });

  it('moves the cargo type of the shipment with its lines, and keeps FCL or LCL (F138-1)', async () => {
    const id = await shipment({ quantity: 1, volumeCbm: '1' });
    expect((await view(id)).cargoType).toBe('GENERAL');
    const barrels = (
      await correct(id, {
        requestId: randomUUID(),
        expectedRevision: 0,
        reason: 'Barrels, not general cargo',
        items: [{ cargoType: 'BARREL', quantity: 3, volumeCbm: '1' }],
      }).expect(200)
    ).body as ShipmentDto;
    expect(barrels.cargoType).toBe('BARREL');
    // A container line would make this LCL shipment FCL: refused, nothing changes.
    const fcl = await correct(id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      reason: 'A whole container',
      items: [{ cargoType: 'CONTAINER', containerTypeCode: '20GP', quantity: 1 }],
    }).expect(409);
    expect(fcl.body).toMatchObject({ code: 'CARGO_LOAD_TYPE_CHANGE' });
    const after = await view(id);
    expect([after.cargoType, after.loadType, after.cargoRevision]).toEqual(['BARREL', 'LCL', 1]);
  });

  it('keeps an open container within its limits, by volume and by weight, and lets a closed one fix the lines', async () => {
    const type = await containerType('67', '1000');
    const big = await shipment({ quantity: 1, volumeCbm: '60', weightKg: '500' });
    const small = await shipment({ quantity: 1, volumeCbm: '1', weightKg: '10' });
    const unmeasured = await shipment({ quantity: 1, volumeCbm: null, weightKg: '10' });
    const created = await container(type, [big, small, unmeasured]);

    // 61 of 67 CBM: 10 more is refused.
    const over = await correct(small, await request(small, [{ quantity: 1, volumeCbm: '11' }]));
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      code: 'CONTAINER_OVER_VOLUME',
      params: { container: created.number, used: '61', limit: '67', after: '71' },
    });
    // The same by weight: 520 of 1000 kg, 600 more.
    const heavy = await correct(
      small,
      await request(small, [{ quantity: 1, volumeCbm: '1', weightKg: '610' }]),
    ).expect(409);
    expect(heavy.body).toMatchObject({ code: 'CONTAINER_OVER_WEIGHT' });
    // A missing volume that becomes known counts as any addition.
    const known = await correct(
      unmeasured,
      await request(unmeasured, [{ quantity: 1, volumeCbm: '7', weightKg: '10' }]),
    ).expect(409);
    expect(known.body).toMatchObject({ code: 'CONTAINER_OVER_VOLUME' });
    // The missing volume blocks closing; a volume that fits clears it.
    expect((await close(created.id).expect(400)).body).toMatchObject({
      code: 'CONTAINER_VOLUME_MISSING',
    });
    await correct(
      unmeasured,
      await request(unmeasured, [{ quantity: 1, volumeCbm: '5', weightKg: '10' }]),
    ).expect(200);
    // Less than before is allowed.
    const fewer = (
      await correct(big, await request(big, [{ quantity: 1, volumeCbm: '59', weightKg: '500' }]))
    ).body as ShipmentDto;
    expect(fewer.cargoCorrections.at(-1)?.containerNumber).toBe(created.number);

    await close(created.id).expect(200);
    const closed = await correct(big, await request(big, [{ quantity: 1, volumeCbm: '58' }]));
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({
      code: 'CARGO_IN_CLOSED_CONTAINER',
      params: { container: created.number },
    });
  });

  it('lets only one of two concurrent corrections fill the last space of a container', async () => {
    const type = await containerType('10', null);
    const a = await shipment({ quantity: 1, volumeCbm: '3' });
    const b = await shipment({ quantity: 1, volumeCbm: '3' });
    await container(type, [a, b]);
    const [bodyA, bodyB] = [
      await request(a, [{ quantity: 1, volumeCbm: '6' }]),
      await request(b, [{ quantity: 1, volumeCbm: '6' }]),
    ];
    const results = await Promise.all([correct(a, bodyA), correct(b, bodyB)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      code: 'CONTAINER_OVER_VOLUME',
    });
  });

  it('refuses while an approved invoice bills the shipment, and allows it once fully credited', async () => {
    const id = await shipment({ quantity: 1 });
    const draft = (
      await post('/customer-invoices', cookies.financeJed, { shipmentId: id }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financeJed, {
      currency: 'USD',
      invoiceDate: d('03-10'),
      dueDate: d('03-10'),
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '100' }],
    }).expect(200);
    const invoice = (
      await post(`/customer-invoices/${draft.id}/approve`, cookies.financeJed).expect(200)
    ).body as CustomerInvoiceDto;
    const refused = await correct(id, await request(id, [{ quantity: 2 }])).expect(409);
    expect(refused.body).toMatchObject({
      code: 'CARGO_INVOICED',
      params: { invoices: invoice.number },
    });
    const credit = (
      await post('/credit-notes', cookies.financeJed, {
        requestId: randomUUID(),
        invoiceId: invoice.id,
        creditDate: d('03-20'),
        amount: '100',
        reason: 'Wrong quantity',
      }).expect(201)
    ).body as CreditNoteDto;
    await post(`/credit-notes/${credit.id}/approve`, cookies.managerJed).expect(200);
    await correct(id, await request(id, [{ quantity: 2 }])).expect(200);
  });

  it('refuses fewer packages than its warehouses hold', async () => {
    const id = await shipment({ quantity: 4 });
    await post(`/shipments/${id}/warehouse/receipts`, cookies.warehouseJed, {
      warehouseId: warehouse.id,
      packages: 3,
      condition: 'GOOD',
    }).expect(201);
    const refused = await correct(id, await request(id, [{ quantity: 2 }])).expect(409);
    expect(refused.body).toMatchObject({
      code: 'CARGO_BELOW_ON_HAND',
      params: { packages: '2', onHand: '3' },
    });
    await correct(id, await request(id, [{ quantity: 3 }])).expect(200);
  });

  it('needs shipments:update in the shipment’s own branch, a reason and an active shipment', async () => {
    const id = await shipment({ quantity: 1 });
    const body = await request(id, [{ quantity: 2 }]);
    // Sales only views shipments.
    await correct(id, body, cookies.salesJed).expect(403);
    expect((await view(id, cookies.salesJed)).actions.canCorrectCargo).toBe(false);
    // Another branch does not see it.
    await correct(id, body, cookies.opsPts).expect(404);
    // A branch sharing it may update it, but not correct its lines.
    await patch(`/shipments/${id}`, cookies.opsJed, {
      sharedBranchIds: [await branchId(t.prisma, 'PTS')],
    }).expect(200);
    expect((await view(id, cookies.opsPts)).actions.canCorrectCargo).toBe(false);
    await correct(id, body, cookies.opsPts).expect(403);
    // Validation.
    for (const bad of [
      { ...body, reason: 'no' },
      { ...body, items: [] },
      { ...body, requestId: 'x' },
      { ...body, expectedRevision: -1 },
      { ...body, items: lines({ quantity: 1 }).map((i) => ({ ...i, priceCategoryCode: 'X' })) },
      { ...body, extra: true },
    ]) {
      await correct(id, bad).expect(400);
    }
    // Dimensions come together, as on a booking.
    const dims = await correct(id, {
      ...body,
      items: lines({ quantity: 1 }).map((i) => ({ ...i, lengthCm: '10' })),
    }).expect(400);
    expect(dims.body).toMatchObject({ code: 'DIMENSIONS_TOGETHER' });
    expect((await view(id)).cargoRevision).toBe(0);

    await post(`/shipments/${id}/cancel`, cookies.opsJed, { reason: 'Customer withdrew' }).expect(
      200,
    );
    expect((await view(id)).actions.canCorrectCargo).toBe(false);
    const closed = await correct(id, body).expect(409);
    expect(closed.body).toMatchObject({ code: 'CARGO_SHIPMENT_CLOSED' });
  });
});
