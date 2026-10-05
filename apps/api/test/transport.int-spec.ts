import type {
  AccountDto,
  BookingDto,
  CarrierDto,
  CustomerDto,
  DriverDto,
  JournalEntryDto,
  Page,
  PodDto,
  ShipmentDto,
  ShipmentPodsDto,
  ShipmentSummaryDto,
  ShipmentTripDto,
  TripDto,
  TripSummaryDto,
  VehicleDto,
} from '@nolon/shared';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutoJournalService } from '../src/accounting/auto-journal.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, uniquePhone, waitForLockWaiter } from './test-data.js';

/** A PNG signature header is enough for the content check (magic bytes). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** Waits until at least `n` sessions are blocked on a row lock. */
async function waitForLockWaiters(prisma: PrismaService, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS "n" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`;
    if ((rows[0]?.n ?? 0n) >= BigInt(n)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fewer than ${n} requests waited on the lock`);
}

function helpers(t: () => TestApp) {
  return {
    get: (path: string, cookie: string) => t().http().get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, cookie: string, body: object = {}) =>
      t().http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    patch: (path: string, cookie: string, body: object) =>
      t().http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    del: (path: string, cookie: string) =>
      t().http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie),
    put: (path: string, cookie: string, body: object) =>
      t().http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  };
}

