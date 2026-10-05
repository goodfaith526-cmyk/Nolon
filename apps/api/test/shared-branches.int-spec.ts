import type {
  BookingDto,
  CustomerDto,
  DriverDto,
  Page,
  ShipmentDto,
  ShipmentSummaryDto,
  ShipmentTripDto,
  ShipmentWarehouseDto,
  TripDto,
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
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

/**
 * Annex A: a shipment between branches (DXB → KRT) is visible to the users of both. The owning
 * branch shares it with other branches; their users see it and record its operations (goods
 * receipt, trips), and billing stays with the owner.
 */
describe('shipments shared with other branches', () => {
  let t: TestApp;
  let dxb: string;
  let pts: string;
  let krt: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  let shipment: ShipmentDto;
  let krtWarehouse: WarehouseDto;
  let ptsVehicle: VehicleDto;
  let ptsDriver: DriverDto;
  const cookies = {
    admin: '',
    opsDxb: '',
    salesDxb: '',
    opsPts: '',
    opsKrt: '',
    warehouseKrt: '',
    financeKrt: '',
    financeDxb: '',
    opsJed: '',
    opsDxbPts: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  /** A confirmed Port Sudan → Khartoum road booking of the DXB customer; its shipment. */
  async function roadShipment(): Promise<ShipmentDto> {
    const booking = (
      await post('/bookings', cookies.opsDxb, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT', 'WAREHOUSE', 'INLAND_TRANSPORT'],
        items: [{ cargoType: 'GENERAL', quantity: 4, weightKg: '400' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsDxb).expect(200))
      .body as BookingDto;
    return (await get(`/shipments/${confirmed.shipmentId}`, cookies.opsDxb).expect(200))
      .body as ShipmentDto;
  }

  const ptsTrip = (shipmentIds: string[]) => ({
    branchId: pts,
    kind: 'OWN',
    originLocationId: portSudan,
    destinationLocationId: khartoum,
    vehicleId: ptsVehicle.id,
    driverId: ptsDriver.id,
    shipmentIds,
  });

  const listed = async (cookie: string) =>
    (
      (await get('/shipments?pageSize=100', cookie).expect(200)).body as Page<ShipmentSummaryDto>
    ).items.map((s) => s.id);

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    pts = await branchId(t.prisma, 'PTS');
    krt = await branchId(t.prisma, 'KRT');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR']),
      opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
      salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS']),
      opsKrt: await createUser(t.prisma, ['OPERATIONS'], ['KRT']),
      warehouseKrt: await createUser(t.prisma, ['WAREHOUSE'], ['KRT']),
      financeKrt: await createUser(t.prisma, ['FINANCE'], ['KRT']),
      financeDxb: await createUser(t.prisma, ['FINANCE'], ['DXB']),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED']),
      opsDxbPts: await createUser(t.prisma, ['OPERATIONS'], ['DXB', 'PTS']),
    };
    for (const key of Object.keys(cookies) as (keyof typeof cookies)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    customer = (
      await post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Shared Branches Trading',
        preferredCurrency: 'USD',
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
    krtWarehouse = (
      await post('/warehouses', cookies.admin, {
        branchId: krt,
        code: 'ZZ-KRT-SH',
        nameEn: 'Khartoum store',
        nameAr: 'مستودع الخرطوم',
      }).expect(201)
    ).body as WarehouseDto;
    ptsVehicle = (
      await post('/transport/vehicles', cookies.opsPts, {
        branchId: pts,
        plateNumber: 'ZZ PTS SH 1',
        vehicleType: 'Flatbed trailer',
      }).expect(201)
    ).body as VehicleDto;
    ptsDriver = (
      await post('/transport/drivers', cookies.opsPts, {
        branchId: pts,
        name: 'ZZ PTS Driver',
      }).expect(201)
    ).body as DriverDto;
    shipment = await roadShipment();
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('a shipment is only its own branch until it is shared', async () => {
    expect(shipment.sharedBranchIds).toEqual([]);
    expect(shipment.actions.canShareBranches).toBe(true);
    expect(shipment.shareableBranches.map((b) => b.code)).toEqual(
      expect.arrayContaining(['PTS', 'KRT', 'JED']),
    );
    expect(shipment.shareableBranches.map((b) => b.code)).not.toContain('DXB');
    await get(`/shipments/${shipment.id}`, cookies.warehouseKrt).expect(404);
    await get(`/shipments/${shipment.id}/warehouse`, cookies.warehouseKrt).expect(404);
    expect(await listed(cookies.opsKrt)).not.toContain(shipment.id);
    await post(`/shipments/${shipment.id}/warehouse/receipts`, cookies.warehouseKrt, {
      warehouseId: krtWarehouse.id,
      packages: 4,
      condition: 'GOOD',
    }).expect(404);
    // A user of DXB and PTS sees the shipment, but a PTS trip cannot carry a DXB shipment that is
    // not shared with PTS.
    await post('/trips', cookies.opsDxbPts, ptsTrip([shipment.id])).expect(400);
  });

  it('only the owning branch chooses the branches sharing the shipment', async () => {
    // Not visible in KRT yet: nothing to change.
    await patch(`/shipments/${shipment.id}`, cookies.opsKrt, { sharedBranchIds: [krt] }).expect(
      404,
    );
    await patch(`/shipments/${shipment.id}`, cookies.opsDxb, { sharedBranchIds: [dxb] }).expect(
      400,
    );
    await patch(`/shipments/${shipment.id}`, cookies.opsDxb, {
      sharedBranchIds: ['00000000-0000-4000-8000-000000000000'],
    }).expect(400);
    await patch(`/shipments/${shipment.id}`, cookies.salesDxb, { sharedBranchIds: [krt] }).expect(
      403,
    );
    const shared = (
      await patch(`/shipments/${shipment.id}`, cookies.opsDxb, {
        sharedBranchIds: [krt, pts, krt],
      }).expect(200)
    ).body as ShipmentDto;
    expect([...shared.sharedBranchIds].sort()).toEqual([krt, pts].sort());
    expect(shared.sharedBranches.map((b) => b.code).sort()).toEqual(['KRT', 'PTS']);

    // KRT now sees it and may edit its operational fields, but not whom it is shared with.
    const seen = (await get(`/shipments/${shipment.id}`, cookies.opsKrt).expect(200))
      .body as ShipmentDto;
    expect(seen.actions.canShareBranches).toBe(false);
    expect(seen.shareableBranches).toEqual([]);
    expect(await listed(cookies.opsKrt)).toContain(shipment.id);
    await patch(`/shipments/${shipment.id}`, cookies.opsKrt, { blNumber: 'CN-KRT-1' }).expect(200);
    await patch(`/shipments/${shipment.id}`, cookies.opsKrt, { sharedBranchIds: [] }).expect(403);
    // Another branch still sees nothing.
    await get(`/shipments/${shipment.id}`, cookies.opsJed).expect(404);
    expect(await listed(cookies.opsJed)).not.toContain(shipment.id);
  });

  it('the sharing branches run the trip and the goods receipt; billing stays with the owner', async () => {
    // Port Sudan carries the shipment on its own truck.
    const trip = (await post('/trips', cookies.opsPts, ptsTrip([shipment.id])).expect(201))
      .body as TripDto;
    expect(trip.shipments.map((s) => s.shipmentId)).toEqual([shipment.id]);

    // The owner sees the PTS leg on the shipment, but cannot open the PTS trip itself.
    const legs = (await get(`/shipments/${shipment.id}/trips`, cookies.opsDxb).expect(200))
      .body as ShipmentTripDto[];
    expect(legs.map((l) => [l.id, l.canOpen])).toEqual([[trip.id, false]]);
    await get(`/trips/${trip.id}`, cookies.opsDxb).expect(404);
    const ptsLegs = (await get(`/shipments/${shipment.id}/trips`, cookies.opsPts).expect(200))
      .body as ShipmentTripDto[];
    expect(ptsLegs.map((l) => l.canOpen)).toEqual([true]);

    // Khartoum receives the goods into its own warehouse.
    await post(`/shipments/${shipment.id}/warehouse/receipts`, cookies.warehouseKrt, {
      warehouseId: krtWarehouse.id,
      packages: 4,
      condition: 'GOOD',
    }).expect(201);
    for (const cookie of [cookies.warehouseKrt, cookies.opsDxb]) {
      const view = (await get(`/shipments/${shipment.id}/warehouse`, cookie).expect(200))
        .body as ShipmentWarehouseDto;
      expect(view.movements).toHaveLength(1);
      expect(view.balances.map((b) => [b.warehouseCode, b.onHandPackages])).toEqual([
        ['ZZ-KRT-SH', 4],
      ]);
    }

    // The shipment counts in Khartoum's operational reports (labelled with its own branch).
    const onHand = await get(`/reports/warehouse-on-hand?branchId=${krt}`, cookies.admin).expect(
      200,
    );
    expect(JSON.stringify(onHand.body)).toContain(shipment.number);
    // Up to tomorrow (UTC): the shipment's day in its branch's time zone may already be tomorrow.
    const upTo = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const report = await get(
      `/reports/shipments?from=2020-01-01&to=${upTo}&branchId=${krt}&customerId=${customer.id}`,
      cookies.admin,
    ).expect(200);
    expect(JSON.stringify(report.body)).toContain(shipment.number);
    const jedReport = await get(
      `/reports/shipments?from=2020-01-01&to=${upTo}&branchId=${await branchId(t.prisma, 'JED')}&customerId=${customer.id}`,
      cookies.admin,
    ).expect(200);
    expect(JSON.stringify(jedReport.body)).not.toContain(shipment.number);

    // Invoicing stays with the owning branch.
    await post('/customer-invoices', cookies.financeKrt, { shipmentId: shipment.id }).expect(404);
    const draft = (
      await post('/customer-invoices', cookies.financeDxb, { shipmentId: shipment.id }).expect(201)
    ).body as { id: string };
    // A draft, never posted: removed so the test data can be cleaned up.
    await t.prisma.customerInvoiceLine.deleteMany({ where: { invoiceId: draft.id } });
    await t.prisma.customerInvoice.delete({ where: { id: draft.id } });
  });

  it('unsharing ends the access of a branch; what it recorded stays', async () => {
    const unshared = (
      await patch(`/shipments/${shipment.id}`, cookies.opsDxb, { sharedBranchIds: [pts] }).expect(
        200,
      )
    ).body as ShipmentDto;
    expect(unshared.sharedBranchIds).toEqual([pts]);
    await get(`/shipments/${shipment.id}`, cookies.warehouseKrt).expect(404);
    await get(`/shipments/${shipment.id}/warehouse`, cookies.warehouseKrt).expect(404);
    const view = (await get(`/shipments/${shipment.id}/warehouse`, cookies.opsDxb).expect(200))
      .body as ShipmentWarehouseDto;
    expect(view.movements).toHaveLength(1);
    await get(`/shipments/${shipment.id}`, cookies.opsPts).expect(200);
  });
});
