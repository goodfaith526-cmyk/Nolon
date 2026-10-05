import { randomInt, randomUUID } from 'node:crypto';
import type {
  AccountDto,
  BookingDto,
  ConsolidationDto,
  CustomerDto,
  JournalEntryDto,
  ShipmentConsolidationDto,
  ShipmentDto,
  SupplierBillDto,
  SupplierDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import { uniquePhone, waitForLockWaiter } from './test-data.js';

/**
 * Annex E scenario 2: three LCL shipments of three customers in one container from Jeddah. The
 * container's status moves its shipments; its costs go to the consolidation clearing account
 * (rule 7a) and closing it shares them by CBM (rule 13), with no cost counted twice and the
 * clearing balance back to zero. Posted entries are never deleted, so these are LEDGER users and
 * every date is in a random past year.
 */
describe('consolidated LCL containers', () => {
  let t: TestApp;
  let jed: string;
  let pts: string;
  let jeddahPort: string;
  let portSudan: string;
  let khartoum: string;
  let customers: [CustomerDto, CustomerDto, CustomerDto];
  let supplier: SupplierDto;
  let accounts: Map<string, AccountDto>;
  const year = randomInt(1901, 2000);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const at = (monthDay: string) => `${year}-${monthDay}T08:00:00+03:00`;
  const cookies = {
    admin: '',
    opsJed: '',
    salesJed: '',
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
  const del = (path: string, cookie: string) =>
    t.http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);

  const account = (code: string): AccountDto => {
    const found = accounts.get(code);
    if (!found) throw new Error(`No account ${code}`);
    return found;
  };
  const journal = async (id: string) =>
    (await get(`/accounting/journals/${id}`, cookies.financeJed).expect(200))
      .body as JournalEntryDto;
  const sum = (values: string[]) =>
    values.reduce((acc, v) => acc.plus(v), new Prisma.Decimal(0)).toFixed();
  const container = async (id: string, cookie = cookies.financeJed) =>
    (await get(`/consolidations/${id}`, cookie).expect(200)).body as ConsolidationDto;
  const shipmentOf = async (id: string) =>
    (await get(`/shipments/${id}`, cookies.opsJed).expect(200)).body as ShipmentDto;

  /** A confirmed Jeddah → Port Sudan LCL booking of `customer`; its shipment id. */
  async function lclShipment(
    customer: CustomerDto,
    volumeCbm: string | null,
    overrides: object = {},
  ): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesJed, {
        customerId: customer.id,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 2, weightKg: '500', volumeCbm }],
        ...overrides,
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesJed).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    // The shipment's history is dated in the test year, before the container moves.
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: confirmed.shipmentId },
      data: { occurredAt: new Date(at('01-02')) },
    });
    return confirmed.shipmentId;
  }

  const newContainer = (shipmentIds: readonly string[], extra: object = {}) =>
    post('/consolidations', cookies.opsJed, {
      branchId: jed,
      originLocationId: jeddahPort,
      destinationLocationId: portSudan,
      containerTypeCode: '40HC',
      vesselName: 'MSC Aurora',
      voyageNumber: 'AR123',
      etd: d('03-01'),
      eta: d('03-05'),
      shipmentIds,
      ...extra,
    });

  async function approvedBill(consolidationId: string, amount: string, billDate: string) {
    const draft = (
      await post('/supplier-bills', cookies.financeJed, {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: jed,
        currency: 'USD',
        billDate,
        dueDate: billDate,
        lines: [
          {
            kind: 'CONSOLIDATION',
            consolidationId,
            chargeTypeCode: 'FREIGHT',
            description: 'Ocean freight, whole container',
            amount,
          },
        ],
      }).expect(201)
    ).body as SupplierBillDto;
    return (await post(`/supplier-bills/${draft.id}/approve`, cookies.financeJed).expect(200))
      .body as SupplierBillDto;
  }

  beforeAll(async () => {
    t = await createTestApp();
    jed = await branchId(t.prisma, 'JED');
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      warehouseJed: await createUser(t.prisma, ['WAREHOUSE'], ['JED'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const newCustomer = async (name: string) =>
      (
        await post('/customers', cookies.salesJed, {
          branchId: jed,
          kind: 'COMPANY',
          name: `LCL ${name} ${year}`,
          phone: uniquePhone(),
          preferredCurrency: 'USD',
        }).expect(201)
      ).body as CustomerDto;
    customers = [await newCustomer('Alpha'), await newCustomer('Beta'), await newCustomer('Gamma')];
    supplier = (
      await post('/suppliers', cookies.financeJed, {
        name: `LCL Shipping Line ${randomUUID().slice(0, 6)}`,
        paymentTermsDays: 30,
      }).expect(201)
    ).body as SupplierDto;
    const list = (await get('/accounting/accounts', cookies.financeJed).expect(200))
      .body as AccountDto[];
    accounts = new Map(list.map((a) => [a.code, a]));
  });

  afterAll(async () => {
    await t.close();
  });

  it('runs scenario 2: three customers in one container, the cost shared by CBM', async () => {
    const ids = [
      await lclShipment(customers[0], '2'),
      await lclShipment(customers[1], '3'),
      await lclShipment(customers[2], '5'),
    ] as const;
    const created = (await newContainer(ids).expect(201)).body as ConsolidationDto;
    expect(created.number).toMatch(/^NOL-CON-\d{4}-\d{6}$/);
    expect(created.status).toBe('OPEN');
    expect(created.shipments.map((s) => s.shipmentId).sort()).toEqual([...ids].sort());
    // The container's voyage is the shipments' voyage.
    for (const id of ids) {
      const s = await shipmentOf(id);
      expect(s.vesselName).toBe('MSC Aurora');
      expect(s.voyageNumber).toBe('AR123');
      expect(s.eta).toBe(d('03-05'));
    }
    await patch(`/consolidations/${created.id}`, cookies.opsJed, { eta: d('03-07') }).expect(200);
    for (const id of ids) expect((await shipmentOf(id)).eta).toBe(d('03-07'));

    // A cost billed while the container is open waits on the clearing account (rule 7a).
    const early = await approvedBill(created.id, '1000.00', d('02-20'));
    const earlyEntry = await journal(early.journalEntryId ?? '');
    const clearing = earlyEntry.lines.find((l) => l.accountId === account('1400').id);
    expect(clearing?.debitUsd).toBe('1000');
    let view = await container(created.id);
    expect(view.clearingBalanceUsd).toBe('1000');
    expect(view.costs).toHaveLength(1);
    expect(view.costs[0]?.allocationEntryId).toBeNull();

    // Closing needs the container number.
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('03-01'),
    }).expect(400);
    await patch(`/consolidations/${created.id}`, cookies.opsJed, {
      containerNumber: 'MSCU 123456-5',
      sealNumber: 'S-99',
    }).expect(200);
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('03-01'),
    }).expect(200);
    for (const id of ids) expect((await shipmentOf(id)).status).toBe('CONSOLIDATED');

    // Closing shares the waiting cost 20 / 30 / 50 % by CBM (rule 13); the clearing is zero.
    view = await container(created.id);
    expect(view.containerNumber).toBe('MSCU1234565');
    expect(view.clearingBalanceUsd).toBe('0');
    const share = (id: string) => view.shipments.find((s) => s.shipmentId === id)?.allocatedUsd;
    expect([share(ids[0]), share(ids[1]), share(ids[2])]).toEqual(['200', '300', '500']);
    const allocation = await journal(view.costs[0]?.allocationEntryId ?? '');
    expect(allocation.source).toBe('CONSOLIDATION_ALLOCATION');
    expect(allocation.entryDate).toBe(d('03-01'));
    expect(sum(allocation.lines.map((l) => l.debitUsd))).toBe(
      sum(allocation.lines.map((l) => l.creditUsd)),
    );
    expect(allocation.lines.find((l) => l.accountId === account('1400').id)?.creditUsd).toBe(
      '1000',
    );

    // A cost billed after the close is shared at once, with the same ratios.
    const late = await approvedBill(created.id, '250.00', d('03-03'));
    view = await container(created.id);
    expect(view.clearingBalanceUsd).toBe('0');
    expect([share(ids[0]), share(ids[1]), share(ids[2])]).toEqual(['250', '375', '625']);
    expect(view.costs.find((c) => c.billId === late.id)?.allocationEntryId).not.toBeNull();

    // Each shipment's cost lines add up to its share once: no cost is counted twice.
    for (const [index, id] of ids.entries()) {
      const lines = await t.prisma.journalLine.findMany({
        where: { shipmentId: id, entry: { status: 'POSTED' } },
      });
      expect(sum(lines.map((l) => l.debitUsd.minus(l.creditUsd).toFixed()))).toBe(
        ['250', '375', '625'][index],
      );
    }

    // Loading, departing and arriving move every shipment; the location follows.
    for (const [status, day, shipmentStatus] of [
      ['LOADED', '03-02', 'LOADED'],
      ['DEPARTED', '03-02', 'DEPARTED'],
      ['ARRIVED', '03-06', 'ARRIVED_PORT'],
    ] as const) {
      await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
        status,
        occurredAt: at(day),
      }).expect(200);
      for (const id of ids) expect((await shipmentOf(id)).status).toBe(shipmentStatus);
    }
    for (const id of ids) expect((await shipmentOf(id)).currentLocationId).toBe(portSudan);

    // Unpacking leaves each shipment to go on by itself.
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'DECONSOLIDATED',
      occurredAt: at('03-07'),
    }).expect(200);
    view = await container(created.id);
    expect(view.status).toBe('DECONSOLIDATED');
    expect(view.actions.moves).toEqual([]);
    for (const id of ids) expect((await shipmentOf(id)).status).toBe('ARRIVED_PORT');

    // The shipment page lists its container.
    const listed = (await get(`/shipments/${ids[0]}/consolidations`, cookies.opsJed).expect(200))
      .body as ShipmentConsolidationDto[];
    expect(listed.map((c) => c.number)).toEqual([created.number]);

    // Cancelling a bill reverses its cost and its sharing out: the clearing stays at zero.
    await post(`/supplier-bills/${late.id}/cancel`, cookies.financeJed, {
      reason: 'Billed twice',
    }).expect(200);
    view = await container(created.id);
    expect(view.clearingBalanceUsd).toBe('0');
    expect([share(ids[0]), share(ids[1]), share(ids[2])]).toEqual(['200', '300', '500']);
    expect(view.costs.map((c) => c.billId)).toEqual([early.id]);
  });

  it('keeps container costs from those who may not see costs', async () => {
    const id = await lclShipment(customers[0], '1');
    const created = (await newContainer([id]).expect(201)).body as ConsolidationDto;
    await approvedBill(created.id, '100.00', d('04-01'));
    const ops = await container(created.id, cookies.opsJed);
    expect(ops.showsCost).toBe(false);
    expect(ops.costs).toEqual([]);
    expect(ops.clearingBalanceUsd).toBeNull();
    expect(ops.shipments[0]?.allocatedUsd).toBeNull();
    const warehouse = await container(created.id, cookies.warehouseJed);
    expect(warehouse.showsCost).toBe(false);
    expect(warehouse.actions.moves).toEqual([]);
    const finance = await container(created.id);
    expect(finance.showsCost).toBe(true);
    expect(finance.clearingBalanceUsd).toBe('100');
  });

  it('refuses what a container cannot take, other branches and missing permissions', async () => {
    const lcl = await lclShipment(customers[1], '4');
    const fcl = await lclShipment(customers[1], '4', { loadType: 'FCL' });
    const noVolume = await lclShipment(customers[2], null);
    // Not an LCL sea shipment: 400.
    await newContainer([fcl]).expect(400);
    // Between ports only.
    await newContainer([lcl], { destinationLocationId: khartoum }).expect(400);
    // Sales has no access to containers; Warehouse only views them.
    await newContainer([lcl]).set('Cookie', cookies.salesJed).expect(403);
    await post('/consolidations', cookies.warehouseJed, {
      branchId: jed,
      originLocationId: jeddahPort,
      destinationLocationId: portSudan,
      containerTypeCode: '40HC',
      shipmentIds: [lcl],
    }).expect(403);
    // Another branch's user may not open a JED container, nor use a JED shipment in one.
    const created = (await newContainer([lcl]).expect(201)).body as ConsolidationDto;
    await get(`/consolidations/${created.id}`, cookies.opsPts).expect(404);
    await post('/consolidations', cookies.opsPts, {
      branchId: pts,
      originLocationId: portSudan,
      destinationLocationId: jeddahPort,
      containerTypeCode: '40HC',
      shipmentIds: [lcl],
    }).expect(404);
    await post('/consolidations', cookies.opsJed, {
      branchId: pts,
      originLocationId: jeddahPort,
      destinationLocationId: portSudan,
      containerTypeCode: '40HC',
      shipmentIds: [],
    }).expect(403);
    // A shipment is in one container at a time.
    await newContainer([lcl]).expect(409);
    // A container is closed only when every shipment has its CBM.
    await post(`/consolidations/${created.id}/shipments`, cookies.opsJed, {
      shipmentId: noVolume,
    }).expect(201);
    await patch(`/consolidations/${created.id}`, cookies.opsJed, {
      containerNumber: 'MSCU1234565',
    }).expect(200);
    const refused = await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('05-01'),
    }).expect(400);
    expect(JSON.stringify(refused.body)).toContain('volume (CBM)');
    expect((await shipmentOf(lcl)).status).toBe('CREATED');
    // Taken out, the shipment can go in another container; the rest closes.
    await del(`/consolidations/${created.id}/shipments/${noVolume}`, cookies.opsJed).expect(200);
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('05-01'),
    }).expect(200);
    // Closed: no more shipments, no cancelling, no going back to a different basis.
    await post(`/consolidations/${created.id}/shipments`, cookies.opsJed, {
      shipmentId: noVolume,
    }).expect(409);
    await post(`/consolidations/${created.id}/cancel`, cookies.opsJed, { reason: 'x' }).expect(409);
    await patch(`/consolidations/${created.id}`, cookies.opsJed, { basis: 'WEIGHT' }).expect(409);
    // The same move twice is refused.
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
    }).expect(409);
  });

  it('cancels an open container only while no approved bill charges it', async () => {
    const id = await lclShipment(customers[0], '2');
    const created = (await newContainer([id]).expect(201)).body as ConsolidationDto;
    const bill = await approvedBill(created.id, '80.00', d('06-01'));
    await post(`/consolidations/${created.id}/cancel`, cookies.opsJed, {
      reason: 'Booked on another vessel',
    }).expect(409);
    await post(`/supplier-bills/${bill.id}/cancel`, cookies.financeJed, {
      reason: 'Wrong container',
    }).expect(200);
    expect((await container(created.id)).clearingBalanceUsd).toBe('0');
    const cancelled = (
      await post(`/consolidations/${created.id}/cancel`, cookies.opsJed, {
        reason: 'Booked on another vessel',
      }).expect(200)
    ).body as ConsolidationDto;
    expect(cancelled.status).toBe('CANCELLED');
    // A cancelled container takes no cost, and its shipment may go in another container.
    await post('/supplier-bills', cookies.financeJed, {
      requestId: randomUUID(),
      supplierId: supplier.id,
      branchId: jed,
      currency: 'USD',
      billDate: d('06-02'),
      dueDate: d('06-02'),
      lines: [
        {
          kind: 'CONSOLIDATION',
          consolidationId: created.id,
          chargeTypeCode: 'FREIGHT',
          amount: '1',
        },
      ],
    }).expect(400);
    await newContainer([id]).expect(201);
  });

  it('shares a cost exactly once when its approval races the close', async () => {
    const id = await lclShipment(customers[2], '2');
    const created = (await newContainer([id], { containerNumber: 'MSCU1234565' }).expect(201))
      .body as ConsolidationDto;
    const draft = (
      await post('/supplier-bills', cookies.financeJed, {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: jed,
        currency: 'USD',
        billDate: d('08-01'),
        dueDate: d('08-01'),
        lines: [
          {
            kind: 'CONSOLIDATION',
            consolidationId: created.id,
            chargeTypeCode: 'THC',
            amount: '60',
          },
        ],
      }).expect(201)
    ).body as SupplierBillDto;
    // Both requests queue on the container's row; whichever goes first, the cost is shared once.
    const { pending } = await t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "consolidations" WHERE "id" = ${created.id}::uuid FOR UPDATE`;
        const started = Promise.all([
          post(`/consolidations/${created.id}/status`, cookies.opsJed, {
            status: 'CLOSED',
            occurredAt: at('08-02'),
          }),
          post(`/supplier-bills/${draft.id}/approve`, cookies.financeJed),
        ]);
        await waitForLockWaiter(t.prisma, 2);
        return { pending: started };
      },
      { timeout: 15_000 },
    );
    expect((await pending).map((r) => r.status)).toEqual([200, 200]);
    const view = await container(created.id);
    expect(view.costs).toHaveLength(1);
    expect(view.costs[0]?.allocationEntryId).not.toBeNull();
    expect(view.shipments[0]?.allocatedUsd).toBe('60');
    expect(view.clearingBalanceUsd).toBe('0');
  });

  it('shares by weight when the container says so', async () => {
    const light = await lclShipment(customers[0], '1');
    const heavy = await lclShipment(customers[1], '1', {
      items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '1500', volumeCbm: '1' }],
    });
    const created = (
      await newContainer([light, heavy], {
        basis: 'WEIGHT',
        containerNumber: 'MSCU1234565',
      }).expect(201)
    ).body as ConsolidationDto;
    await approvedBill(created.id, '100.00', d('07-01'));
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('07-02'),
    }).expect(200);
    const view = await container(created.id);
    expect(view.basis).toBe('WEIGHT');
    // 500 kg and 1500 kg: 25 / 75.
    expect(view.shipments.find((s) => s.shipmentId === light)?.allocatedUsd).toBe('25');
    expect(view.shipments.find((s) => s.shipmentId === heavy)?.allocatedUsd).toBe('75');
    expect(view.clearingBalanceUsd).toBe('0');
  });
});
