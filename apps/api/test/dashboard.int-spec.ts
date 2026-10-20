import type {
  AlertsDto,
  BookingDto,
  CustomerDto,
  DashboardDto,
  DriverDto,
  EntryDraftSummaryDto,
  ShipmentDto,
  VehicleDto,
  WarehouseDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { AGENT_PREFIX, draftKey, registerClient, tokenFor } from './agent-drafts-helpers.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

describe('dashboard', () => {
  let t: TestApp;
  let krt: string;
  let salesKrt: string;
  let salesAtb: string;
  let warehouse: string;
  let driver: string;

  const dashboard = async (cookie: string) =>
    (await t.http().get('/api/v1/dashboard').set('Cookie', cookie).expect(200))
      .body as DashboardDto;

  beforeAll(async () => {
    t = await createTestApp();
    krt = await branchId(t.prisma, 'KRT');
    salesKrt = await signIn(t, (await createUser(t.prisma, ['SALES'], ['KRT'])).email);
    salesAtb = await signIn(t, (await createUser(t.prisma, ['SALES'], ['ATB'])).email);
    warehouse = await signIn(t, (await createUser(t.prisma, ['WAREHOUSE'], ['KRT'])).email);
    driver = await signIn(t, (await createUser(t.prisma, ['DRIVER'], ['KRT'])).email);
    await t
      .http()
      .post('/api/v1/customers')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', salesKrt)
      .send({ branchId: krt, kind: 'INDIVIDUAL', name: 'Dashboard Test', phone: uniquePhone() })
      .expect(201);
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('counts only the records of the user’s own branches', async () => {
    const atb = await branchId(t.prisma, 'ATB');
    const krtView = await dashboard(salesKrt);
    const atbView = await dashboard(salesAtb);
    expect(krtView.customers?.total).toBe(
      await t.prisma.customer.count({ where: { branchId: krt } }),
    );
    expect(atbView.customers?.total).toBe(
      await t.prisma.customer.count({ where: { branchId: atb } }),
    );
    expect(krtView.customers?.total).toBeGreaterThan(0);
    expect(krtView.quotations?.recent.every((q) => q.branchId === krt)).toBe(true);
    expect(krtView.bookings?.recent.every((b) => b.branchId === krt)).toBe(true);
  });

  it('leaves out the modules the user may not view', async () => {
    const view = await dashboard(warehouse);
    expect(view.customers).not.toBeNull();
    expect(view.bookings).not.toBeNull();
    expect(view.rates).toBeNull();
    expect(view.quotations).toBeNull();
    expect(view.warehouse).not.toBeNull();
    expect(view.customs).toBeNull();
    expect(view.trips).toMatchObject({ ownOnly: false });
    // A Driver sees only their own trips, and the alerts of those (no sales, warehouse or customs).
    expect(await dashboard(driver)).toMatchObject({
      customers: null,
      rates: null,
      quotations: null,
      bookings: null,
      warehouse: null,
      customs: null,
      trips: { ownOnly: true },
      drafts: { awaitingReview: 0 },
    });
    // Customs staff see customs files, and no trips.
    const customs = await dashboard(
      await signIn(t, (await createUser(t.prisma, ['CUSTOMS'], ['KRT'])).email),
    );
    expect(customs.trips).toBeNull();
    expect(customs.customs).not.toBeNull();
  });

  describe('each role’s own figures', () => {
    const cookies = {
      opsKrt: '',
      opsAtb: '',
      warehouseKrt: '',
      warehouseAtb: '',
      customsKrt: '',
      customsAtb: '',
      driverKrt: '',
      otherDriverKrt: '',
      salesAtb: '',
    };
    let customer: CustomerDto;
    let driverUserId: string;
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    const post = (path: string, cookie: string, body: object = {}) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
    const put = (path: string, cookie: string, body: object) =>
      t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
    const all = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(cookies).map(async ([key, cookie]) => [key, await dashboard(cookie)]),
        ),
      ) as Record<keyof typeof cookies, DashboardDto>;

    /** A confirmed booking of the KRT customer; its shipment. */
    async function shipment(body: object): Promise<ShipmentDto> {
      const booking = (
        await post('/bookings', cookies.opsKrt, {
          customerId: customer.id,
          cargoType: 'GENERAL',
          items: [{ cargoType: 'GENERAL', quantity: 4, weightKg: '400' }],
          ...body,
        }).expect(201)
      ).body as BookingDto;
      const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsKrt).expect(200))
        .body as BookingDto;
      return (
        await t
          .http()
          .get(`/api/v1/shipments/${confirmed.shipmentId}`)
          .set('Cookie', cookies.opsKrt)
          .expect(200)
      ).body as ShipmentDto;
    }

    beforeAll(async () => {
      const users = {
        opsKrt: await createUser(t.prisma, ['OPERATIONS'], ['KRT']),
        opsAtb: await createUser(t.prisma, ['OPERATIONS'], ['ATB']),
        warehouseKrt: await createUser(t.prisma, ['WAREHOUSE'], ['KRT']),
        warehouseAtb: await createUser(t.prisma, ['WAREHOUSE'], ['ATB']),
        customsKrt: await createUser(t.prisma, ['CUSTOMS'], ['KRT']),
        customsAtb: await createUser(t.prisma, ['CUSTOMS'], ['ATB']),
        driverKrt: await createUser(t.prisma, ['DRIVER'], ['KRT']),
        otherDriverKrt: await createUser(t.prisma, ['DRIVER'], ['KRT']),
        salesAtb: await createUser(t.prisma, ['SALES'], ['ATB']),
      };
      driverUserId = users.driverKrt.id;
      for (const key of Object.keys(users) as (keyof typeof users)[]) {
        cookies[key] = await signIn(t, users[key].email);
      }
      customer = (
        await post('/customers', salesKrt, {
          branchId: krt,
          kind: 'COMPANY',
          name: 'Dashboard Roles Trading',
          phone: uniquePhone(),
        }).expect(201)
      ).body as CustomerDto;
    });

    it('counts warehouse, customs and trips in the user’s branches, a driver’s own trips', async () => {
      const before = await all();
      const portSudan = await loc('SDPZU');
      const khartoum = await loc('SDKRT');

      // Customs: a file of a KRT shipment.
      const sea = await shipment({
        originLocationId: await loc('AEJEA'),
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        services: ['MAIN_FREIGHT', 'CUSTOMS'],
      });
      await put(`/shipments/${sea.id}/customs`, cookies.customsKrt, {
        status: 'SUBMITTED',
        submittedOn: '2026-10-01',
      }).expect(200);

      // Warehouse: the same shipment received today in a KRT warehouse.
      const store = (
        await post('/warehouses', cookies.warehouseKrt, {
          branchId: krt,
          code: 'ZZ-KRT-DASH',
          nameEn: 'Dashboard store',
          nameAr: 'مستودع اللوحة',
        }).expect(201)
      ).body as WarehouseDto;
      await post(`/shipments/${sea.id}/warehouse/receipts`, cookies.warehouseKrt, {
        warehouseId: store.id,
        condition: 'GOOD',
        packages: 4,
      }).expect(201);

      // Trips: one planned KRT trip, driven by driverKrt.
      const road = await shipment({
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        services: ['MAIN_FREIGHT'],
      });
      const vehicle = (
        await post('/transport/vehicles', cookies.opsKrt, {
          branchId: krt,
          plateNumber: 'ZZ KRT DASH',
          vehicleType: 'Truck',
        }).expect(201)
      ).body as VehicleDto;
      const driverRecord = (
        await post('/transport/drivers', cookies.opsKrt, {
          branchId: krt,
          name: 'ZZ Dashboard Driver',
          userId: driverUserId,
        }).expect(201)
      ).body as DriverDto;
      await post('/trips', cookies.opsKrt, {
        branchId: krt,
        kind: 'OWN',
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        vehicleId: vehicle.id,
        driverId: driverRecord.id,
        shipmentIds: [road.id],
      }).expect(201);

      const after = await all();
      expect(after.warehouseKrt.warehouse?.shipments).toBe(
        (before.warehouseKrt.warehouse?.shipments ?? 0) + 1,
      );
      expect(after.warehouseKrt.warehouse?.receivedToday).toBe(
        (before.warehouseKrt.warehouse?.receivedToday ?? 0) + 1,
      );
      expect(after.warehouseAtb.warehouse).toEqual(before.warehouseAtb.warehouse);

      const submitted = (d: DashboardDto) =>
        d.customs?.byStatus.find((s) => s.status === 'SUBMITTED')?.count ?? 0;
      expect(after.customsKrt.customs?.open).toBe((before.customsKrt.customs?.open ?? 0) + 1);
      expect(submitted(after.customsKrt)).toBe(submitted(before.customsKrt) + 1);
      expect(after.customsAtb.customs).toEqual(before.customsAtb.customs);

      expect(after.opsKrt.trips?.planned).toBe((before.opsKrt.trips?.planned ?? 0) + 1);
      expect(after.opsAtb.trips).toEqual(before.opsAtb.trips);
      expect(after.driverKrt.trips).toEqual({
        planned: (before.driverKrt.trips?.planned ?? 0) + 1,
        onTheRoad: before.driverKrt.trips?.onTheRoad ?? 0,
        ownOnly: true,
      });
      // Another driver of the branch: not their trip.
      expect(after.otherDriverKrt.trips).toEqual(before.otherDriverKrt.trips);
    });

    it('counts the drafts the user may decide, in their branches', async () => {
      const assistant = await createUser(t.prisma, ['SALES'], ['KRT'], AGENT_PREFIX);
      const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX);
      const client = await registerClient(t, await signIn(t, admin.email), 'Dashboard platform');
      const token = await tokenFor(t, await signIn(t, assistant.email), client);
      const before = await all();
      const salesBefore = await dashboard(salesKrt);
      const created = (
        await t
          .http()
          .post('/api/v1/party-drafts')
          .set('Authorization', `Bearer ${token}`)
          .send({
            idempotencyKey: draftKey(),
            customerId: customer.id,
            name: 'Dashboard Consignee',
            phone: '+249912000222',
            countryCode: 'SD',
          })
          .expect(201)
      ).body as EntryDraftSummaryDto;
      expect(created.id).toBeTruthy();

      // Sales of KRT may decide it (customers:update); Sales of ATB do not see it; Warehouse of
      // KRT see it but may not decide it.
      expect((await dashboard(salesKrt)).drafts?.awaitingReview).toBe(
        (salesBefore.drafts?.awaitingReview ?? 0) + 1,
      );
      const after = await all();
      expect(after.salesAtb.drafts).toEqual(before.salesAtb.drafts);
      expect(after.warehouseKrt.drafts).toEqual(before.warehouseKrt.drafts);
    });

    it('counts the alerts GET /alerts shows the user', async () => {
      for (const cookie of [cookies.opsKrt, cookies.driverKrt, cookies.customsAtb]) {
        const alerts = (await t.http().get('/api/v1/alerts').set('Cookie', cookie).expect(200))
          .body as AlertsDto;
        expect((await dashboard(cookie)).alerts).toEqual({
          total: alerts.total,
          byKind: alerts.groups.map((g) => ({ kind: g.kind, count: g.count })),
        });
      }
    });
  });

  it('needs a session', async () => {
    await t.http().get('/api/v1/dashboard').expect(401);
  });
});
