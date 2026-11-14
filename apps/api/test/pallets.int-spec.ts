import { randomInt, randomUUID } from 'node:crypto';
import type {
  BookingDto,
  ConsolidationDto,
  CustomerDto,
  DriverDto,
  PalletDto,
  ShipmentDto,
  TripDto,
  VehicleDto,
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
 * Plan 15-3: pallets move what they carry. A closed pallet goes in a container or on a trip as a
 * whole, moves its shipments by itself all or nothing, and holds them against single removes,
 * cancels and reverts. Pallets keep their users (RESTRICT), so these are LEDGER users.
 */
describe('pallets (plan 15-3)', () => {
  let t: TestApp;
  let off: TestApp;
  let jed: string;
  let pts: string;
  let jeddahPort: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  let ptsCustomer: CustomerDto;
  let store: WarehouseDto;
  let ptsStore: WarehouseDto;
  const year = randomInt(1901, 2000);
  const at = (monthDay: string) => `${year}-${monthDay}T08:00:00+03:00`;
  const cookies = {
    admin: '',
    managerJed: '',
    warehouseJed: '',
    salesJed: '',
    opsJed: '',
    warehousePts: '',
    managerPts: '',
    salesPts: '',
  };

  const get = (path: string, cookie: string, app = t) =>
    app.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}, app = t) =>
    app.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const del = (path: string, cookie: string) =>
    t.http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const shipmentOf = async (id: string) =>
    (await get(`/shipments/${id}`, cookies.admin).expect(200)).body as ShipmentDto;

  /** A confirmed Jeddah → Port Sudan LCL shipment of the JED customer, dated in the test year. */
  async function lclShipment(): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesJed, {
        customerId: customer.id,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 2, weightKg: '100', volumeCbm: '1' }],
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

  /** A confirmed Port Sudan → Khartoum road shipment of PTS. */
  async function roadShipment(): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: ptsCustomer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 3, weightKg: '300' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  const newPallet = async (warehouseId = store.id, cookie = cookies.warehouseJed) =>
    (await post('/pallets', cookie, { warehouseId }).expect(201)).body as PalletDto;
  const add = (palletId: string, shipmentId: string, cookie = cookies.warehouseJed) =>
    post(`/pallets/${palletId}/shipments`, cookie, { shipmentId });
  const close = async (palletId: string) =>
    (await post(`/pallets/${palletId}/close`, cookies.warehouseJed).expect(200)).body as PalletDto;
  const newContainer = async (shipmentIds: string[] = []) =>
    (
      await post('/consolidations', cookies.opsJed, {
        branchId: jed,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        containerTypeCode: '40HC',
        shipmentIds,
      }).expect(201)
    ).body as ConsolidationDto;

  beforeAll(async () => {
    t = await createTestApp({ PALLETS_ENABLED: true });
    off = await createTestApp({ PALLETS_ENABLED: false });
    jed = await branchId(t.prisma, 'JED');
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (c: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code: c } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      managerJed: await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'], LEDGER_PREFIX),
      warehouseJed: await createUser(t.prisma, ['WAREHOUSE'], ['JED'], LEDGER_PREFIX),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
      warehousePts: await createUser(t.prisma, ['WAREHOUSE'], ['PTS'], LEDGER_PREFIX),
      managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    customer = (
      await post('/customers', cookies.salesJed, {
        branchId: jed,
        kind: 'COMPANY',
        name: `Pallet Customer ${year} ${suffix}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    ptsCustomer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Pallet Road Customer ${year} ${suffix}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    store = (
      await post('/warehouses', cookies.warehouseJed, {
        branchId: jed,
        code: `PLA-${suffix}`,
        nameEn: 'Pallet store',
        nameAr: 'مستودع الطبالي',
      }).expect(201)
    ).body as WarehouseDto;
    ptsStore = (
      await post('/warehouses', cookies.warehousePts, {
        branchId: pts,
        code: `PLB-${suffix}`,
        nameEn: 'PTS pallet store',
        nameAr: 'مستودع طبالي بورتسودان',
      }).expect(201)
    ).body as WarehouseDto;
  });

  afterAll(async () => {
    await t.close();
    await off.close();
  });

  it('is 404 while the switch is off', async () => {
    await get('/pallets', cookies.warehouseJed, off).expect(404);
    await post('/pallets', cookies.warehouseJed, { warehouseId: store.id }, off).expect(404);
  });

  it('fills, closes and refuses what a pallet cannot hold', async () => {
    const pallet = await newPallet();
    expect(pallet.number).toMatch(/^JED-P\d{4,}$/);
    expect(pallet).toMatchObject({ status: 'OPEN', shipmentCount: 0, carrier: null });
    expect(code(await post(`/pallets/${pallet.id}/close`, cookies.warehouseJed).expect(409))).toBe(
      'PALLET_EMPTY',
    );
    const [a, b] = [await lclShipment(), await lclShipment()];
    await add(pallet.id, a).expect(201);
    const filled = (await add(pallet.id, b).expect(201)).body as PalletDto;
    expect(filled.shipments.map((s) => s.shipmentId).sort()).toEqual([a, b].sort());

    // One live pallet per shipment.
    const other = await newPallet();
    const taken = await add(other.id, a).expect(409);
    expect(code(taken)).toBe('PALLET_SHIPMENT_TAKEN');
    expect((taken.body as { params?: object }).params).toMatchObject({ pallet: pallet.number });

    // A shipment on a live pallet is not cancelled.
    const cancel = await post(`/shipments/${a}/cancel`, cookies.admin, { reason: 'Withdrawn' });
    expect([cancel.status, code(cancel)]).toEqual([409, 'SHIPMENT_CANCEL_ON_PALLET']);

    // Removing from an open pallet frees the shipment.
    await del(`/pallets/${pallet.id}/shipments/${b}`, cookies.warehouseJed).expect(200);
    await add(other.id, b).expect(201);

    const closed = await close(pallet.id);
    expect(closed.status).toBe('CLOSED');
    expect(code(await add(pallet.id, await lclShipment()).expect(409))).toBe('PALLET_NOT_OPEN');
    expect(
      code(await del(`/pallets/${pallet.id}/shipments/${a}`, cookies.warehouseJed).expect(409)),
    ).toBe('PALLET_NOT_OPEN');
  });

  it('refuses another branch, a missing permission and a shipment already in a container', async () => {
    const pallet = await newPallet();
    // The PTS warehouse does not see a JED pallet, nor make one in a JED warehouse.
    await get(`/pallets/${pallet.id}`, cookies.warehousePts).expect(404);
    await post('/pallets', cookies.warehousePts, { warehouseId: store.id }).expect(404);
    // Sales only view warehouses.
    await post('/pallets', cookies.salesJed, { warehouseId: store.id }).expect(403);
    await add(pallet.id, await lclShipment(), cookies.salesJed).expect(403);
    // A shipment of another branch (the administrator sees it) stays off a JED pallet.
    const road = await roadShipment();
    expect(code(await add(pallet.id, road, cookies.admin).expect(400))).toBe(
      'PALLET_SHIPMENT_OTHER_BRANCH',
    );
    // A JED warehouse user does not see that shipment at all.
    await add(pallet.id, road).expect(404);
    // In a container already: take it out first.
    const inside = await lclShipment();
    const container = await newContainer([inside]);
    const carried = await add(pallet.id, inside).expect(409);
    expect(code(carried)).toBe('PALLET_SHIPMENT_CARRIED');
    expect((carried.body as { params?: object }).params).toMatchObject({
      carrier: container.number,
    });
  });

  it('goes in and out of a container only whole; the container moves it then', async () => {
    const [a, b] = [await lclShipment(), await lclShipment()];
    const pallet = await newPallet();
    await add(pallet.id, a).expect(201);
    await add(pallet.id, b).expect(201);
    const container = await newContainer();

    // A shipment on a live pallet does not go in alone.
    const alone = await post(`/consolidations/${container.id}/shipments`, cookies.opsJed, {
      shipmentId: a,
    }).expect(409);
    expect(code(alone)).toBe('SHIPMENT_ON_PALLET');

    // Open pallets do not go in; the warehouse role cannot load containers.
    expect(
      code(
        await post(`/pallets/${pallet.id}/container`, cookies.managerJed, {
          consolidationId: container.id,
        }).expect(409),
      ),
    ).toBe('PALLET_NOT_CLOSED');
    await close(pallet.id);
    await post(`/pallets/${pallet.id}/container`, cookies.warehouseJed, {
      consolidationId: container.id,
    }).expect(403);

    const inside = (
      await post(`/pallets/${pallet.id}/container`, cookies.managerJed, {
        consolidationId: container.id,
      }).expect(200)
    ).body as PalletDto;
    expect(inside.carrier).toMatchObject({ kind: 'CONTAINER', number: container.number });
    expect(inside.actions).toMatchObject({ takeOut: true, unpack: false, cancel: false });
    const loaded = (await get(`/consolidations/${container.id}`, cookies.opsJed).expect(200))
      .body as ConsolidationDto;
    expect(loaded.shipments.map((s) => s.shipmentId).sort()).toEqual([a, b].sort());

    // No part of the pallet leaves the container; a carried pallet is not unpacked.
    expect(
      code(await del(`/consolidations/${container.id}/shipments/${a}`, cookies.opsJed).expect(409)),
    ).toBe('SHIPMENT_ON_PALLET');
    const target = await newContainer();
    expect(
      code(
        await post(`/consolidations/${container.id}/shipments/${a}/move`, cookies.opsJed, {
          consolidationId: target.id,
        }).expect(409),
      ),
    ).toBe('SHIPMENT_ON_PALLET');
    expect(code(await post(`/pallets/${pallet.id}/unpack`, cookies.warehouseJed).expect(409))).toBe(
      'PALLET_CARRIED',
    );
    // Put in again elsewhere while carried: refused.
    expect(
      code(
        await post(`/pallets/${pallet.id}/container`, cookies.managerJed, {
          consolidationId: target.id,
        }).expect(409),
      ),
    ).toBe('PALLET_CARRIED');

    // Taking it out changes the container: the warehouse role cannot (F231-1).
    await post(`/pallets/${pallet.id}/take-out`, cookies.warehouseJed).expect(403);
    expect(
      ((await get(`/pallets/${pallet.id}`, cookies.warehouseJed).expect(200)).body as PalletDto)
        .actions.takeOut,
    ).toBe(false);

    // The whole pallet comes out of the open container.
    const out = (await post(`/pallets/${pallet.id}/take-out`, cookies.managerJed).expect(200))
      .body as PalletDto;
    expect(out.carrier).toBeNull();
    const emptied = (await get(`/consolidations/${container.id}`, cookies.opsJed).expect(200))
      .body as ConsolidationDto;
    expect(emptied.shipments).toEqual([]);
    // Carried once, so it is unpacked rather than cancelled.
    expect(
      code(
        await post(`/pallets/${pallet.id}/cancel`, cookies.warehouseJed, {
          reason: 'Built wrong',
        }).expect(409),
      ),
    ).toBe('PALLET_NOT_CANCELLABLE');
  });

  it('unpacks to free its shipments; cancels only a pallet never carried', async () => {
    const [a, b] = [await lclShipment(), await lclShipment()];
    const pallet = await newPallet();
    await add(pallet.id, a).expect(201);
    await add(pallet.id, b).expect(201);
    expect(code(await post(`/pallets/${pallet.id}/unpack`, cookies.warehouseJed).expect(409))).toBe(
      'PALLET_NOT_CLOSED',
    );
    await close(pallet.id);
    const unpacked = (await post(`/pallets/${pallet.id}/unpack`, cookies.warehouseJed).expect(200))
      .body as PalletDto;
    expect(unpacked).toMatchObject({ status: 'UNPACKED', actions: { cancel: false } });
    // Each shipment goes on by itself: into a container alone, or onto another pallet.
    const container = await newContainer();
    await post(`/consolidations/${container.id}/shipments`, cookies.opsJed, {
      shipmentId: a,
    }).expect(201);
    const next = await newPallet();
    await add(next.id, b).expect(201);
    // Cancelling needs warehouse:cancel and a reason; it frees the shipments too.
    await post(`/pallets/${next.id}/cancel`, cookies.salesJed, { reason: 'Built wrong' }).expect(
      403,
    );
    const cancelled = (
      await post(`/pallets/${next.id}/cancel`, cookies.warehouseJed, {
        reason: 'Built wrong',
      }).expect(200)
    ).body as PalletDto;
    expect(cancelled.status).toBe('CANCELLED');
    await add((await newPallet()).id, b).expect(201);
  });

  it('goes on a planned trip whole and comes off whole', async () => {
    const [a, b, c] = [await roadShipment(), await roadShipment(), await roadShipment()];
    const pallet = await newPallet(ptsStore.id, cookies.warehousePts);
    await add(pallet.id, a, cookies.warehousePts).expect(201);
    await add(pallet.id, b, cookies.warehousePts).expect(201);
    await post(`/pallets/${pallet.id}/close`, cookies.warehousePts).expect(200);
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const vehicle = (
      await post('/transport/vehicles', cookies.managerPts, {
        branchId: pts,
        plateNumber: `PL ${suffix}`,
        vehicleType: 'Flatbed trailer',
      }).expect(201)
    ).body as VehicleDto;
    const driver = (
      await post('/transport/drivers', cookies.managerPts, {
        branchId: pts,
        name: `Pallet Driver ${suffix}`,
      }).expect(201)
    ).body as DriverDto;
    const trip = (
      await post('/trips', cookies.managerPts, {
        branchId: pts,
        kind: 'OWN',
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        vehicleId: vehicle.id,
        driverId: driver.id,
        shipmentIds: [c],
      }).expect(201)
    ).body as TripDto;

    // A shipment on a live pallet does not go on a trip alone.
    expect(
      code(
        await post(`/trips/${trip.id}/shipments`, cookies.managerPts, { shipmentId: a }).expect(
          409,
        ),
      ),
    ).toBe('SHIPMENT_ON_PALLET');

    const on = (
      await post(`/pallets/${pallet.id}/trip`, cookies.managerPts, { tripId: trip.id }).expect(200)
    ).body as PalletDto;
    expect(on.carrier).toMatchObject({ kind: 'TRIP', number: trip.number });
    expect((await shipmentOf(a)).status).toBe('TRIP_SCHEDULED');
    expect(
      code(await del(`/trips/${trip.id}/shipments/${a}`, cookies.managerPts).expect(409)),
    ).toBe('SHIPMENT_ON_PALLET');

    // Taking it off changes the trip: the warehouse role cannot (F231-1).
    await post(`/pallets/${pallet.id}/take-out`, cookies.warehousePts).expect(403);
    await post(`/pallets/${pallet.id}/take-out`, cookies.managerPts).expect(200);
    const after = (await get(`/trips/${trip.id}`, cookies.managerPts).expect(200)).body as TripDto;
    expect(after.shipments.map((s) => s.shipmentId)).toEqual([c]);
  });
});
