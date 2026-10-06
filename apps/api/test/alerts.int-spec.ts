import { randomInt, randomUUID } from 'node:crypto';
import type {
  AlertKind,
  AlertSettingDto,
  AlertsDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  DriverDto,
  TripDto,
  VehicleDto,
  WarehouseDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/common/dates.js';
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
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

const DEFAULT_WAITS: Record<AlertKind, number> = {
  SHIPMENT_PAST_ETA: 0,
  INVOICE_OVERDUE: 0,
  CUSTOMS_STALLED: 3,
  STORAGE_EXCEEDED: 30,
  TRIP_LATE: 0,
};

/**
 * Scenario 18: the five internal alerts. Each test record is made to wait since a day older than
 * any other suite's records (year 600-900), so it heads its alert's list.
 */
describe('internal alerts', () => {
  let t: TestApp;
  let dxb: string;
  let pts: string;
  let customer: CustomerDto;
  let warehouse: WarehouseDto;
  let vehicle: VehicleDto;
  let driver: DriverDto;
  const year = String(randomInt(600, 900)).padStart(4, '0');
  const old = `${year}-01-10`;
  const ids = {
    late: '',
    recent: '',
    customs: '',
    stored: '',
    trip: '',
    recentTrip: '',
    invoice: '',
  };
  const cookies = {
    admin: '',
    management: '',
    opsDxb: '',
    opsJed: '',
    salesDxb: '',
    warehouseDxb: '',
    customsDxb: '',
    driver: '',
    managerDxb: '',
    financePts: '',
    salesPts: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  const alerts = async (cookie: string) =>
    (await get('/alerts', cookie).expect(200)).body as AlertsDto;
  const find = (list: AlertsDto, kind: AlertKind, refId: string) =>
    list.groups.find((g) => g.kind === kind)?.items.find((i) => i.refId === refId);
  const setWait = (kind: AlertKind, days: number) =>
    put(`/alerts/settings/${kind}`, cookies.admin, { days }).expect(200);

  async function shipment(
    cookie: string,
    branch: { customerId: string; from: string; to: string },
    services: string[],
  ): Promise<string> {
    const booking = (
      await post('/bookings', cookie, {
        customerId: branch.customerId,
        originLocationId: branch.from,
        destinationLocationId: branch.to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services,
        items: [{ cargoType: 'GENERAL', quantity: 5, weightKg: '500' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookie).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    const portSudan = await loc('SDPZU');
    const khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR']),
      management: await createUser(t.prisma, ['MANAGEMENT']),
      opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED']),
      salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
      warehouseDxb: await createUser(t.prisma, ['WAREHOUSE'], ['DXB']),
      customsDxb: await createUser(t.prisma, ['CUSTOMS'], ['DXB']),
      driver: await createUser(t.prisma, ['DRIVER'], ['DXB']),
      managerDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
      // Approved invoices post entries that are never deleted: their users stay (LEDGER_PREFIX).
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    customer = (
      await post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: `Alerts Test ${suffix}`,
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
    const dxbRoute = { customerId: customer.id, from: portSudan, to: khartoum };

    // Alert 1: one shipment years past its ETA, one two days past it.
    ids.late = await shipment(cookies.opsDxb, dxbRoute, ['MAIN_FREIGHT']);
    ids.recent = await shipment(cookies.opsDxb, dxbRoute, ['MAIN_FREIGHT']);
    const branch = await t.prisma.branch.findUniqueOrThrow({ where: { id: dxb } });
    const twoDaysAgo = new Date(Date.parse(todayIn(branch.timezone)) - 2 * 86_400_000);
    await t.prisma.shipment.update({ where: { id: ids.late }, data: { eta: new Date(old) } });
    await t.prisma.shipment.update({ where: { id: ids.recent }, data: { eta: twoDaysAgo } });

    // Alert 3: a customs file submitted and left since then.
    ids.customs = await shipment(cookies.opsDxb, dxbRoute, ['MAIN_FREIGHT', 'CUSTOMS']);
    await put(`/shipments/${ids.customs}/customs`, cookies.customsDxb, {
      status: 'SUBMITTED',
    }).expect(200);
    await t.prisma.$executeRaw`
      UPDATE "customs_clearances" SET "updated_at" = ${new Date(`${old}T08:00:00Z`)}
      WHERE "shipment_id" = ${ids.customs}::uuid`;

    // Alert 4: goods received long ago and still in the warehouse.
    warehouse = (
      await post('/warehouses', cookies.warehouseDxb, {
        branchId: dxb,
        code: `ZZ-AL-${suffix}`,
        nameEn: 'Alerts store',
        nameAr: 'مستودع التنبيهات',
      }).expect(201)
    ).body as WarehouseDto;
    ids.stored = await shipment(cookies.opsDxb, dxbRoute, ['MAIN_FREIGHT', 'WAREHOUSE']);
    await post(`/shipments/${ids.stored}/warehouse/receipts`, cookies.warehouseDxb, {
      warehouseId: warehouse.id,
      condition: 'GOOD',
      packages: 5,
    }).expect(201);
    await t.prisma.warehouseMovement.updateMany({
      where: { shipmentId: ids.stored },
      data: { occurredAt: new Date(`${old}T08:00:00Z`) },
    });

    // Alert 5: a trip years past its planned arrival, and one two hours past it.
    vehicle = (
      await post('/transport/vehicles', cookies.opsDxb, {
        branchId: dxb,
        plateNumber: `ZZ AL ${suffix}`,
        vehicleType: 'Flatbed trailer',
      }).expect(201)
    ).body as VehicleDto;
    driver = (
      await post('/transport/drivers', cookies.opsDxb, {
        branchId: dxb,
        name: `ZZ Alerts Driver ${suffix}`,
        userId: users.driver.id,
      }).expect(201)
    ).body as DriverDto;
    const trip = async () =>
      (
        (
          await post('/trips', cookies.opsDxb, {
            branchId: dxb,
            kind: 'OWN',
            originLocationId: portSudan,
            destinationLocationId: khartoum,
            vehicleId: vehicle.id,
            driverId: driver.id,
            shipmentIds: [await shipment(cookies.opsDxb, dxbRoute, ['MAIN_FREIGHT'])],
          }).expect(201)
        ).body as TripDto
      ).id;
    ids.trip = await trip();
    ids.recentTrip = await trip();
    await t.prisma.trip.update({
      where: { id: ids.trip },
      data: { plannedArrival: new Date(`${old}T08:00:00Z`) },
    });
    await t.prisma.trip.update({
      where: { id: ids.recentTrip },
      data: { plannedArrival: new Date(Date.now() - 2 * 3_600_000) },
    });

    // Alert 2: an approved invoice of a Port Sudan shipment, long past its due date.
    const ptsCustomer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger Alerts ${year} ${suffix}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    const ptsShipment = await shipment(
      cookies.salesPts,
      { customerId: ptsCustomer.id, from: portSudan, to: khartoum },
      ['MAIN_FREIGHT'],
    );
    const draft = (
      await post('/customer-invoices', cookies.financePts, { shipmentId: ptsShipment }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      currency: 'USD',
      invoiceDate: `${year}-01-01`,
      dueDate: old,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '700' }],
    }).expect(200);
    await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200);
    ids.invoice = draft.id;
  });

  afterAll(async () => {
    // Back to the starting waits, by nobody: the test users are deleted.
    for (const [kind, days] of Object.entries(DEFAULT_WAITS)) {
      await t.prisma.alertSetting.update({
        where: { kind: kind as AlertKind },
        data: { days, updatedById: null },
      });
    }
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('shows each alert to the staff it concerns, longest waiting first', async () => {
    const ops = await alerts(cookies.opsDxb);
    expect(ops.groups.map((g) => g.kind)).toEqual([
      'SHIPMENT_PAST_ETA',
      'INVOICE_OVERDUE',
      'CUSTOMS_STALLED',
      'STORAGE_EXCEEDED',
      'TRIP_LATE',
    ]);
    const late = find(ops, 'SHIPMENT_PAST_ETA', ids.late);
    expect(late).toMatchObject({ branchCode: 'DXB', detail: customer.name, since: old });
    expect(late?.days).toBeGreaterThan(365 * 1000);
    expect(late?.number).toMatch(/^NOL-SHP-/);
    expect(find(ops, 'SHIPMENT_PAST_ETA', ids.recent)?.days).toBe(2);
    expect(find(ops, 'CUSTOMS_STALLED', ids.customs)).toMatchObject({
      detail: 'SUBMITTED',
      since: old,
    });
    expect(find(ops, 'STORAGE_EXCEEDED', ids.stored)).toMatchObject({
      detail: warehouse.code,
      since: old,
    });
    expect(find(ops, 'TRIP_LATE', ids.trip)).toMatchObject({ detail: driver.name, since: old });
    expect(find(ops, 'TRIP_LATE', ids.recentTrip)?.days).toBe(0);
    // The oldest heads its list; the counts add up.
    expect(ops.groups.find((g) => g.kind === 'SHIPMENT_PAST_ETA')?.items[0]?.since).toBe(old);
    expect(ops.total).toBe(ops.groups.reduce((n, g) => n + g.count, 0));
    // Port Sudan's invoice is not Dubai's.
    expect(find(ops, 'INVOICE_OVERDUE', ids.invoice)).toBeUndefined();

    const finance = await alerts(cookies.financePts);
    expect(find(finance, 'INVOICE_OVERDUE', ids.invoice)).toMatchObject({
      branchCode: 'PTS',
      since: old,
    });
    expect(find(finance, 'SHIPMENT_PAST_ETA', ids.late)).toBeUndefined();
    expect(find(await alerts(cookies.management), 'INVOICE_OVERDUE', ids.invoice)).toBeDefined();
  });

  it('shows nothing of other branches or outside the role', async () => {
    const jed = await alerts(cookies.opsJed);
    for (const id of Object.values(ids)) {
      expect(jed.groups.flatMap((g) => g.items).map((i) => i.refId)).not.toContain(id);
    }
    // Warehouse staff: no customs files, no invoices.
    const store = await alerts(cookies.warehouseDxb);
    expect(store.groups.map((g) => g.kind)).toEqual([
      'SHIPMENT_PAST_ETA',
      'STORAGE_EXCEEDED',
      'TRIP_LATE',
    ]);
    // Customs staff: no trips, no invoices.
    expect((await alerts(cookies.customsDxb)).groups.map((g) => g.kind)).toEqual([
      'SHIPMENT_PAST_ETA',
      'CUSTOMS_STALLED',
      'STORAGE_EXCEEDED',
    ]);
    // A driver: only their own late trips (not the branch's shipments).
    const own = await alerts(cookies.driver);
    expect(own.groups.map((g) => g.kind)).toEqual(['TRIP_LATE']);
    expect(own.groups[0]?.items.map((i) => i.refId).sort()).toEqual(
      [ids.trip, ids.recentTrip].sort(),
    );
    await get('/alerts', '').expect(401);
  });

  it('waits the days the administrator sets, then drops what is done', async () => {
    await setWait('SHIPMENT_PAST_ETA', 2);
    let ops = await alerts(cookies.opsDxb);
    expect(ops.groups.find((g) => g.kind === 'SHIPMENT_PAST_ETA')?.thresholdDays).toBe(2);
    expect(find(ops, 'SHIPMENT_PAST_ETA', ids.recent)).toBeUndefined();
    expect(find(ops, 'SHIPMENT_PAST_ETA', ids.late)).toBeDefined();
    await setWait('SHIPMENT_PAST_ETA', 1);
    expect(find(await alerts(cookies.opsDxb), 'SHIPMENT_PAST_ETA', ids.recent)).toBeDefined();

    await setWait('TRIP_LATE', 1);
    ops = await alerts(cookies.opsDxb);
    expect(find(ops, 'TRIP_LATE', ids.recentTrip)).toBeUndefined();
    expect(find(ops, 'TRIP_LATE', ids.trip)).toBeDefined();

    // Cleared, released and cancelled: no longer waiting.
    await put(`/shipments/${ids.customs}/customs`, cookies.customsDxb, {
      status: 'CLEARED',
      declarationNumber: 'AL-1',
      submittedOn: old,
      clearedOn: old,
    }).expect(200);
    await post(`/shipments/${ids.stored}/warehouse/releases`, cookies.warehouseDxb, {
      warehouseId: warehouse.id,
      packages: 5,
    }).expect(201);
    await post(`/trips/${ids.trip}/cancel`, cookies.opsDxb, { reason: 'Not needed' }).expect(200);
    ops = await alerts(cookies.opsDxb);
    expect(find(ops, 'CUSTOMS_STALLED', ids.customs)).toBeUndefined();
    expect(find(ops, 'STORAGE_EXCEEDED', ids.stored)).toBeUndefined();
    expect(find(ops, 'TRIP_LATE', ids.trip)).toBeUndefined();
  });

  it('lets only the administrator change the days, within 0 to 365', async () => {
    const settings = (await get('/alerts/settings', cookies.admin).expect(200))
      .body as AlertSettingDto[];
    expect(settings.map((s) => s.kind)).toEqual(Object.keys(DEFAULT_WAITS));
    await get('/alerts/settings', cookies.management).expect(403);
    await get('/alerts/settings', cookies.managerDxb).expect(403);
    await put('/alerts/settings/CUSTOMS_STALLED', cookies.management, { days: 5 }).expect(403);
    await put('/alerts/settings/CUSTOMS_STALLED', cookies.opsDxb, { days: 5 }).expect(403);
    for (const body of [{ days: 366 }, { days: -1 }, { days: 2.5 }, { days: '5' }, {}]) {
      await put('/alerts/settings/CUSTOMS_STALLED', cookies.admin, body).expect(400);
    }
    await put('/alerts/settings/NEW_ALERT', cookies.admin, { days: 5 }).expect(400);
    await put('/alerts/settings/CUSTOMS_STALLED', cookies.admin, {
      days: 5,
      kind: 'TRIP_LATE',
    }).expect(400);

    const saved = (
      await put('/alerts/settings/CUSTOMS_STALLED', cookies.admin, { days: 5 }).expect(200)
    ).body as AlertSettingDto[];
    expect(saved.find((s) => s.kind === 'CUSTOMS_STALLED')).toMatchObject({
      days: 5,
      updatedByName: 'Integration Test',
    });
    // The database keeps the bounds too.
    await expect(
      t.prisma.alertSetting.update({ where: { kind: 'TRIP_LATE' }, data: { days: 400 } }),
    ).rejects.toThrow();
  });
});
