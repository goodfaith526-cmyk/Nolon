import { randomInt, randomUUID } from 'node:crypto';
import type {
  AccountDto,
  BookingDto,
  ConsolidationBookingDto,
  ConsolidationDto,
  ConsolidationSummaryDto,
  ConsolidationsReportDto,
  CustomerDto,
  JournalEntryDto,
  Page,
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
    salesPts: '',
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
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
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

  it('clears the voyage on its shipments when the container clears it', async () => {
    const ids = [
      await lclShipment(customers[0], '1'),
      await lclShipment(customers[1], '1'),
    ] as const;
    const created = (await newContainer(ids).expect(201)).body as ConsolidationDto;
    await patch(`/consolidations/${created.id}`, cookies.opsJed, {
      carrierName: 'MSC',
      vesselName: 'MSC Borealis',
      voyageNumber: 'BR456',
      etd: d('05-01'),
      eta: d('05-09'),
    }).expect(200);
    for (const id of ids) {
      const s = await shipmentOf(id);
      expect([s.carrierName, s.vesselName, s.voyageNumber, s.etd, s.eta]).toEqual([
        'MSC',
        'MSC Borealis',
        'BR456',
        d('05-01'),
        d('05-09'),
      ]);
    }
    // An edit that does not send the voyage leaves the shipments' voyage alone.
    await patch(`/consolidations/${created.id}`, cookies.opsJed, { notes: 'Seal checked' }).expect(
      200,
    );
    expect((await shipmentOf(ids[0])).vesselName).toBe('MSC Borealis');

    await patch(`/consolidations/${created.id}`, cookies.opsJed, {
      carrierName: null,
      vesselName: null,
      voyageNumber: null,
      etd: null,
      eta: null,
    }).expect(200);
    const view = await container(created.id);
    expect([view.carrierName, view.vesselName, view.voyageNumber, view.etd, view.eta]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    for (const id of ids) {
      const s = await shipmentOf(id);
      expect([s.carrierName, s.vesselName, s.voyageNumber, s.etd, s.eta]).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    }
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
    // Another branch's user sees an open JED container (to book into) without JED's shipments,
    // and may not use a JED shipment in a container of theirs.
    const created = (await newContainer([lcl]).expect(201)).body as ConsolidationDto;
    const guest = await container(created.id, cookies.opsPts);
    expect(guest.ownBranch).toBe(false);
    expect(guest.shipments).toEqual([]);
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

  it('makes an LCL booking from inside an open container, confirmed and in the container', async () => {
    const created = (await newContainer([]).expect(201)).body as ConsolidationDto;
    const path = `/consolidations/${created.id}/bookings`;
    expect((await container(created.id, cookies.opsJed)).actions.canAddBooking).toBe(true);
    // Finance sees the container but makes no bookings.
    expect((await container(created.id, cookies.financeJed)).actions.canAddBooking).toBe(false);
    const body = {
      customerId: customers[0].id,
      destinationLocationId: portSudan,
      cargoType: 'GENERAL',
      services: ['CUSTOMS'],
      items: [{ cargoType: 'GENERAL', quantity: 3, weightKg: '300', volumeCbm: '2.5' }],
    };
    const bookingsOf = () => t.prisma.booking.count({ where: { customerId: customers[0].id } });
    const before = await bookingsOf();

    // Sales may not change containers, Warehouse only views them, PTS books only its customers.
    await post(path, cookies.salesJed, body).expect(403);
    await post(path, cookies.warehouseJed, body).expect(403);
    await post(path, cookies.opsPts, body).expect(404);
    // The route and mode are the container's, never the request's.
    await post(path, cookies.opsJed, { ...body, mode: 'ROAD' }).expect(400);
    await post(path, cookies.opsJed, { ...body, originLocationId: khartoum }).expect(400);
    // No cargo line: nothing is confirmed, so nothing is left behind.
    await post(path, cookies.opsJed, { ...body, items: [] }).expect(400);
    await post(path, cookies.opsJed, { ...body, customerId: randomUUID() }).expect(404);
    expect(await bookingsOf()).toBe(before);

    const made = (await post(path, cookies.opsJed, body).expect(201))
      .body as ConsolidationBookingDto;
    expect(made.bookingNumber).toMatch(/^BK\d{5,}$/);
    const booking = (await get(`/bookings/${made.bookingId}`, cookies.opsJed).expect(200))
      .body as BookingDto;
    expect(booking).toMatchObject({
      status: 'CONFIRMED',
      mode: 'SEA',
      loadType: 'LCL',
      originLocationId: jeddahPort,
      destinationLocationId: portSudan,
      shipmentId: made.shipmentId,
    });
    // NOLON carries the main freight in its own container.
    expect([...booking.services].sort()).toEqual(['CUSTOMS', 'MAIN_FREIGHT']);
    const view = await container(created.id, cookies.opsJed);
    expect(view.shipments.map((s) => s.shipmentNumber)).toEqual([made.shipmentNumber]);
    expect((await shipmentOf(made.shipmentId)).vesselName).toBe('MSC Aurora');

    // Once the container is closed, no booking is made from it and none is left behind.
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: made.shipmentId },
      data: { occurredAt: new Date(at('01-02')) },
    });
    await patch(`/consolidations/${created.id}`, cookies.opsJed, {
      containerNumber: 'MSCU1234565',
    }).expect(200);
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('05-01'),
    }).expect(200);
    expect((await container(created.id, cookies.opsJed)).actions.canAddBooking).toBe(false);
    await post(path, cookies.opsJed, body).expect(409);
    expect(await bookingsOf()).toBe(before + 1);
  });
  it('opens a container to every branch for booking; only its branch takes out or moves', async () => {
    const created = (await newContainer([]).expect(201)).body as ConsolidationDto;
    const spare = (await newContainer([]).expect(201)).body as ConsolidationDto;
    const ptsCustomer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `LCL Port Sudan ${randomUUID().slice(0, 6)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
    const shared = async (shipmentId: string) =>
      (await t.prisma.shipmentBranch.findMany({ where: { shipmentId } })).map((b) => b.branchId);

    // PTS lists JED's open containers to book into; Finance (no booking) may not ask for them.
    const bookable = (
      await get('/consolidations?bookable=true&pageSize=100', cookies.opsPts).expect(200)
    ).body as Page<ConsolidationSummaryDto>;
    expect(bookable.items.map((c) => c.id)).toEqual(expect.arrayContaining([created.id, spare.id]));
    expect(bookable.items.every((c) => c.status === 'OPEN')).toBe(true);
    await get('/consolidations?bookable=true', cookies.financeJed).expect(403);

    // PTS books its own customer into JED's container: the booking and shipment stay PTS's, the
    // shipment is shared with JED, which loads it.
    const body = {
      customerId: ptsCustomer.id,
      destinationLocationId: portSudan,
      cargoType: 'GENERAL',
      services: ['CUSTOMS'],
      items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100', volumeCbm: '1' }],
    };
    // Not a JED customer, though: PTS does not see them.
    await post(`/consolidations/${created.id}/bookings`, cookies.opsPts, {
      ...body,
      customerId: customers[0].id,
    }).expect(404);
    const made = (
      await post(`/consolidations/${created.id}/bookings`, cookies.opsPts, body).expect(201)
    ).body as ConsolidationBookingDto;
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { id: made.bookingId } });
    const shipment = await t.prisma.shipment.findUniqueOrThrow({ where: { id: made.shipmentId } });
    expect([booking.branchId, shipment.branchId]).toEqual([pts, pts]);
    expect(await shared(made.shipmentId)).toEqual([jed]);
    const jedShipment = await lclShipment(customers[0], '2');
    await post(`/consolidations/${created.id}/shipments`, cookies.opsJed, {
      shipmentId: jedShipment,
    }).expect(201);
    const full = await container(created.id, cookies.opsJed);
    expect(full.ownBranch).toBe(true);
    expect(full.shipments.map((s) => s.shipmentId).sort()).toEqual(
      [made.shipmentId, jedShipment].sort(),
    );

    // PTS sees its own shipment only, no costs, and may only add to the container.
    const guest = await container(created.id, cookies.opsPts);
    expect(guest.ownBranch).toBe(false);
    expect(guest.shipments.map((s) => s.shipmentId)).toEqual([made.shipmentId]);
    expect(guest.showsCost).toBe(false);
    expect(guest.clearingBalanceUsd).toBeNull();
    expect(guest.actions).toEqual({
      canEdit: false,
      canAddShipments: true,
      canEditShipments: false,
      canAddBooking: true,
      moves: [],
      canCancel: false,
    });

    // Only JED takes out, moves, edits, moves status or cancels: 403 with its reason code.
    const shipmentPath = `/consolidations/${created.id}/shipments/${made.shipmentId}`;
    expect(code(await del(shipmentPath, cookies.opsPts).expect(403))).toBe('CONTAINER_BRANCH_ONLY');
    expect(
      code(
        await post(`${shipmentPath}/move`, cookies.opsPts, { consolidationId: spare.id }).expect(
          403,
        ),
      ),
    ).toBe('CONTAINER_BRANCH_ONLY');
    await patch(`/consolidations/${created.id}`, cookies.opsPts, { notes: 'x' }).expect(403);
    await post(`/consolidations/${created.id}/status`, cookies.opsPts, {
      status: 'CLOSED',
    }).expect(403);
    await post(`/consolidations/${created.id}/cancel`, cookies.opsPts, { reason: 'x' }).expect(403);
    // PTS may not put JED's shipment anywhere: it does not see it.
    await post(`/consolidations/${spare.id}/shipments`, cookies.opsPts, {
      shipmentId: jedShipment,
    }).expect(404);

    // PTS puts one of its own booked shipments in the container: shared with JED too.
    const ptsBooking = (
      await post('/bookings', cookies.salesPts, {
        ...body,
        originLocationId: jeddahPort,
        mode: 'SEA',
        loadType: 'LCL',
        services: ['MAIN_FREIGHT'],
      }).expect(201)
    ).body as BookingDto;
    const ptsShipment = (
      (await post(`/bookings/${ptsBooking.id}/confirm`, cookies.salesPts).expect(200))
        .body as BookingDto
    ).shipmentId;
    if (!ptsShipment) throw new Error('No shipment');
    await post(`/consolidations/${created.id}/shipments`, cookies.opsPts, {
      shipmentId: ptsShipment,
    }).expect(201);
    expect(await shared(ptsShipment)).toEqual([jed]);
    // One container at a time, said with the shipment and the container.
    const twice = await post(`/consolidations/${spare.id}/shipments`, cookies.opsPts, {
      shipmentId: ptsShipment,
    }).expect(409);
    expect(twice.body).toMatchObject({
      code: 'SHIPMENT_IN_OTHER_CONTAINER',
      params: { container: created.number },
    });

    // JED moves PTS's shipment to its other open container, and takes the other one out.
    expect(
      code(
        await post(`${shipmentPath}/move`, cookies.opsJed, { consolidationId: created.id }).expect(
          400,
        ),
      ),
    ).toBe('SAME_CONTAINER');
    await post(`${shipmentPath}/move`, cookies.opsJed, { consolidationId: spare.id }).expect(200);
    expect((await container(spare.id, cookies.opsJed)).shipments.map((s) => s.shipmentId)).toEqual([
      made.shipmentId,
    ]);
    await del(`/consolidations/${created.id}/shipments/${ptsShipment}`, cookies.opsJed).expect(200);
    expect(
      (await container(created.id, cookies.opsJed)).shipments.map((s) => s.shipmentId),
    ).toEqual([jedShipment]);

    // Closed: nothing is booked into it, added, taken out or moved, and PTS (no shipment of its
    // own left in it) no longer sees it.
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: jedShipment },
      data: { occurredAt: new Date(at('01-02')) },
    });
    await patch(`/consolidations/${created.id}`, cookies.opsJed, {
      containerNumber: 'MSCU1234565',
    }).expect(200);
    await post(`/consolidations/${created.id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('05-01'),
    }).expect(200);
    await get(`/consolidations/${created.id}`, cookies.opsPts).expect(404);
    await post(`/consolidations/${created.id}/bookings`, cookies.opsPts, body).expect(404);
    const closedMove = await post(
      `/consolidations/${created.id}/shipments/${jedShipment}/move`,
      cookies.opsJed,
      { consolidationId: spare.id },
    ).expect(409);
    expect(closedMove.body).toMatchObject({
      code: 'CONTAINER_NOT_OPEN',
      params: { container: created.number },
    });
    expect(
      code(
        await post(
          `/consolidations/${spare.id}/shipments/${made.shipmentId}/move`,
          cookies.opsJed,
          {
            consolidationId: created.id,
          },
        ).expect(409),
      ),
    ).toBe('CONTAINER_NOT_OPEN');
    expect(
      code(
        await del(`/consolidations/${created.id}/shipments/${jedShipment}`, cookies.opsJed).expect(
          409,
        ),
      ),
    ).toBe('CONTAINER_NOT_OPEN');
    const bookableNow = (
      await get('/consolidations?bookable=true&pageSize=100', cookies.opsPts).expect(200)
    ).body as Page<ConsolidationSummaryDto>;
    expect(bookableNow.items.map((c) => c.id)).not.toContain(created.id);
    // PTS still opens the container holding its shipment, from the shipment's page too.
    expect((await container(spare.id, cookies.opsPts)).shipments.map((s) => s.shipmentId)).toEqual([
      made.shipmentId,
    ]);
    const ofShipment = (
      await get(`/shipments/${made.shipmentId}/consolidations`, cookies.opsPts).expect(200)
    ).body as ShipmentConsolidationDto[];
    expect(ofShipment).toEqual([expect.objectContaining({ id: spare.id, canOpen: true })]);
  });

  it('reports containers in the period with their shipments and customers (report 5)', async () => {
    const [a, b, c] = [
      await lclShipment(customers[0], '2'),
      await lclShipment(customers[1], '3'),
      await lclShipment(customers[0], '5'),
    ];
    const sailing = (await newContainer([a, b], { etd: d('09-10'), eta: d('09-20') }).expect(201))
      .body as ConsolidationDto;
    // No sailing date: it belongs to the day it was opened.
    const unscheduled = (await newContainer([c], { etd: null, eta: null }).expect(201))
      .body as ConsolidationDto;
    // Opened in September, sailing in October: an October container.
    const october = (await newContainer([], { etd: d('10-05'), eta: null }).expect(201))
      .body as ConsolidationDto;
    const cancelled = (await newContainer([], { etd: d('09-11'), eta: null }).expect(201))
      .body as ConsolidationDto;
    await post(`/consolidations/${cancelled.id}/cancel`, cookies.opsJed, {
      reason: 'Booked by mistake',
    }).expect(200);
    for (const id of [unscheduled.id, october.id]) {
      await t.prisma.consolidation.update({
        where: { id },
        data: { createdAt: new Date(at(id === october.id ? '09-12' : '09-15')) },
      });
    }

    const september = `from=${d('09-01')}&to=${d('09-30')}&branchId=${jed}`;
    const r = (await get(`/reports/consolidations?${september}`, cookies.opsJed).expect(200))
      .body as ConsolidationsReportDto;
    expect(r.containers.map((x) => x.number)).toEqual([sailing.number, unscheduled.number]);
    expect(r.byStatus).toEqual([{ status: 'OPEN', count: 2 }]);
    expect(r.totals).toEqual({
      containers: 2,
      shipments: 3,
      customers: 2,
      packages: 6,
      weightKg: '1500',
      volumeCbm: '10',
    });
    const [first, second] = r.containers;
    expect(first).toMatchObject({
      branchCode: 'JED',
      status: 'OPEN',
      containerTypeCode: '40HC',
      day: d('09-10'),
      etd: d('09-10'),
      eta: d('09-20'),
      vesselName: 'MSC Aurora',
      shipments: 2,
      customers: 2,
      volumeCbm: '5',
    });
    expect(first?.origin.code).toBe('SAJED');
    expect(first?.contents.map((x) => [x.shipmentId, x.customerId, x.volumeCbm])).toEqual([
      [a, customers[0].id, '2'],
      [b, customers[1].id, '3'],
    ]);
    expect(second).toMatchObject({ day: d('09-15'), etd: null, shipments: 1, customers: 1 });

    // Cancelled containers only when asked for.
    const gone = (
      await get(`/reports/consolidations?${september}&status=CANCELLED`, cookies.opsJed).expect(200)
    ).body as ConsolidationsReportDto;
    expect(gone.containers.map((x) => x.number)).toEqual([cancelled.number]);

    // The Excel export.
    const file = await get(`/reports/consolidations/export?${september}&locale=en`, cookies.opsJed)
      .buffer(true)
      .expect(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');

    // Another branch's user does not see Jeddah's containers, nor may ask for them.
    await get(`/reports/consolidations?${september}`, cookies.opsPts).expect(403);
    const pts = (
      await get(
        `/reports/consolidations?from=${d('09-01')}&to=${d('09-30')}`,
        cookies.opsPts,
      ).expect(200)
    ).body as ConsolidationsReportDto;
    expect(pts.containers).toEqual([]);
    // Sales has operational reports but not consolidation.
    await get(`/reports/consolidations?${september}`, cookies.salesJed).expect(403);
    // Strict filters.
    await get(`/reports/consolidations?${september}&status=SAILING`, cookies.opsJed).expect(400);
    await get(`/reports/consolidations?from=${d('09-30')}&to=${d('09-01')}`, cookies.opsJed).expect(
      400,
    );
  });
});