describe('inland transport: fleet, trips, POD', () => {
  let t: TestApp;
  let dxb: string;
  let pts: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  let vehicle: VehicleDto;
  let driverOwn: DriverDto;
  let driverOther: DriverDto;
  let carrier: CarrierDto;
  const users: Record<string, { id: string; email: string }> = {};
  const cookies = {
    admin: '',
    opsDxb: '',
    opsJed: '',
    salesDxb: '',
    warehouseDxb: '',
    customsDxb: '',
    driver: '',
    driver2: '',
    driver3: '',
    opsBoth: '',
  };
  const { get, post, patch } = helpers(() => t);

  /** A confirmed road booking (main freight) of the DXB customer; its shipment. */
  async function roadShipment(items?: object[]): Promise<ShipmentDto> {
    const booking = (
      await post('/bookings', cookies.opsDxb, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: items ?? [{ cargoType: 'GENERAL', quantity: 4, weightKg: '400' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsDxb).expect(200))
      .body as BookingDto;
    return (await get(`/shipments/${confirmed.shipmentId}`, cookies.opsDxb).expect(200))
      .body as ShipmentDto;
  }

  const ownTrip = (shipmentIds: string[], driverId = driverOwn.id) => ({
    branchId: dxb,
    kind: 'OWN',
    originLocationId: portSudan,
    destinationLocationId: khartoum,
    vehicleId: vehicle.id,
    driverId,
    shipmentIds,
  });

  const status = async (id: string) =>
    (await t.prisma.shipment.findUniqueOrThrow({ where: { id } })).status;
  /** Where the shipment is now, as the public tracking page shows it. */
  const location = async (id: string) =>
    (await t.prisma.shipment.findUniqueOrThrow({ where: { id } })).currentLocationId;

  const recordPod = (shipmentId: string, cookie: string, fields: Record<string, string>) => {
    let req = t
      .http()
      .post(`/api/v1/shipments/${shipmentId}/pods`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie);
    for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
    return req;
  };

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    Object.assign(users, {
      admin: await createUser(t.prisma, ['ADMINISTRATOR']),
      opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED']),
      salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
      warehouseDxb: await createUser(t.prisma, ['WAREHOUSE'], ['DXB']),
      customsDxb: await createUser(t.prisma, ['CUSTOMS'], ['DXB']),
      driver: await createUser(t.prisma, ['DRIVER'], ['DXB']),
      driver2: await createUser(t.prisma, ['DRIVER'], ['DXB']),
      driver3: await createUser(t.prisma, ['DRIVER'], ['DXB']),
      opsBoth: await createUser(t.prisma, ['OPERATIONS'], ['DXB', 'PTS']),
    });
    for (const key of Object.keys(cookies) as (keyof typeof cookies)[]) {
      const u = users[key];
      if (!u) throw new Error(`No user ${key}`);
      cookies[key] = await signIn(t, u.email);
    }
    customer = (
      await post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Transport Test Trading',
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('fleet master data', () => {
    it('a branch manages its own vehicles and drivers; carriers are shared', async () => {
      vehicle = (
        await post('/transport/vehicles', cookies.opsDxb, {
          branchId: dxb,
          plateNumber: 'zz dxb 101',
          vehicleType: 'Flatbed trailer',
          capacityKg: '25000',
        }).expect(201)
      ).body as VehicleDto;
      expect(vehicle).toMatchObject({ plateNumber: 'ZZ DXB 101', capacityKg: '25000' });
      await post('/transport/vehicles', cookies.admin, {
        branchId: pts,
        plateNumber: 'ZZ DXB 101',
        vehicleType: 'x',
      }).expect(409);
      await post('/transport/vehicles', cookies.opsDxb, {
        branchId: pts,
        plateNumber: 'ZZ PTS 1',
        vehicleType: 'x',
      }).expect(403);
      await post('/transport/vehicles', cookies.salesDxb, {
        branchId: dxb,
        plateNumber: 'ZZ X',
        vehicleType: 'x',
      }).expect(403);
      await post('/transport/vehicles', cookies.opsDxb, {
        branchId: dxb,
        plateNumber: 'ZZ Y',
        vehicleType: 'x',
        capacityKg: '0',
      }).expect(400);
      const jedList = (await get('/transport/vehicles', cookies.opsJed).expect(200))
        .body as VehicleDto[];
      expect(jedList.map((v) => v.id)).not.toContain(vehicle.id);
      await patch(`/transport/vehicles/${vehicle.id}`, cookies.opsJed, {
        vehicleType: 'x',
      }).expect(404);

      driverOwn = (
        await post('/transport/drivers', cookies.opsDxb, {
          branchId: dxb,
          name: 'ZZ Driver One',
          phone: '+249912000001',
          licenseNumber: 'L-1',
          userId: users.driver?.id,
        }).expect(201)
      ).body as DriverDto;
      expect(driverOwn).toMatchObject({ userId: users.driver?.id, userName: 'Integration Test' });
      // Only an active user with the Driver role in the driver's branch can be linked.
      await post('/transport/drivers', cookies.opsDxb, {
        branchId: dxb,
        name: 'ZZ Not a driver',
        userId: users.salesDxb?.id,
      }).expect(400);
      // One driver record per user.
      await post('/transport/drivers', cookies.opsDxb, {
        branchId: dxb,
        name: 'ZZ Duplicate',
        userId: users.driver?.id,
      }).expect(409);
      driverOther = (
        await post('/transport/drivers', cookies.opsDxb, {
          branchId: dxb,
          name: 'ZZ Driver Two',
          userId: users.driver2?.id,
        }).expect(201)
      ).body as DriverDto;
      const options = (await get('/transport/driver-users', cookies.opsDxb).expect(200)).body as {
        id: string;
      }[];
      expect(options.map((o) => o.id)).toEqual(
        expect.arrayContaining([users.driver?.id, users.driver2?.id]),
      );

      carrier = (
        await post('/transport/carriers', cookies.opsDxb, {
          name: 'ZZ Nile Trucking',
          phone: '+249912000002',
        }).expect(201)
      ).body as CarrierDto;
      await post('/transport/carriers', cookies.opsDxb, { name: 'ZZ Nile Trucking' }).expect(409);
      const carriers = (await get('/transport/carriers', cookies.opsJed).expect(200))
        .body as CarrierDto[];
      expect(carriers.map((c) => c.id)).toContain(carrier.id);
      await get('/transport/carriers', cookies.customsDxb).expect(403);
      await get('/transport/vehicles', cookies.driver).expect(403);
    });
  });

  describe('trips', () => {
    it('putting shipments on a trip schedules them; wrong branch 403/404, no permission 403', async () => {
      const [a, b] = [await roadShipment(), await roadShipment()];
      if (!a || !b) throw new Error('No shipments');
      const trip = (await post('/trips', cookies.opsDxb, ownTrip([a.id, b.id])).expect(201))
        .body as TripDto;
      expect(trip).toMatchObject({
        status: 'PLANNED',
        kind: 'OWN',
        vehicleLabel: 'ZZ DXB 101',
        driverLabel: 'ZZ Driver One',
        shipmentCount: 2,
      });
      expect(trip.number).toMatch(/^NOL-TRP-\d{4}-\d{6}$/);
      expect(trip.actions).toMatchObject({ moves: ['DEPARTED'], canCancel: true });
      expect(await status(a.id)).toBe('TRIP_SCHEDULED');
      expect(await status(b.id)).toBe('TRIP_SCHEDULED');
      const event = await t.prisma.shipmentEvent.findFirstOrThrow({
        where: { shipmentId: a.id, status: 'TRIP_SCHEDULED' },
      });
      expect(event.note).toBe(trip.number);

      // The trips panel of the shipment page.
      const legs = (await get(`/shipments/${a.id}/trips`, cookies.opsDxb).expect(200))
        .body as ShipmentTripDto[];
      expect(legs.map((l) => l.number)).toEqual([trip.number]);

      // Wrong branch: creating in another branch is 403, reading another branch's trip 404.
      await post('/trips', cookies.opsDxb, { ...ownTrip([a.id]), branchId: pts }).expect(403);
      await get(`/trips/${trip.id}`, cookies.opsJed).expect(404);
      await post(`/trips/${trip.id}/status`, cookies.opsJed, { status: 'DEPARTED' }).expect(404);
      const jedList = (await get('/trips', cookies.opsJed).expect(200))
        .body as Page<TripSummaryDto>;
      expect(jedList.items.map((x) => x.id)).not.toContain(trip.id);
      // Missing permission.
      await post('/trips', cookies.salesDxb, ownTrip([a.id])).expect(403);
      await post(`/trips/${trip.id}/status`, cookies.warehouseDxb, {
        status: 'DEPARTED',
      }).expect(403);
      await get('/trips', cookies.customsDxb).expect(403);
      await post(`/trips/${trip.id}/cancel`, cookies.warehouseDxb, { reason: 'x' }).expect(403);
      // A shipment is on one planned or departed trip at a time.
      await post('/trips', cookies.opsDxb, ownTrip([a.id])).expect(409);
      // Own vs external consistency.
      await post('/trips', cookies.opsDxb, {
        ...ownTrip([a.id]),
        carrierId: carrier.id,
      }).expect(400);
      await post('/trips', cookies.opsDxb, {
        ...ownTrip([a.id]),
        kind: 'EXTERNAL',
        vehicleId: undefined,
        driverId: undefined,
      }).expect(400);
      await post('/trips', cookies.opsDxb, {
        ...ownTrip([a.id]),
        destinationLocationId: portSudan,
      }).expect(400);
    });

    it('a cancelled shipment cannot be added to a trip', async () => {
      const [a, cancelled] = [await roadShipment(), await roadShipment()];
      if (!a || !cancelled) throw new Error('No shipments');
      await post(`/shipments/${cancelled.id}/cancel`, cookies.opsDxb, {
        reason: 'Customer withdrew',
      }).expect(200);
      await post('/trips', cookies.opsDxb, ownTrip([a.id, cancelled.id])).expect(409);
      // Nothing was applied: no trip, the other shipment did not move.
      expect(await status(a.id)).toBe('CREATED');
      expect(await t.prisma.tripShipment.count({ where: { shipmentId: a.id } })).toBe(0);

      const trip = (await post('/trips', cookies.opsDxb, ownTrip([a.id])).expect(201))
        .body as TripDto;
      await post(`/trips/${trip.id}/shipments`, cookies.opsDxb, {
        shipmentId: cancelled.id,
      }).expect(409);
      const after = (await get(`/trips/${trip.id}`, cookies.opsDxb).expect(200)).body as TripDto;
      expect(after.shipments.map((s) => s.shipmentId)).toEqual([a.id]);
    });

    it('a trip move a shipment cannot take is refused with 409 and nothing applied', async () => {
      const [a, b] = [await roadShipment(), await roadShipment()];
      if (!a || !b) throw new Error('No shipments');
      const trip = (await post('/trips', cookies.opsDxb, ownTrip([a.id, b.id])).expect(201))
        .body as TripDto;
      await post(`/shipments/${b.id}/hold`, cookies.opsDxb, { reason: 'Papers missing' }).expect(
        200,
      );
      const refused = await post(`/trips/${trip.id}/status`, cookies.opsDxb, {
        status: 'DEPARTED',
      }).expect(409);
      expect((refused.body as { message: string }).message).toContain(b.number);
      expect(await status(a.id)).toBe('TRIP_SCHEDULED');
      expect(await status(b.id)).toBe('ON_HOLD');
      const still = (await get(`/trips/${trip.id}`, cookies.opsDxb).expect(200)).body as TripDto;
      expect(still).toMatchObject({ status: 'PLANNED', actualDeparture: null });

      await post(`/shipments/${b.id}/resume`, cookies.opsDxb, {}).expect(200);
      const departed = (
        await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'DEPARTED' }).expect(200)
      ).body as TripDto;
      expect(departed.status).toBe('DEPARTED');
      expect(await status(a.id)).toBe('ROAD_DEPARTED');
      expect(await status(b.id)).toBe('ROAD_DEPARTED');
      // One step at a time; a departed trip is not cancelled and its shipments are fixed.
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'COMPLETED' }).expect(409);
      await post(`/trips/${trip.id}/cancel`, cookies.opsDxb, { reason: 'x' }).expect(409);
      await t
        .http()
        .delete(`/api/v1/trips/${trip.id}/shipments/${a.id}`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.opsDxb)
        .expect(409);
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, {
        status: 'ARRIVED',
        occurredAt: future,
      }).expect(400);
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'ARRIVED' }).expect(200);
      expect(await status(a.id)).toBe('ROAD_ARRIVED');
      const done = (
        await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'COMPLETED' }).expect(200)
      ).body as TripDto;
      expect(done).toMatchObject({ status: 'COMPLETED', accrualJournalEntryId: null });
      // An arrived shipment can take its next road leg.
      const next = (await post('/trips', cookies.opsDxb, ownTrip([a.id])).expect(201))
        .body as TripDto;
      expect(await status(a.id)).toBe('TRIP_SCHEDULED');
      await post(`/trips/${next.id}/cancel`, cookies.opsDxb, { reason: 'Truck broke down' }).expect(
        200,
      );
    });

    it('a Driver sees and acts on their own trips only, and records the POD', async () => {
      const [mine, other] = [await roadShipment(), await roadShipment()];
      if (!mine || !other) throw new Error('No shipments');
      const own = (await post('/trips', cookies.opsDxb, ownTrip([mine.id])).expect(201))
        .body as TripDto;
      const others = (
        await post('/trips', cookies.opsDxb, ownTrip([other.id], driverOther.id)).expect(201)
      ).body as TripDto;

      const list = (await get('/trips', cookies.driver).expect(200)).body as Page<TripSummaryDto>;
      expect(list.items.map((x) => x.id)).toContain(own.id);
      expect(list.items.map((x) => x.id)).not.toContain(others.id);
      await get(`/trips/${others.id}`, cookies.driver).expect(404);
      await post(`/trips/${others.id}/status`, cookies.driver, { status: 'DEPARTED' }).expect(404);
      const shipments = (await get('/shipments', cookies.driver).expect(200))
        .body as Page<ShipmentSummaryDto>;
      expect(shipments.items.map((s) => s.id)).toContain(mine.id);
      expect(shipments.items.map((s) => s.id)).not.toContain(other.id);
      await get(`/shipments/${other.id}`, cookies.driver).expect(404);
      await get(`/shipments/${other.id}/pods`, cookies.driver).expect(404);
      // A driver does not plan trips or change their shipments.
      await post('/trips', cookies.driver, ownTrip([mine.id])).expect(403);
      await post(`/trips/${own.id}/shipments`, cookies.driver, { shipmentId: other.id }).expect(
        403,
      );

      const view = (await get(`/trips/${own.id}`, cookies.driver).expect(200)).body as TripDto;
      expect(view.actions).toMatchObject({
        moves: ['DEPARTED'],
        canCancel: false,
        canEditShipments: false,
        canAddExpense: false,
      });
      await post(`/trips/${own.id}/status`, cookies.driver, { status: 'DEPARTED' }).expect(200);
      expect(await location(mine.id)).toBe(portSudan);
      await post(`/trips/${own.id}/status`, cookies.driver, { status: 'ARRIVED' }).expect(200);
      expect(await status(mine.id)).toBe('ROAD_ARRIVED');
      // The tracking page follows the trip: the shipment is now at its destination.
      expect(await location(mine.id)).toBe(khartoum);

      const pods = (await get(`/shipments/${mine.id}/pods`, cookies.driver).expect(200))
        .body as ShipmentPodsDto;
      expect(pods.actions).toMatchObject({
        canRecord: true,
        defaultStatus: 'DELIVERED',
        trips: [{ id: own.id, number: own.number }],
      });
      // The signature is required and must be a PNG.
      await recordPod(mine.id, cookies.driver, {
        recipientName: 'Ahmed Ali',
        recipientCapacity: 'Consignee',
      }).expect(400);
      await recordPod(mine.id, cookies.driver, {
        recipientName: 'Ahmed Ali',
        recipientCapacity: 'Consignee',
      })
        .attach('signature', PDF, 'signature.png')
        .expect(400);
      // Another driver's shipment: not found.
      await recordPod(other.id, cookies.driver, {
        recipientName: 'x',
        recipientCapacity: 'x',
      })
        .attach('signature', PNG, 'signature.png')
        .expect(404);

      const pod = (
        await recordPod(mine.id, cookies.driver, {
          recipientName: 'Ahmed Ali',
          recipientCapacity: 'Consignee',
          packages: '4',
          shipmentStatus: 'DELIVERED',
        })
          .attach('signature', PNG, 'signature.png')
          .attach('photos', PNG, 'goods.png')
          .expect(201)
      ).body as PodDto;
      expect(pod).toMatchObject({
        recipientName: 'Ahmed Ali',
        tripId: own.id,
        packages: 4,
        statusApplied: 'DELIVERED',
      });
      expect(pod.number).toMatch(/^NOL-POD-\d{4}-\d{6}$/);
      expect(pod.photos).toHaveLength(1);
      expect(await status(mine.id)).toBe('DELIVERED');
      const signature = await get(
        `/shipments/${mine.id}/documents/${pod.signatureDocumentId}/file`,
        cookies.driver,
      ).expect(200);
      expect(signature.headers['content-type']).toContain('image/png');
      // Delivered: no further POD.
      await recordPod(mine.id, cookies.driver, { recipientName: 'x', recipientCapacity: 'x' })
        .attach('signature', PNG, 'signature.png')
        .expect(409);
      // Another branch cannot see the PODs.
      await get(`/shipments/${mine.id}/pods`, cookies.opsJed).expect(404);
      await get(`/shipments/${mine.id}/pods`, cookies.customsDxb).expect(403);
    });

    it('a planned trip can be cancelled; its shipments go on another trip', async () => {
      const a = await roadShipment();
      const trip = (await post('/trips', cookies.opsDxb, ownTrip([a.id])).expect(201))
        .body as TripDto;
      await post(`/trips/${trip.id}/cancel`, cookies.opsDxb, {}).expect(400);
      const cancelled = (
        await post(`/trips/${trip.id}/cancel`, cookies.opsDxb, { reason: 'Rescheduled' }).expect(
          200,
        )
      ).body as TripDto;
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Rescheduled' });
      expect(await status(a.id)).toBe('TRIP_SCHEDULED');
      const again = (await post('/trips', cookies.opsDxb, ownTrip([a.id])).expect(201))
        .body as TripDto;
      expect(again.shipments.map((s) => s.shipmentId)).toEqual([a.id]);
    });
  });

  describe('locks, timelines and branches', () => {
    /** Runs `request` while `hold` keeps a row locked uncommitted; returns its status after. */
    async function whileLocked(
      hold: (tx: Prisma.TransactionClient) => Promise<unknown>,
      request: () => Promise<number>,
    ): Promise<number> {
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await hold(tx);
        const started = request();
        await waitForLockWaiter(t.prisma);
        return { pending: started };
      });
      return pending;
    }

    const createStatus = (body: object) =>
      post('/trips', cookies.opsDxb, body).then((r) => r.status);

    it('a trip waiting on a vehicle, driver, carrier or currency being deactivated is refused', async () => {
      const s = await roadShipment();
      const spareVehicle = (
        await post('/transport/vehicles', cookies.opsDxb, {
          branchId: dxb,
          plateNumber: 'ZZ DXB 202',
          vehicleType: 'Box truck',
        }).expect(201)
      ).body as VehicleDto;
      const spareDriver = (
        await post('/transport/drivers', cookies.opsDxb, {
          branchId: dxb,
          name: 'ZZ Spare Driver',
        }).expect(201)
      ).body as DriverDto;
      const spareCarrier = (
        await post('/transport/carriers', cookies.opsDxb, { name: 'ZZ Spare Carrier' }).expect(201)
      ).body as CarrierDto;

      expect(
        await whileLocked(
          (tx) =>
            tx.$executeRaw`UPDATE "vehicles" SET "is_active" = false WHERE "id" = ${spareVehicle.id}::uuid`,
          () => createStatus({ ...ownTrip([s.id]), vehicleId: spareVehicle.id }),
        ),
      ).toBe(400);
      expect(
        await whileLocked(
          (tx) =>
            tx.$executeRaw`UPDATE "drivers" SET "is_active" = false WHERE "id" = ${spareDriver.id}::uuid`,
          () => createStatus(ownTrip([s.id], spareDriver.id)),
        ),
      ).toBe(400);
      const external = {
        branchId: dxb,
        kind: 'EXTERNAL',
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        carrierId: spareCarrier.id,
        agreedCost: '2500',
        currency: 'AED',
        shipmentIds: [s.id],
      };
      expect(
        await whileLocked(
          (tx) =>
            tx.$executeRaw`UPDATE "carriers" SET "is_active" = false WHERE "id" = ${spareCarrier.id}::uuid`,
          () => createStatus(external),
        ),
      ).toBe(400);
      try {
        expect(
          await whileLocked(
            (tx) =>
              tx.$executeRaw`UPDATE "currencies" SET "is_active" = false WHERE "code" = 'AED'`,
            () => createStatus({ ...external, carrierId: carrier.id }),
          ),
        ).toBe(400);
      } finally {
        await t.prisma.currency.update({ where: { code: 'AED' }, data: { isActive: true } });
      }

      // Nothing was created: the shipment is not on a trip and did not move.
      expect(await status(s.id)).toBe('CREATED');
      expect(await t.prisma.tripShipment.count({ where: { shipmentId: s.id } })).toBe(0);
      expect(
        await t.prisma.trip.count({
          where: {
            OR: [
              { vehicleId: spareVehicle.id },
              { driverId: spareDriver.id },
              { carrierId: spareCarrier.id },
            ],
          },
        }),
      ).toBe(0);
    });

    it('a trip move or a POD dated before the trip or the shipment history is refused (400)', async () => {
      const [a, b] = [await roadShipment(), await roadShipment()];
      const trip = (await post('/trips', cookies.opsDxb, ownTrip([a.id, b.id])).expect(201))
        .body as TripDto;
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      // Before the trip was planned.
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, {
        status: 'DEPARTED',
        occurredAt: hourAgo,
      }).expect(400);
      // After the trip was planned and a was scheduled, but before b's latest event (put on
      // hold and resumed 50 ms later).
      const planned = (await t.prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).createdAt;
      const aScheduled = (
        await t.prisma.shipmentEvent.findFirstOrThrow({
          where: { shipmentId: a.id },
          orderBy: { occurredAt: 'desc' },
        })
      ).occurredAt;
      const between = new Date(Math.max(planned.getTime(), aScheduled.getTime()) + 10);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await post(`/shipments/${b.id}/hold`, cookies.opsDxb, { reason: 'Check' }).expect(200);
      await post(`/shipments/${b.id}/resume`, cookies.opsDxb, {}).expect(200);
      const refused = await post(`/trips/${trip.id}/status`, cookies.opsDxb, {
        status: 'DEPARTED',
        occurredAt: between.toISOString(),
      }).expect(400);
      expect((refused.body as { message: string }).message).toContain(b.number);
      expect(await status(a.id)).toBe('TRIP_SCHEDULED');
      expect((await get(`/trips/${trip.id}`, cookies.opsDxb).expect(200)).body).toMatchObject({
        status: 'PLANNED',
      });

      await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'DEPARTED' }).expect(200);
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'ARRIVED' }).expect(200);
      // A delivery dated before the shipment arrived.
      await recordPod(a.id, cookies.driver, {
        recipientName: 'Ahmed Ali',
        recipientCapacity: 'Consignee',
        deliveredAt: hourAgo,
        shipmentStatus: 'DELIVERED',
      })
        .attach('signature', PNG, 'signature.png')
        .expect(400);
      expect(await status(a.id)).toBe('ROAD_ARRIVED');
      expect(await t.prisma.proofOfDelivery.count({ where: { shipmentId: a.id } })).toBe(0);
    });

    it("a trip carries only its own branch's shipments, even for a user of both branches", async () => {
      const ptsCustomer = (
        await post('/customers', cookies.admin, {
          branchId: pts,
          kind: 'COMPANY',
          name: 'Transport Test PTS Trading',
          phone: uniquePhone(),
        }).expect(201)
      ).body as CustomerDto;
      const booking = (
        await post('/bookings', cookies.opsBoth, {
          customerId: ptsCustomer.id,
          originLocationId: portSudan,
          destinationLocationId: khartoum,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          services: ['MAIN_FREIGHT'],
          items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
        }).expect(201)
      ).body as BookingDto;
      const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsBoth).expect(200))
        .body as BookingDto;
      const ptsShipment = confirmed.shipmentId;
      if (!ptsShipment) throw new Error('No shipment');
      const dxbShipment = await roadShipment();

      // The user sees both shipments, but the DXB trip takes only the DXB one.
      await post('/trips', cookies.opsBoth, ownTrip([dxbShipment.id, ptsShipment])).expect(400);
      expect(await status(dxbShipment.id)).toBe('CREATED');
      expect(await status(ptsShipment)).toBe('CREATED');
      const trip = (await post('/trips', cookies.opsBoth, ownTrip([dxbShipment.id])).expect(201))
        .body as TripDto;
      await post(`/trips/${trip.id}/shipments`, cookies.opsBoth, {
        shipmentId: ptsShipment,
      }).expect(400);
      expect(await t.prisma.tripShipment.count({ where: { shipmentId: ptsShipment } })).toBe(0);
      expect(await status(ptsShipment)).toBe('CREATED');
    });

    it('a POD checks its trip under lock: link removed meanwhile, trip not departed (409)', async () => {
      const [m, n] = [await roadShipment(), await roadShipment()];
      const trip = (await post('/trips', cookies.opsDxb, ownTrip([m.id, n.id])).expect(201))
        .body as TripDto;
      const pod = (shipmentId: string) =>
        recordPod(shipmentId, cookies.driver, {
          recipientName: 'Ahmed Ali',
          recipientCapacity: 'Consignee',
        }).attach('signature', PNG, 'signature.png');
      // Before the trip leaves, the goods are not out for delivery on it.
      await pod(m.id).expect(409);
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'DEPARTED' }).expect(200);

      // The shipment is taken off the trip (committed) while the driver's POD waits on the trip
      // row: the POD passed its first checks but must see the change and be refused.
      const refused = await whileLocked(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "trips" WHERE "id" = ${trip.id}::uuid FOR UPDATE`;
          await tx.$executeRaw`
            DELETE FROM "trip_shipments"
            WHERE "trip_id" = ${trip.id}::uuid AND "shipment_id" = ${m.id}::uuid`;
        },
        () => pod(m.id).then((r) => r.status),
      );
      expect(refused).toBe(409);
      expect(await t.prisma.proofOfDelivery.count({ where: { shipmentId: m.id } })).toBe(0);
      expect(await status(m.id)).toBe('ROAD_DEPARTED');
      // The shipment still on the trip takes its POD.
      await pod(n.id).expect(201);
    });

    it('a trip move leaves shipments already past it on the leg (no permanent 409)', async () => {
      const [a, b] = [await roadShipment(), await roadShipment()];
      const trip = (await post('/trips', cookies.opsDxb, ownTrip([a.id, b.id])).expect(201))
        .body as TripDto;
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'DEPARTED' }).expect(200);
      // a arrives and is delivered by hand before the trip is marked arrived.
      await post(`/shipments/${a.id}/status`, cookies.admin, { status: 'ROAD_ARRIVED' }).expect(
        200,
      );
      await post(`/shipments/${a.id}/status`, cookies.admin, { status: 'DELIVERED' }).expect(200);
      const events = await t.prisma.shipmentEvent.count({ where: { shipmentId: a.id } });

      const arrived = (
        await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'ARRIVED' }).expect(200)
      ).body as TripDto;
      expect(arrived.status).toBe('ARRIVED');
      expect(await status(a.id)).toBe('DELIVERED');
      expect(await status(b.id)).toBe('ROAD_ARRIVED');
      expect(await t.prisma.shipmentEvent.count({ where: { shipmentId: a.id } })).toBe(events);

      // A shipment behind the target still blocks the move, as before.
      const [c, d] = [await roadShipment(), await roadShipment()];
      const second = (await post('/trips', cookies.opsDxb, ownTrip([c.id, d.id])).expect(201))
        .body as TripDto;
      await post(`/shipments/${d.id}/hold`, cookies.opsDxb, { reason: 'Papers' }).expect(200);
      await post(`/trips/${second.id}/status`, cookies.opsDxb, { status: 'DEPARTED' }).expect(409);
    });

    it('a POD recorded without a trip puts the shipment at its own destination', async () => {
      const a = await roadShipment();
      const trip = (await post('/trips', cookies.opsDxb, ownTrip([a.id])).expect(201))
        .body as TripDto;
      await post(`/trips/${trip.id}/status`, cookies.opsDxb, { status: 'DEPARTED' }).expect(200);
      // Marked arrived by hand, with no location given: the tracking page still says Port Sudan.
      await post(`/shipments/${a.id}/status`, cookies.admin, { status: 'ROAD_ARRIVED' }).expect(
        200,
      );
      expect(await location(a.id)).toBe(portSudan);
      await recordPod(a.id, cookies.opsDxb, {
        recipientName: 'Ahmed Ali',
        recipientCapacity: 'Consignee',
        shipmentStatus: 'DELIVERED',
      })
        .attach('signature', PNG, 'signature.png')
        .expect(201);
      expect(await status(a.id)).toBe('DELIVERED');
      expect(await location(a.id)).toBe(khartoum);
    });

    it('a driver record with trips keeps its user: relinking would expose the trips (409)', async () => {
      const driver3 = users.driver3?.id;
      if (!driver3) throw new Error('No user');
      // driverOwn has trips by now.
      expect(await t.prisma.trip.count({ where: { driverId: driverOwn.id } })).toBeGreaterThan(0);
      await patch(`/transport/drivers/${driverOwn.id}`, cookies.opsDxb, {
        userId: driver3,
      }).expect(409);
      await patch(`/transport/drivers/${driverOwn.id}`, cookies.opsDxb, { userId: null }).expect(
        409,
      );
      // Other fields still change, and so does the same user given again.
      await patch(`/transport/drivers/${driverOwn.id}`, cookies.opsDxb, {
        phone: '+249912000009',
        userId: users.driver?.id,
      }).expect(200);
      const owner = (await get(`/trips`, cookies.driver3).expect(200)).body as Page<TripSummaryDto>;
      expect(owner.items).toHaveLength(0);

      // A driver record without trips can be linked and relinked.
      const fresh = (
        await post('/transport/drivers', cookies.opsDxb, {
          branchId: dxb,
          name: 'ZZ Fresh Driver',
          userId: driver3,
        }).expect(201)
      ).body as DriverDto;
      await patch(`/transport/drivers/${fresh.id}`, cookies.opsDxb, { userId: null }).expect(200);
    });
  });
});

/**
 * Trip costs in the books (annex C rules 10 and 11). Posted entries are never deleted, so these
 * users are LEDGER users and every date is in a random past year (see accounting.int-spec.ts).
 */
describe('inland transport: trip costs in the books', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  let vehicle: VehicleDto;
  let driver: DriverDto;
  let carrier: CarrierDto;
  let cashSdg: AccountDto;
  let accounts: Map<string, AccountDto>;
  const year = randomInt(1901, 2000);
  const at = (monthDay: string, time = '08:00:00') => `${year}-${monthDay}T${time}+03:00`;
  const cookies = {
    admin: '',
    opsPts: '',
    financePts: '',
    salesPts: '',
    financeJed: '',
    warehousePts: '',
    driverPts: '',
  };
  const driverUser = { id: '' };
  const { get, post, put } = helpers(() => t);

  async function shipment(volumeCbm: string | null, weightKg: string | null): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm, weightKg }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  const journal = async (id: string) =>
    (await get(`/accounting/journals/${id}`, cookies.financePts).expect(200))
      .body as JournalEntryDto;

  const sum = (values: string[]) =>
    values.reduce((acc, v) => acc.plus(v), new Prisma.Decimal(0)).toFixed();

  /**
   * A trip is never moved before it was planned, nor before its shipments' latest events. These
   * entries are dated in a past year, so the fixture says the trip and its shipments' history
   * were recorded on 31 March of that year.
   */
  async function backdate(tripId: string, shipmentIds: string[]): Promise<void> {
    const planned = new Date(at('03-31'));
    await t.prisma.trip.update({ where: { id: tripId }, data: { createdAt: planned } });
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: { in: shipmentIds } },
      data: { occurredAt: planned },
    });
  }

  async function plannedTrip(body: object, shipmentIds: string[]): Promise<TripDto> {
    return (
      await post('/trips', cookies.opsPts, {
        branchId: pts,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        shipmentIds,
        ...body,
      }).expect(201)
    ).body as TripDto;
  }

  async function arrivedTrip(body: object, shipmentIds: string[]): Promise<TripDto> {
    const trip = await plannedTrip(body, shipmentIds);
    await backdate(trip.id, shipmentIds);
    await post(`/trips/${trip.id}/status`, cookies.opsPts, {
      status: 'DEPARTED',
      occurredAt: at('04-01'),
    }).expect(200);
    return (
      await post(`/trips/${trip.id}/status`, cookies.opsPts, {
        status: 'ARRIVED',
        occurredAt: at('04-02'),
      }).expect(200)
    ).body as TripDto;
  }

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
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      warehousePts: await createUser(t.prisma, ['WAREHOUSE'], ['PTS'], LEDGER_PREFIX),
      driverPts: await createUser(t.prisma, ['DRIVER'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    driverUser.id = users.driverPts.id;
    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger Transport ${year}`,
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    cashSdg = (
      await post('/accounting/accounts', cookies.admin, {
        code: `T${suffix}S`,
        nameEn: 'Test petty cash PTS (SDG)',
        nameAr: 'عهدة اختبار',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'SDG',
        branchId: pts,
      }).expect(201)
    ).body as AccountDto;
    const list = (await get('/accounting/accounts', cookies.financePts).expect(200))
      .body as AccountDto[];
    accounts = new Map(list.map((a) => [a.code, a]));
    await put('/accounting/fx-rates', cookies.financePts, {
      currency: 'SDG',
      rateDate: `${year}-01-01`,
      rate: '600',
    }).expect(200);
    vehicle = (
      await post('/transport/vehicles', cookies.opsPts, {
        branchId: pts,
        plateNumber: `LG ${suffix}`,
        vehicleType: 'Flatbed',
      }).expect(201)
    ).body as VehicleDto;
    driver = (
      await post('/transport/drivers', cookies.opsPts, {
        branchId: pts,
        name: `LG Driver ${suffix}`,
      }).expect(201)
    ).body as DriverDto;
    carrier = (
      await post('/transport/carriers', cookies.opsPts, { name: `LG Carrier ${suffix}` }).expect(
        201,
      )
    ).body as CarrierDto;
  });

  afterAll(async () => {
    await t.close();
  });

  it('rule 10: an own trip expense posts balanced, shared by CBM between the shipments', async () => {
    const small = await shipment('1', '900');
    const large = await shipment('2', '100');
    const trip = await arrivedTrip({ kind: 'OWN', vehicleId: vehicle.id, driverId: driver.id }, [
      small,
      large,
    ]);
    expect(trip.actions.canAddExpense).toBe(true);
    expect(trip.cashAccounts.map((a) => a.id)).toContain(cashSdg.id);
    const expense = {
      requestId: randomUUID(),
      expenseDate: `${year}-04-02`,
      description: 'Road fees',
      amount: '1000',
      currency: 'SDG',
      cashAccountId: cashSdg.id,
    };
    // Wrong branch, missing permission, wrong account currency, an external trip.
    await post(`/trips/${trip.id}/expenses`, cookies.financeJed, expense).expect(404);
    await post(`/trips/${trip.id}/expenses`, cookies.salesPts, expense).expect(403);
    await post(`/trips/${trip.id}/expenses`, cookies.opsPts, {
      ...expense,
      currency: 'USD',
    }).expect(400);
    await post(`/trips/${trip.id}/expenses`, cookies.opsPts, {
      ...expense,
      amount: '0',
    }).expect(400);
    // 1 SDG is 0.00 USD: refused with a 400 (not the balance trigger's 500), nothing recorded.
    const tiny = await post(`/trips/${trip.id}/expenses`, cookies.opsPts, {
      ...expense,
      requestId: randomUUID(),
      amount: '1',
    }).expect(400);
    expect(String((tiny.body as { message?: unknown }).message)).toMatch(
      /too small to post in USD/,
    );

    const withExpense = (
      await post(`/trips/${trip.id}/expenses`, cookies.opsPts, expense).expect(201)
    ).body as TripDto;
    const posted = withExpense.expenses[0];
    if (!posted) throw new Error('No expense');
    expect(posted).toMatchObject({
      amount: '1000',
      currency: 'SDG',
      fxRate: '600',
      status: 'POSTED',
    });
    expect(posted.number).toMatch(new RegExp(`^NOL-TEX-${year}-\\d{6}$`));
    // 1 CBM and 2 CBM: a third and two thirds, the cent left by rounding on the larger remainder.
    expect(posted.shares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ shipmentId: small, amount: '333.33' }),
        expect.objectContaining({ shipmentId: large, amount: '666.67' }),
      ]),
    );
    // Shares are read for the trip's own branch only: another branch gets none of its numbers.
    const shares = t.app.get(AutoJournalService);
    expect(
      (await shares.shipmentShares([posted.journalEntryId], pts)).get(posted.journalEntryId),
    ).toHaveLength(2);
    expect((await shares.shipmentShares([posted.journalEntryId], jed)).size).toBe(0);
    const entry = await journal(posted.journalEntryId);
    expect(entry).toMatchObject({
      source: 'TRIP_EXPENSE',
      status: 'POSTED',
      entryDate: `${year}-04-02`,
    });
    expect(entry.sourceNumber).toBe(posted.number);
    expect(sum(entry.lines.map((l) => l.debitUsd))).toBe(sum(entry.lines.map((l) => l.creditUsd)));
    const cost = accounts.get('5300');
    const debits = entry.lines.filter((l) => l.accountId === cost?.id);
    expect(debits.map((l) => [l.shipmentId, l.debit])).toEqual(
      expect.arrayContaining([
        [small, '333.33'],
        [large, '666.67'],
      ]),
    );
    expect(entry.lines.find((l) => l.accountId === cashSdg.id)).toMatchObject({
      credit: '1000',
      creditUsd: '1.67',
    });

    // Cancelling needs expenses:cancel (Finance, not Operations) and posts the reversing entry.
    await post(`/trips/${trip.id}/expenses/${posted.id}/cancel`, cookies.opsPts, {
      reason: 'Entered twice',
    }).expect(403);
    const cancelled = (
      await post(`/trips/${trip.id}/expenses/${posted.id}/cancel`, cookies.financePts, {
        reason: 'Entered twice',
      }).expect(200)
    ).body as TripDto;
    expect(cancelled.expenses[0]).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Entered twice',
    });
    await post(`/trips/${trip.id}/expenses/${posted.id}/cancel`, cookies.financePts, {
      reason: 'again',
    }).expect(409);
    const original = await journal(posted.journalEntryId);
    expect(original.reversedById).not.toBeNull();
  });

  it('an own trip’s expenses stay hidden from Sales, Warehouse and its Driver, who cannot add them', async () => {
    const one = await shipment('1', '100');
    const ownDriver = (
      await post('/transport/drivers', cookies.opsPts, {
        branchId: pts,
        name: `LG Own Driver ${randomUUID().slice(0, 6)}`,
        userId: driverUser.id,
      }).expect(201)
    ).body as DriverDto;
    const trip = await arrivedTrip({ kind: 'OWN', vehicleId: vehicle.id, driverId: ownDriver.id }, [
      one,
    ]);
    const expense = {
      requestId: randomUUID(),
      expenseDate: `${year}-04-02`,
      description: 'Fuel',
      amount: '600',
      currency: 'SDG',
      cashAccountId: cashSdg.id,
    };
    const paid = (await post(`/trips/${trip.id}/expenses`, cookies.opsPts, expense).expect(201))
      .body as TripDto;
    const posted = paid.expenses[0];
    if (!posted) throw new Error('No expense');
    expect(paid.showsCost).toBe(true);

    for (const cookie of [cookies.salesPts, cookies.warehousePts, cookies.driverPts]) {
      const seen = (await get(`/trips/${trip.id}`, cookie).expect(200)).body as TripDto;
      expect(seen.showsCost).toBe(false);
      expect(seen.expenses).toEqual([]);
      expect(seen.accrualJournalEntryId).toBeNull();
      expect(seen.actions).toMatchObject({ canAddExpense: false, canCancelExpense: false });
      const body = JSON.stringify(seen);
      expect(body).not.toContain(posted.number);
      expect(body).not.toContain(posted.journalNumber);
      expect(body).not.toContain(cashSdg.id);
    }
    // Warehouse holds expenses:create, but trip costs are restricted: neither add nor cancel.
    await post(`/trips/${trip.id}/expenses`, cookies.warehousePts, {
      ...expense,
      requestId: randomUUID(),
    }).expect(403);
    await post(`/trips/${trip.id}/expenses/${posted.id}/cancel`, cookies.warehousePts, {
      reason: 'x',
    }).expect(403);
    await post(`/trips/${trip.id}/expenses`, cookies.salesPts, {
      ...expense,
      requestId: randomUUID(),
    }).expect(403);
  });

  it('rule 11: completing an external trip accrues the agreed cost, split by weight', async () => {
    const a = await shipment(null, '750');
    const b = await shipment(null, '250');
    const trip = await arrivedTrip(
      {
        kind: 'EXTERNAL',
        carrierId: carrier.id,
        agreedCost: '600000',
        currency: 'SDG',
        externalVehicle: 'KH 4455',
        externalDriver: 'Osman',
      },
      [a, b],
    );
    expect(trip).toMatchObject({ vehicleLabel: 'KH 4455', carrierName: carrier.name });
    expect(trip.actions.canAddExpense).toBe(false);
    await post(`/trips/${trip.id}/expenses`, cookies.opsPts, {
      requestId: randomUUID(),
      expenseDate: `${year}-04-02`,
      description: 'x',
      amount: '1',
      currency: 'SDG',
      cashAccountId: cashSdg.id,
    }).expect(409);

    const done = (
      await post(`/trips/${trip.id}/status`, cookies.opsPts, {
        status: 'COMPLETED',
        occurredAt: at('04-03'),
      }).expect(200)
    ).body as TripDto;
    expect(done.status).toBe('COMPLETED');
    expect(done.accrualShares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ shipmentId: a, amount: '450000' }),
        expect.objectContaining({ shipmentId: b, amount: '150000' }),
      ]),
    );
    if (!done.accrualJournalEntryId) throw new Error('No accrual');
    const entry = await journal(done.accrualJournalEntryId);
    expect(entry).toMatchObject({ source: 'TRIP_ACCRUAL', entryDate: `${year}-04-03` });
    expect(entry.sourceNumber).toBe(trip.number);
    const accrued = accounts.get('2300');
    expect(entry.lines.find((l) => l.accountId === accrued?.id)).toMatchObject({
      credit: '600000',
      creditUsd: '1000',
      fxRate: '600',
    });
    expect(sum(entry.lines.map((l) => l.debitUsd))).toBe('1000');
    expect(sum(entry.lines.map((l) => l.creditUsd))).toBe('1000');
  });

  it('two concurrent completions: one succeeds, the other waits and is refused', async () => {
    const a = await shipment('1', null);
    const trip = await arrivedTrip(
      { kind: 'EXTERNAL', carrierId: carrier.id, agreedCost: '1200', currency: 'SDG' },
      [a],
    );
    const complete = () =>
      post(`/trips/${trip.id}/status`, cookies.opsPts, {
        status: 'COMPLETED',
        occurredAt: at('04-03'),
      }).then((r) => r.status);
    // Hold the trip lock until both requests are queued on it, then let them run.
    const { pending } = await t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "trips" WHERE "id" = ${trip.id}::uuid FOR UPDATE`;
      const requests = Promise.all([complete(), complete()]);
      await waitForLockWaiters(t.prisma, 2);
      return { pending: requests };
    });
    const statuses = await pending;
    expect([...statuses].sort()).toEqual([200, 409]);
    const accruals = await t.prisma.journalEntry.count({
      where: { source: 'TRIP_ACCRUAL', sourceId: trip.id },
    });
    expect(accruals).toBe(1);
  });

  it('an expense request sent twice posts once; its id cannot be reused for another expense', async () => {
    const a = await shipment('1', null);
    const trip = await arrivedTrip({ kind: 'OWN', vehicleId: vehicle.id, driverId: driver.id }, [
      a,
    ]);
    const other = await arrivedTrip({ kind: 'OWN', vehicleId: vehicle.id, driverId: driver.id }, [
      await shipment('1', null),
    ]);
    const expense = {
      requestId: randomUUID(),
      expenseDate: `${year}-04-02`,
      description: 'Fuel',
      amount: '250',
      currency: 'SDG',
      cashAccountId: cashSdg.id,
    };
    const send = () =>
      post(`/trips/${trip.id}/expenses`, cookies.opsPts, expense).then((r) => r.status);
    // Two submits of the same form queue on the trip lock; the second finds the first expense.
    const { pending } = await t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "trips" WHERE "id" = ${trip.id}::uuid FOR UPDATE`;
      const requests = Promise.all([send(), send()]);
      await waitForLockWaiters(t.prisma, 2);
      return { pending: requests };
    });
    expect(await pending).toEqual([201, 201]);
    // A retry after the first one committed changes nothing either.
    expect(await send()).toBe(201);
    const expenses = await t.prisma.tripExpense.findMany({ where: { tripId: trip.id } });
    expect(expenses.map((e) => e.id)).toEqual([expense.requestId]);
    expect(
      await t.prisma.journalEntry.count({
        where: { source: 'TRIP_EXPENSE', sourceId: expense.requestId },
      }),
    ).toBe(1);
    // The same id with anything changed is refused, never answered with the first expense.
    for (const change of [{ amount: '260' }, { description: 'Diesel' }, { fxRate: '610' }]) {
      await post(`/trips/${trip.id}/expenses`, cookies.opsPts, { ...expense, ...change }).expect(
        409,
      );
    }
    await post(`/trips/${other.id}/expenses`, cookies.opsPts, expense).expect(409);
    await post(`/trips/${trip.id}/expenses`, cookies.opsPts, {
      ...expense,
      requestId: 'not-a-uuid',
    }).expect(400);
    expect(await t.prisma.tripExpense.count({ where: { tripId: other.id } })).toBe(0);
  });

  it('an expense waiting on its currency being deactivated is refused (400)', async () => {
    const a = await shipment('1', null);
    const trip = await arrivedTrip({ kind: 'OWN', vehicleId: vehicle.id, driverId: driver.id }, [
      a,
    ]);
    try {
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "currencies" SET "is_active" = false WHERE "code" = 'SDG'`;
        const request = post(`/trips/${trip.id}/expenses`, cookies.opsPts, {
          requestId: randomUUID(),
          expenseDate: `${year}-04-02`,
          description: 'Tolls',
          amount: '100',
          currency: 'SDG',
          cashAccountId: cashSdg.id,
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(400);
      expect(await t.prisma.tripExpense.count({ where: { tripId: trip.id } })).toBe(0);
    } finally {
      await t.prisma.currency.update({ where: { code: 'SDG' }, data: { isActive: true } });
    }
  });

  it('posted expenses fix the shipments of a trip until they are cancelled (409)', async () => {
    const a = await shipment('1', null);
    const b = await shipment('1', null);
    const c = await shipment('1', null);
    const trip = await plannedTrip({ kind: 'OWN', vehicleId: vehicle.id, driverId: driver.id }, [
      a,
      b,
    ]);
    const withExpense = (
      await post(`/trips/${trip.id}/expenses`, cookies.opsPts, {
        requestId: randomUUID(),
        expenseDate: `${year}-04-01`,
        description: 'Loading crew',
        amount: '500',
        currency: 'SDG',
        cashAccountId: cashSdg.id,
      }).expect(201)
    ).body as TripDto;
    const posted = withExpense.expenses[0];
    if (!posted) throw new Error('No expense');
    // The expense was split over a and b: neither list may change while it stands.
    await post(`/trips/${trip.id}/shipments`, cookies.opsPts, { shipmentId: c }).expect(409);
    await t
      .http()
      .delete(`/api/v1/trips/${trip.id}/shipments/${b}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.opsPts)
      .expect(409);
    const unchanged = (await get(`/trips/${trip.id}`, cookies.opsPts).expect(200)).body as TripDto;
    expect(unchanged.shipments.map((x) => x.shipmentId).sort()).toEqual([a, b].sort());
    expect(await t.prisma.tripShipment.count({ where: { shipmentId: c } })).toBe(0);

    await post(`/trips/${trip.id}/expenses/${posted.id}/cancel`, cookies.financePts, {
      reason: 'Wrong trip',
    }).expect(200);
    await post(`/trips/${trip.id}/shipments`, cookies.opsPts, { shipmentId: c }).expect(201);
    await t
      .http()
      .delete(`/api/v1/trips/${trip.id}/shipments/${b}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.opsPts)
      .expect(200);
  });

  it('a trip completes and accrues in its currency even after the currency was deactivated', async () => {
    const a = await shipment('2', null);
    const trip = await arrivedTrip(
      { kind: 'EXTERNAL', carrierId: carrier.id, agreedCost: '3000', currency: 'SDG' },
      [a],
    );
    await t.prisma.currency.update({ where: { code: 'SDG' }, data: { isActive: false } });
    try {
      const done = (
        await post(`/trips/${trip.id}/status`, cookies.opsPts, {
          status: 'COMPLETED',
          occurredAt: at('04-03'),
        }).expect(200)
      ).body as TripDto;
      expect(done.status).toBe('COMPLETED');
      if (!done.accrualJournalEntryId) throw new Error('No accrual');
      const entry = await journal(done.accrualJournalEntryId);
      expect(entry.source).toBe('TRIP_ACCRUAL');
      expect(entry.lines.find((l) => l.accountId === accounts.get('2300')?.id)).toMatchObject({
        credit: '3000',
        fxRate: '600',
      });
      // New trips cannot use it meanwhile.
      const b = await shipment('1', null);
      await post('/trips', cookies.opsPts, {
        branchId: pts,
        kind: 'EXTERNAL',
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        carrierId: carrier.id,
        agreedCost: '10',
        currency: 'SDG',
        shipmentIds: [b],
      }).expect(400);
    } finally {
      await t.prisma.currency.update({ where: { code: 'SDG' }, data: { isActive: true } });
    }
  });
});
