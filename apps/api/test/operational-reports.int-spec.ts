import {
  ROLE_PERMISSIONS,
  type AccountDto,
  type AuditLogDto,
  type BookingDto,
  type BranchDashboardDto,
  type CarrierDto,
  type CustomerActivityDto,
  type CustomerDto,
  type CustomerInvoiceDto,
  type CustomsFilesDto,
  type DriverDto,
  type LateShipmentsDto,
  type ManagementDashboardDto,
  type QuotationDto,
  type SalesConversionDto,
  type ShipmentsReportDto,
  type TripDto,
  type TripsReportDto,
  type VehicleDto,
  type WarehouseDto,
  type WarehouseMovementDto,
  type WarehouseMovementsDto,
  type WarehouseOnHandDto,
} from '@nolon/shared';
import ExcelJS from 'exceljs';
import { randomInt, randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daysBetween, todayIn } from '../src/common/dates.js';
import type { AuthUser } from '../src/auth/auth-user.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { OperationalReportsService } from '../src/reports/operational-reports.service.js';
import { TripReportsService } from '../src/transport/trip-reports.service.js';
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
 * Operational reports and dashboards (annex D sections 2 and 3) against PostgreSQL. Invoices and
 * trip costs post journal entries, which are never deleted, so the users are LEDGER users and the
 * records are dated in a random year of their own (1800-1899: the financial reports suite uses
 * 1000-1799, the accounting suites 1901-2000), with their own customers, warehouse, vehicle,
 * driver and carrier, so the figures below are exact. Fixtures move creation times into that year
 * directly in the database, as the transport suites do.
 */
describe('operational reports and dashboards', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let c1: CustomerDto;
  let c2: CustomerDto;
  let warehouse: WarehouseDto;
  let vehicle: VehicleDto;
  let driver: DriverDto;
  let carrier: CarrierDto;
  let cashUsd: AccountDto;
  let ownTrip: TripDto;
  let externalTrip: TripDto;
  let portSudan: string;
  let khartoum: string;
  let atbara: string;
  const s: Record<'s1' | 's2' | 's3' | 's4' | 's5' | 't1' | 't2' | 't3', string> = {
    s1: '',
    s2: '',
    s3: '',
    s4: '',
    s5: '',
    t1: '',
    t2: '',
    t3: '',
  };
  const numbers = new Map<string, string>();
  const movementNumbers: string[] = [];
  const ids = { ops: '', warehouse: '', customs: '', manager: '' };
  let dxb: string;
  /** June: a cancelled, an approved and a draft invoice of customer 2 (revenue counts one). */
  const june = () => `from=${d('06-01')}&to=${d('06-30')}`;
  const tz: Record<'late' | 'onTime' | 'unknown', string> = { late: '', onTime: '', unknown: '' };
  const year = randomInt(1800, 1900);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const at = (monthDay: string, time = '10:00:00') => `${year}-${monthDay}T${time}+03:00`;
  const march = () => `from=${d('03-01')}&to=${d('03-31')}`;
  const may = () => `from=${d('05-01')}&to=${d('05-31')}`;
  const ptsToday = () => todayIn('Africa/Khartoum');
  const cookies = {
    admin: '',
    salesPts: '',
    opsPts: '',
    financePts: '',
    warehousePts: '',
    customsPts: '',
    managerPts: '',
    managerJed: '',
    opsJed: '',
    driver: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const send = (method: 'post' | 'patch' | 'put', path: string, cookie: string, body: object) =>
    t.http()[method](`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const post = (path: string, cookie: string, body: object = {}) =>
    send('post', path, cookie, body);

  async function report<T>(path: string, cookie = cookies.opsPts): Promise<T> {
    return (await get(path, cookie).expect(200)).body as T;
  }

  /** A confirmed booking's shipment, created on `created` (fixture) with ETA/ETD as given. */
  async function shipment(
    customer: CustomerDto,
    destination: string,
    volumeCbm: string,
    weightKg: string,
    created: string,
    eta: string | null = null,
  ): Promise<string> {
    const booking = (
      await post('/bookings', cookies.opsPts, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: destination,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT', 'WAREHOUSE', 'CUSTOMS'],
        items: [{ cargoType: 'GENERAL', quantity: 10, volumeCbm, weightKg }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    const id = confirmed.shipmentId;
    const when = new Date(at(created, '09:00:00'));
    await t.prisma.booking.update({ where: { id: booking.id }, data: { createdAt: when } });
    const row = await t.prisma.shipment.update({
      where: { id },
      data: { createdAt: when, eta: eta ? new Date(`${eta}T00:00:00Z`) : null },
    });
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: id },
      data: { occurredAt: when },
    });
    numbers.set(id, row.number);
    return id;
  }

  /** Fixture: the shipment was delivered on `day` (status and its event). */
  async function delivered(id: string, day: string): Promise<void> {
    await t.prisma.shipment.update({ where: { id }, data: { status: 'DELIVERED' } });
    await t.prisma.shipmentEvent.create({
      data: {
        shipmentId: id,
        kind: 'STATUS',
        status: 'DELIVERED',
        fromStatus: 'CREATED',
        occurredAt: new Date(at(day, '15:00:00')),
        branchId: pts,
        userId: ids.ops,
        source: 'USER',
      },
    });
  }

  async function quotation(status: 'DRAFT' | 'SENT' | 'APPROVED' | 'REJECTED', sent: string) {
    const q = (
      await post('/quotations', cookies.salesPts, {
        customerId: c1.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        currency: 'USD',
        validUntil: '2999-12-31',
        lines: [
          { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '100' },
        ],
      }).expect(201)
    ).body as QuotationDto;
    if (status === 'DRAFT') return q;
    await post(`/quotations/${q.id}/send`, cookies.salesPts).expect(200);
    await t.prisma.quotation.update({
      where: { id: q.id },
      data: { sentAt: new Date(at(sent)) },
    });
    if (status === 'APPROVED')
      await post(`/quotations/${q.id}/approve`, cookies.salesPts).expect(200);
    if (status === 'REJECTED') {
      await post(`/quotations/${q.id}/reject`, cookies.salesPts, { reason: 'Too dear' }).expect(
        200,
      );
    }
    return q;
  }

  async function invoice(shipmentId: string, invoiceDate: string, dueDate: string, price: string) {
    const draft = (await post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201))
      .body as CustomerInvoiceDto;
    await send('patch', `/customer-invoices/${draft.id}`, cookies.financePts, {
      currency: 'USD',
      invoiceDate,
      dueDate,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: price }],
    }).expect(200);
    return draft;
  }

  const movement = async (
    kind: 'receipts' | 'releases',
    shipmentId: string,
    packages: number,
    weightKg: string,
    when: string,
  ) => {
    const m = (
      await post(`/shipments/${shipmentId}/warehouse/${kind}`, cookies.warehousePts, {
        warehouseId: warehouse.id,
        packages,
        weightKg,
        occurredAt: at(when),
        ...(kind === 'receipts' ? { condition: 'GOOD' } : {}),
      }).expect(201)
    ).body as WarehouseMovementDto;
    movementNumbers.push(m.number);
  };

  async function trip(body: object, shipmentIds: string[], moves: [string, string][]) {
    let created = (
      await post('/trips', cookies.opsPts, {
        branchId: pts,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        shipmentIds,
        ...body,
      }).expect(201)
    ).body as TripDto;
    const planned = new Date(at('05-01', '08:00:00'));
    await t.prisma.trip.update({ where: { id: created.id }, data: { createdAt: planned } });
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: { in: shipmentIds } },
      data: { occurredAt: planned },
    });
    for (const [status, day] of moves) {
      created = (
        await post(`/trips/${created.id}/status`, cookies.opsPts, {
          status,
          occurredAt: at(day, '08:00:00'),
        }).expect(200)
      ).body as TripDto;
    }
    return created;
  }

  async function workbookValues(res: Response): Promise<unknown[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(res.body as Buffer).buffer);
    const values: unknown[] = [];
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          values.push(cell.value);
        }),
      ),
    );
    return values;
  }

  const binary = (res: Response, done: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    dxb = await branchId(t.prisma, 'DXB');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    atbara = await loc('SDATB');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      warehousePts: await createUser(t.prisma, ['WAREHOUSE'], ['PTS'], LEDGER_PREFIX),
      customsPts: await createUser(t.prisma, ['CUSTOMS'], ['PTS'], LEDGER_PREFIX),
      managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
      managerJed: await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'], LEDGER_PREFIX),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
      driver: await createUser(t.prisma, ['DRIVER'], ['PTS'], LEDGER_PREFIX),
    };
    ids.ops = users.opsPts.id;
    ids.warehouse = users.warehousePts.id;
    ids.customs = users.customsPts.id;
    ids.manager = users.managerPts.id;
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const customer = async (name: string) =>
      (
        await post('/customers', cookies.salesPts, {
          branchId: pts,
          kind: 'COMPANY',
          name: `Ops ${name} ${year} ${suffix}`,
          phone: uniquePhone(),
          preferredCurrency: 'USD',
        }).expect(201)
      ).body as CustomerDto;
    c1 = await customer('Alpha');
    c2 = await customer('Beta');
    warehouse = (
      await post('/warehouses', cookies.warehousePts, {
        branchId: pts,
        code: `OR-${suffix}`,
        nameEn: 'Report test store',
        nameAr: 'مستودع اختبار التقارير',
      }).expect(201)
    ).body as WarehouseDto;
    vehicle = (
      await post('/transport/vehicles', cookies.opsPts, {
        branchId: pts,
        plateNumber: `LG OR ${suffix}`,
        vehicleType: 'Flatbed',
      }).expect(201)
    ).body as VehicleDto;
    driver = (
      await post('/transport/drivers', cookies.opsPts, {
        branchId: pts,
        name: `LG OR Driver ${suffix}`,
      }).expect(201)
    ).body as DriverDto;
    carrier = (
      await post('/transport/carriers', cookies.opsPts, { name: `LG OR Carrier ${suffix}` }).expect(
        201,
      )
    ).body as CarrierDto;
    cashUsd = (
      await post('/accounting/accounts', cookies.admin, {
        code: `O${suffix}U`,
        nameEn: 'Ops report cash USD',
        nameAr: 'نقدية اختبار التقارير التشغيلية',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'USD',
        branchId: pts,
      }).expect(201)
    ).body as AccountDto;

    // Customer 1 in March: S1 delivered 3 days late, S2 still open after its ETA, S3 to Atbara
    // delivered on its ETA, S4 cancelled. Customer 2: S5 in April.
    s.s1 = await shipment(c1, khartoum, '5', '100', '03-01', d('03-10'));
    s.s2 = await shipment(c1, khartoum, '3', '60', '03-02', d('03-20'));
    s.s3 = await shipment(c1, atbara, '1', '20', '03-03', d('03-25'));
    s.s4 = await shipment(c1, khartoum, '2', '40', '03-04', d('03-05'));
    s.s5 = await shipment(c2, khartoum, '4', '80', '04-15');
    await post(`/shipments/${s.s4}/cancel`, cookies.opsPts, { reason: 'Customer withdrew' }).expect(
      200,
    );
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: s.s4 },
      data: { occurredAt: new Date(at('03-04')) },
    });

    // Warehouse: S2 received 10 and released 4; S3 received 5, released 5, received 2 again.
    await movement('receipts', s.s2, 10, '200', '03-05');
    await movement('releases', s.s2, 4, '80', '03-06');
    await movement('receipts', s.s3, 5, '50', '03-02');
    await movement('releases', s.s3, 5, '50', '03-03');
    await movement('receipts', s.s3, 2, '20', '03-08');

    // Customs: S1 cleared in 4 days (saved twice: only the last update is kept), S2 submitted,
    // S3 opened and not submitted.
    const customs = (id: string, body: object) =>
      send('put', `/shipments/${id}/customs`, cookies.customsPts, body).expect(200);
    await customs(s.s1, { status: 'SUBMITTED', submittedOn: d('03-02') });
    await customs(s.s1, { status: 'CLEARED', submittedOn: d('03-02'), clearedOn: d('03-06') });
    await customs(s.s2, { status: 'SUBMITTED', submittedOn: d('03-04'), declarationNumber: 'D-2' });
    await customs(s.s3, { status: 'PENDING', brokerName: 'Red Sea Clearing' });
    await t.prisma.customsClearance.update({
      where: { shipmentId: s.s3 },
      data: { createdAt: new Date(at('03-07')) },
    });

    // Revenue: 1000 on S1 (due 10 March), 250.5 on S2 (due 30 April); a draft that counts nothing.
    const i1 = await invoice(s.s1, d('03-10'), d('03-10'), '1000');
    const i2 = await invoice(s.s2, d('03-15'), d('04-30'), '250.5');
    await invoice(s.s3, d('03-20'), d('03-20'), '999');
    for (const i of [i1, i2]) {
      await post(`/customer-invoices/${i.id}/approve`, cookies.financePts).expect(200);
    }

    await delivered(s.s1, '03-13');
    await delivered(s.s3, '03-25');

    // Quotations sent in March: one approved and booked, one rejected, one still open; a draft.
    const q1 = await quotation('APPROVED', '03-05');
    await quotation('REJECTED', '03-06');
    await quotation('SENT', '03-07');
    await quotation('DRAFT', '03-08');
    const fromQuotation = (
      await post(`/bookings/from-quotation/${q1.id}`, cookies.salesPts, {
        items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm: '1', weightKg: '10' }],
      }).expect(201)
    ).body as BookingDto;
    await t.prisma.booking.update({
      where: { id: fromQuotation.id },
      data: { createdAt: new Date(at('03-09')) },
    });

    // Trips in May for customer 2: an own trip (arrived) with an expense of 300 and one of 50
    // cancelled; an external trip of 400, completed (accrued).
    s.t1 = await shipment(c2, khartoum, '1', '10', '04-20');
    s.t2 = await shipment(c2, khartoum, '1', '10', '04-21');
    s.t3 = await shipment(c2, khartoum, '1', '10', '04-22');
    ownTrip = await trip(
      { kind: 'OWN', vehicleId: vehicle.id, driverId: driver.id },
      [s.t1, s.t2],
      [
        ['DEPARTED', '05-02'],
        ['ARRIVED', '05-03'],
      ],
    );
    const expense = (amount: string) =>
      post(`/trips/${ownTrip.id}/expenses`, cookies.opsPts, {
        requestId: randomUUID(),
        expenseDate: d('05-03'),
        description: `Fuel ${amount}`,
        amount,
        currency: 'USD',
        cashAccountId: cashUsd.id,
      }).expect(201);
    await expense('300');
    const withBoth = (await expense('50')).body as TripDto;
    const fifty = withBoth.expenses.find((e) => e.amount === '50');
    if (!fifty) throw new Error('No expense');
    await post(`/trips/${ownTrip.id}/expenses/${fifty.id}/cancel`, cookies.financePts, {
      reason: 'Entered twice',
    }).expect(200);
    externalTrip = await trip(
      {
        kind: 'EXTERNAL',
        carrierId: carrier.id,
        agreedCost: '400',
        currency: 'USD',
        externalVehicle: 'KH 9988',
        externalDriver: 'Hired driver',
      },
      [s.t3],
      [
        ['DEPARTED', '05-05'],
        ['ARRIVED', '05-06'],
        ['COMPLETED', '05-07'],
      ],
    );

    // June invoices for customer 2: S5's cancelled (an approved invoice is corrected by a credit
    // note, so only a draft can be cancelled), T1's approved (77), T2's still a draft.
    const cancelled = await invoice(s.s5, d('06-10'), d('06-10'), '500');
    await post(`/customer-invoices/${cancelled.id}/cancel`, cookies.financePts, {
      reason: 'Wrong customer',
    }).expect(200);
    const approved = await invoice(s.t1, d('06-12'), d('06-12'), '77');
    await post(`/customer-invoices/${approved.id}/approve`, cookies.financePts).expect(200);
    await invoice(s.t2, d('06-14'), d('06-14'), '33');

    // Dubai (UTC+4), ETAs in July: delivered at 22:00 UTC on its ETA (02:00 the next day in
    // Dubai: late), at 19:30 UTC on its ETA (23:30 in Dubai: on time), and one marked delivered
    // with no delivery recorded (its day unknown: neither late nor open).
    const inDubai = async (eta: string, deliveredAt: string | null) => {
      const id = await shipment(c2, khartoum, '1', '1', '07-01', d(eta));
      await t.prisma.shipment.update({
        where: { id },
        data: { branchId: dxb, status: 'DELIVERED' },
      });
      if (deliveredAt) {
        await t.prisma.shipmentEvent.create({
          data: {
            shipmentId: id,
            kind: 'STATUS',
            status: 'DELIVERED',
            fromStatus: 'CREATED',
            occurredAt: new Date(deliveredAt),
            branchId: dxb,
            userId: ids.ops,
            source: 'USER',
          },
        });
      }
      return id;
    };
    tz.late = await inDubai('07-10', `${d('07-10')}T22:00:00Z`);
    tz.onTime = await inDubai('07-11', `${d('07-11')}T19:30:00Z`);
    tz.unknown = await inDubai('07-12', null);

    // Due in and out of PTS today: S5.
    const today = new Date(`${ptsToday()}T00:00:00Z`);
    await t.prisma.shipment.update({ where: { id: s.s5 }, data: { eta: today, etd: today } });
  });

  afterAll(async () => {
    await t.close();
  });

  describe('1. shipments by status, branch, route and mode', () => {
    it('counts the period’s shipments of the customer by each dimension', async () => {
      const r = await report<ShipmentsReportDto>(
        `/reports/shipments?${march()}&branchId=${pts}&customerId=${c1.id}`,
      );
      expect(r.total).toBe(4);
      expect(r.byStatus).toEqual([
        { status: 'DELIVERED', count: 2 },
        { status: 'CANCELLED', count: 1 },
        { status: 'CREATED', count: 1 },
      ]);
      expect(r.byBranch.map((b) => [b.code, b.count])).toEqual([['PTS', 4]]);
      expect(r.byMode).toEqual([{ mode: 'ROAD', count: 4 }]);
      expect(r.byRoute.map((x) => [x.origin.code, x.destination.code, x.count])).toEqual([
        ['SDPZU', 'SDKRT', 3],
        ['SDPZU', 'SDATB', 1],
      ]);
      expect(r.shipments.map((x) => x.number)).toEqual(
        [s.s1, s.s2, s.s3, s.s4].map((id) => numbers.get(id)),
      );
      expect(r.shipments[0]).toMatchObject({
        createdOn: d('03-01'),
        eta: d('03-10'),
        status: 'DELIVERED',
        customerName: c1.name,
      });
      expect(r.truncated).toBe(false);

      const cancelled = await report<ShipmentsReportDto>(
        `/reports/shipments?${march()}&customerId=${c1.id}&status=CANCELLED`,
      );
      expect(cancelled.shipments.map((x) => x.shipmentId)).toEqual([s.s4]);
      const sea = await report<ShipmentsReportDto>(
        `/reports/shipments?${march()}&customerId=${c1.id}&mode=SEA`,
      );
      expect(sea.total).toBe(0);
    });

    it('another branch is 403 or empty; a driver has no access; bad periods are 400', async () => {
      await get(`/reports/shipments?${march()}&branchId=${pts}`, cookies.opsJed).expect(403);
      const own = await report<ShipmentsReportDto>(
        `/reports/shipments?${march()}&customerId=${c1.id}`,
        cookies.opsJed,
      );
      expect(own.total).toBe(0);
      expect(own.shipments).toEqual([]);
      await get(`/reports/shipments?${march()}`, cookies.driver).expect(403);
      await get(`/reports/shipments?from=${d('03-31')}&to=${d('03-01')}`, cookies.opsPts).expect(
        400,
      );
      await get('/reports/shipments', cookies.opsPts).expect(400);
      await t.http().get(`/api/v1/reports/shipments?${march()}`).expect(401);
    });

    it('exports the report to Excel in Arabic', async () => {
      const res = await get(
        `/reports/shipments/export?${march()}&branchId=${pts}&customerId=${c1.id}&locale=ar`,
        cookies.opsPts,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.headers['content-disposition']).toContain(
        `shipments-${d('03-01')}_${d('03-31')}.xlsx`,
      );
      const values = await workbookValues(res);
      expect(values).toContain('الشحنات حسب الحالة والفرع والمسار ونمط الشحن');
      expect(values).toContain(numbers.get(s.s1));
      expect(values).toContain('تم التسليم');
      expect(values).toContain(4);
      await get(`/reports/shipments/export?${march()}&branchId=${pts}`, cookies.opsJed).expect(403);
      await get(`/reports/shipments/export?${march()}`, cookies.driver).expect(403);
    });
  });

  describe('2. late shipments', () => {
    it('lists the delivered-late and still-open late shipments, not the cancelled one', async () => {
      const r = await report<LateShipmentsDto>(
        `/reports/late-shipments?${march()}&customerId=${c1.id}`,
      );
      const openDays = daysBetween(d('03-20'), ptsToday());
      expect(r).toMatchObject({ withEta: 3, late: 2, openLate: 1, deliveredLate: 1 });
      expect(r.shipments.map((x) => [x.shipmentId, x.deliveredOn, x.daysLate])).toEqual([
        [s.s1, d('03-13'), 3],
        [s.s2, null, openDays],
      ]);
      const average = (3 + openDays) / 2;
      expect(r.averageDaysLate).toBe(average.toFixed(1));
      await get(`/reports/late-shipments?${march()}&branchId=${pts}`, cookies.opsJed).expect(403);
      await get(`/reports/late-shipments?${march()}`, cookies.driver).expect(403);
      const jedView = await report<LateShipmentsDto>(
        `/reports/late-shipments?${march()}&customerId=${c1.id}`,
        cookies.opsJed,
      );
      expect(jedView).toMatchObject({ withEta: 0, late: 0, shipments: [] });
      await get(`/reports/late-shipments/export?${march()}&branchId=${pts}`, cookies.opsJed).expect(
        403,
      );
      await get(`/reports/late-shipments/export?${march()}`, cookies.driver).expect(403);
    });

    it('takes the delivery day in the branch’s time zone, and never guesses an unknown one', async () => {
      const r = await report<LateShipmentsDto>(
        `/reports/late-shipments?from=${d('07-01')}&to=${d('07-31')}&branchId=${dxb}&customerId=${c2.id}`,
        cookies.admin,
      );
      expect(r).toMatchObject({ withEta: 3, late: 1, openLate: 0, deliveredLate: 1 });
      expect(r.shipments.map((x) => [x.shipmentId, x.deliveredOn, x.daysLate])).toEqual([
        [tz.late, d('07-11'), 1],
      ]);
      expect(r.averageDaysLate).toBe('1.0');
    });
  });

  describe('3. quotations, bookings and conversion', () => {
    it('counts quotations sent and bookings created, with the rates', async () => {
      const r = await report<SalesConversionDto>(
        `/reports/sales-conversion?${march()}&branchId=${pts}&customerId=${c1.id}`,
      );
      const expected = {
        quotationsSent: 3,
        quotations: { SENT: 1, APPROVED: 1, REJECTED: 1, EXPIRED: 0 },
        quotationsBooked: 1,
        bookingsCreated: 5,
        bookings: { DRAFT: 1, CONFIRMED: 3, COMPLETED: 0, CANCELLED: 1 },
        bookingsFromQuotation: 1,
        approvalRate: '33.33',
        conversionRate: '33.33',
        confirmationRate: '60.00',
      };
      expect(r.totals).toEqual(expected);
      expect(r.branches).toHaveLength(1);
      const [branch] = r.branches;
      expect(branch).toMatchObject({ id: pts, code: 'PTS', ...expected });
      await get(`/reports/sales-conversion?${march()}&branchId=${pts}`, cookies.opsJed).expect(403);
      await get(`/reports/sales-conversion?${march()}`, cookies.driver).expect(403);
      const jedView = await report<SalesConversionDto>(
        `/reports/sales-conversion?${march()}&customerId=${c1.id}`,
        cookies.opsJed,
      );
      expect(jedView.totals).toMatchObject({ quotationsSent: 0, bookingsCreated: 0 });
      expect(jedView.branches.map((b) => b.id)).toEqual([jed]);
      await get(
        `/reports/sales-conversion/export?${march()}&branchId=${pts}`,
        cookies.opsJed,
      ).expect(403);
    });
  });

  describe('4. customer activity', () => {
    it('adds shipments, cargo and approved invoice revenue per customer', async () => {
      const r = await report<CustomerActivityDto>(
        `/reports/customer-activity?${march()}&customerId=${c1.id}`,
        cookies.managerPts,
      );
      expect(r.revenueShown).toBe(true);
      const row = {
        customerId: c1.id,
        customerName: c1.name,
        shipments: 3,
        volumeCbm: '9',
        weightKg: '180',
        invoices: 2,
        revenueUsd: '1250.5',
      };
      expect(r.customers).toEqual([row]);
      expect(r.totals).toEqual({
        shipments: 3,
        volumeCbm: '9',
        weightKg: '180',
        invoices: 2,
        revenueUsd: '1250.5',
      });
      const jedView = await report<CustomerActivityDto>(
        `/reports/customer-activity?${march()}&customerId=${c1.id}`,
        cookies.managerJed,
      );
      expect(jedView.customers).toEqual([]);
      await get(`/reports/customer-activity?${march()}&branchId=${pts}`, cookies.managerJed).expect(
        403,
      );
      await get(`/reports/customer-activity?${march()}`, cookies.driver).expect(403);
    });

    it('counts neither a cancelled nor a draft invoice', async () => {
      const r = await report<CustomerActivityDto>(
        `/reports/customer-activity?${june()}&customerId=${c2.id}`,
        cookies.managerPts,
      );
      expect(r.customers).toEqual([
        {
          customerId: c2.id,
          customerName: c2.name,
          shipments: 0,
          volumeCbm: '0',
          weightKg: '0',
          invoices: 1,
          revenueUsd: '77',
        },
      ]);
    });

    it('leaves out invoices and revenue without financial_reports:view, in the export too', async () => {
      for (const cookie of [cookies.opsPts, cookies.warehousePts, cookies.customsPts]) {
        const r = await report<CustomerActivityDto>(
          `/reports/customer-activity?${march()}&customerId=${c1.id}`,
          cookie,
        );
        expect(r.revenueShown).toBe(false);
        expect(r.customers).toEqual([
          {
            customerId: c1.id,
            customerName: c1.name,
            shipments: 3,
            volumeCbm: '9',
            weightKg: '180',
            invoices: null,
            revenueUsd: null,
          },
        ]);
        expect(r.totals).toMatchObject({ invoices: null, revenueUsd: null });
      }
      const path = `/reports/customer-activity/export?${march()}&customerId=${c1.id}&locale=en`;
      const hidden = await workbookValues(
        await get(path, cookies.warehousePts).buffer(true).parse(binary).expect(200),
      );
      expect(hidden).toContain(c1.name);
      expect(hidden).not.toContain('Revenue (USD)');
      expect(hidden).not.toContain(1250.5);
      const shown = await workbookValues(
        await get(path, cookies.managerPts).buffer(true).parse(binary).expect(200),
      );
      expect(shown).toContain('Revenue (USD)');
      expect(shown).toContain(1250.5);
    });
  });

  describe('6-7. warehouse', () => {
    it('shows what is held now, since when, and the movements of the period', async () => {
      const r = await report<WarehouseOnHandDto>(
        `/reports/warehouse-on-hand?warehouseId=${warehouse.id}`,
      );
      const today = ptsToday();
      expect(
        r.rows.map((x) => [x.shipmentId, x.packages, x.weightKg, x.heldSince, x.daysHeld]),
      ).toEqual([
        [s.s2, 6, '120', d('03-05'), daysBetween(d('03-05'), today)],
        [s.s3, 2, '20', d('03-08'), daysBetween(d('03-08'), today)],
      ]);
      expect(r.totals).toEqual({ shipments: 2, packages: 8, weightKg: '140' });

      const m = await report<WarehouseMovementsDto>(
        `/reports/warehouse-movements?${march()}&warehouseId=${warehouse.id}`,
      );
      expect(m.receipts).toEqual({ movements: 3, packages: 17, weightKg: '270' });
      expect(m.releases).toEqual({ movements: 2, packages: 9, weightKg: '130' });
      expect(m.movements.map((x) => [x.kind, x.packages, x.shipmentNumber])).toEqual([
        ['RECEIPT', 5, numbers.get(s.s3)],
        ['RELEASE', 5, numbers.get(s.s3)],
        ['RECEIPT', 10, numbers.get(s.s2)],
        ['RELEASE', 4, numbers.get(s.s2)],
        ['RECEIPT', 2, numbers.get(s.s3)],
      ]);
      const releases = await report<WarehouseMovementsDto>(
        `/reports/warehouse-movements?${march()}&warehouseId=${warehouse.id}&kind=RELEASE`,
      );
      expect(releases.movements).toHaveLength(2);
      expect(releases.receipts.movements).toBe(0);
    });

    it('another branch sees nothing of it or is refused', async () => {
      const jedView = await report<WarehouseOnHandDto>(
        `/reports/warehouse-on-hand?warehouseId=${warehouse.id}`,
        cookies.opsJed,
      );
      expect(jedView.rows).toEqual([]);
      await get(`/reports/warehouse-on-hand?branchId=${pts}`, cookies.opsJed).expect(403);
      await get(`/reports/warehouse-movements?${march()}&branchId=${pts}`, cookies.opsJed).expect(
        403,
      );
      await get('/reports/warehouse-on-hand', cookies.driver).expect(403);
    });
  });

  describe('8. customs files', () => {
    it('counts the files by status, with the clearance time', async () => {
      const r = await report<CustomsFilesDto>(`/reports/customs-files?${march()}&branchId=${pts}`);
      const mine = r.files.filter((f) => [s.s1, s.s2, s.s3].includes(f.shipmentId));
      expect(r.total).toBe(3);
      expect(r.byStatus).toEqual([
        { status: 'CLEARED', count: 1 },
        { status: 'PENDING', count: 1 },
        { status: 'SUBMITTED', count: 1 },
      ]);
      expect(r.averageClearanceDays).toBe('4.0');
      const today = ptsToday();
      expect(mine.map((f) => [f.shipmentNumber, f.status, f.clearanceDays, f.daysOpen])).toEqual([
        [numbers.get(s.s1), 'CLEARED', 4, null],
        [numbers.get(s.s2), 'SUBMITTED', null, daysBetween(d('03-04'), today)],
        [numbers.get(s.s3), 'PENDING', null, daysBetween(d('03-07'), today)],
      ]);
      const cleared = await report<CustomsFilesDto>(
        `/reports/customs-files?${march()}&branchId=${pts}&status=CLEARED`,
      );
      expect(cleared.files.map((f) => f.shipmentId)).toEqual([s.s1]);
      await get(`/reports/customs-files?${march()}&branchId=${pts}`, cookies.opsJed).expect(403);
      const jedView = await report<CustomsFilesDto>(
        `/reports/customs-files?${march()}`,
        cookies.opsJed,
      );
      expect(jedView.files.some((f) => f.shipmentId === s.s1)).toBe(false);
      await get(`/reports/customs-files?${march()}`, cookies.driver).expect(403);
      await get(`/reports/customs-files/export?${march()}&branchId=${pts}`, cookies.opsJed).expect(
        403,
      );
    });
  });

  describe('9. trips', () => {
    it('costs each trip from its posted expenses and accrual, by vehicle, driver and carrier', async () => {
      const own = await report<TripsReportDto>(`/reports/trips?${may()}&vehicleId=${vehicle.id}`);
      expect(own.trips.map((x) => [x.tripId, x.tripDate, x.shipments, x.costUsd])).toEqual([
        [ownTrip.id, d('05-02'), 2, '300'],
      ]);
      expect(own.trips[0]).toMatchObject({
        vehicle: vehicle.plateNumber,
        driver: driver.name,
        status: 'ARRIVED',
      });
      expect(own.byVehicle).toEqual([
        { id: vehicle.id, name: vehicle.plateNumber, trips: 1, costUsd: '300' },
      ]);
      expect(own.byDriver).toEqual([
        { id: driver.id, name: driver.name, trips: 1, costUsd: '300' },
      ]);
      expect(own.byCarrier).toEqual([]);
      expect(own.totals).toEqual({ trips: 1, costUsd: '300' });

      const hired = await report<TripsReportDto>(`/reports/trips?${may()}&carrierId=${carrier.id}`);
      expect(hired.trips.map((x) => [x.tripId, x.vehicle, x.driver, x.costUsd])).toEqual([
        [externalTrip.id, 'KH 9988', 'Hired driver', '400'],
      ]);
      expect(hired.byCarrier).toEqual([
        { id: carrier.id, name: carrier.name, trips: 1, costUsd: '400' },
      ]);
      expect(hired.byVehicle).toEqual([]);
      const april = await report<TripsReportDto>(
        `/reports/trips?from=${d('04-01')}&to=${d('04-30')}&carrierId=${carrier.id}`,
      );
      expect(april.trips).toEqual([]);
    });

    it('totals and groups cover every matching trip when the listed rows are cut', async () => {
      const full = await report<TripsReportDto>(`/reports/trips?${may()}`);
      expect(full.trips.length).toBeGreaterThanOrEqual(2);
      expect(full.truncated).toBe(false);
      const manager: AuthUser = {
        id: ids.manager,
        email: 'manager@example.test',
        fullName: 'Manager',
        preferredLocale: 'en',
        sessionId: randomUUID(),
        credentialStamp: 'c',
        roles: ['BRANCH_MANAGER'],
        permissions: ROLE_PERMISSIONS.BRANCH_MANAGER,
        allBranches: false,
        allowedBranchIds: [pts],
      };
      const [from, to] = [d('05-01'), d('05-31')];
      const cut = await t.app
        .get(OperationalReportsService)
        .tripsReport(manager, { from, to, branchId: pts }, 1);
      const fullPts = await report<TripsReportDto>(
        `/reports/trips?from=${from}&to=${to}&branchId=${pts}`,
      );
      expect(cut.trips).toHaveLength(1);
      expect(cut.truncated).toBe(true);
      expect(cut.totals).toEqual(fullPts.totals);
      expect(cut.byVehicle).toEqual(fullPts.byVehicle);
      expect(cut.byDriver).toEqual(fullPts.byDriver);
      expect(cut.byCarrier).toEqual(fullPts.byCarrier);
      expect(cut.totals.trips).toBe(fullPts.trips.length);
    });

    it('another branch is 403 or empty; a driver has no access', async () => {
      await get(`/reports/trips?${may()}&branchId=${pts}`, cookies.opsJed).expect(403);
      const jedView = await report<TripsReportDto>(
        `/reports/trips?${may()}&vehicleId=${vehicle.id}`,
        cookies.opsJed,
      );
      expect(jedView.trips).toEqual([]);
      await get(`/reports/trips?${may()}`, cookies.driver).expect(403);
    });

    it('hides transport costs from Sales and Warehouse (annex A, restricted)', async () => {
      for (const cookie of [cookies.salesPts, cookies.warehousePts]) {
        const r = await report<TripsReportDto>(`/reports/trips?${may()}`, cookie);
        expect(r.showsCost).toBe(false);
        expect(r.trips.map((x) => x.tripId)).toContain(externalTrip.id);
        expect(r.trips.every((x) => x.costUsd === null)).toBe(true);
        expect(
          [...r.byVehicle, ...r.byDriver, ...r.byCarrier].every((g) => g.costUsd === null),
        ).toBe(true);
        expect(r.totals.costUsd).toBeNull();
        const trip = (await get(`/trips/${externalTrip.id}`, cookie).expect(200)).body as TripDto;
        expect(trip).toMatchObject({ showsCost: false, agreedCost: null, accrualShares: [] });
        const sheet = await get(
          `/reports/trips/export?${may()}&carrierId=${carrier.id}&locale=en`,
          cookie,
        )
          .buffer(true)
          .parse(binary)
          .expect(200);
        const values = await workbookValues(sheet);
        expect(values).toContain(externalTrip.number);
        expect(values).not.toContain(400);
        expect(values).not.toContain('Cost (USD)');
      }
      const ops = (await get(`/trips/${externalTrip.id}`, cookies.opsPts).expect(200))
        .body as TripDto;
      expect(ops).toMatchObject({ showsCost: true, agreedCost: '400' });
      const finance = await report<TripsReportDto>(`/reports/trips?${may()}`, cookies.financePts);
      expect(finance.showsCost).toBe(true);
    });

    it('exports the trips with their cost', async () => {
      const res = await get(
        `/reports/trips/export?${may()}&carrierId=${carrier.id}&locale=en`,
        cookies.opsPts,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      const values = await workbookValues(res);
      expect(values).toContain('Trips by vehicle, driver and carrier');
      expect(values).toContain(externalTrip.number);
      expect(values).toContain(400);
      expect(values).toContain('External carrier');
    });
  });

  describe('10. audit log', () => {
    const today = () => `from=${ptsToday()}&to=${ptsToday()}`;

    it('lists who recorded what, from the records that keep it', async () => {
      const r = await report<AuditLogDto>(
        `/reports/audit-log?${today()}&userId=${ids.warehouse}`,
        cookies.managerPts,
      );
      expect(r.entries.map((e) => [e.entity, e.action, e.reference])).toEqual(
        expect.arrayContaining([
          ['WAREHOUSE_MOVEMENT', 'RECEIVED', movementNumbers[0]],
          ['WAREHOUSE_MOVEMENT', 'RELEASED', movementNumbers[1]],
        ]),
      );
      expect(r.entries).toHaveLength(5);
      expect(r.entries.every((e) => e.userId === ids.warehouse && e.branchCode === 'PTS')).toBe(
        true,
      );
      expect(r.users.map((u) => u.id)).toEqual([ids.warehouse]);

      // Customs keeps only each file's last update: three files, three entries.
      const customs = await report<AuditLogDto>(
        `/reports/audit-log?${today()}&userId=${ids.customs}&entity=CUSTOMS`,
        cookies.managerPts,
      );
      expect(customs.entries.map((e) => [e.reference, e.action, e.status]).sort()).toEqual(
        [
          [numbers.get(s.s1), 'UPDATED', 'CLEARED'],
          [numbers.get(s.s2), 'UPDATED', 'SUBMITTED'],
          [numbers.get(s.s3), 'UPDATED', 'PENDING'],
        ].sort(),
      );
      const shipments = await report<AuditLogDto>(
        `/reports/audit-log?${today()}&userId=${ids.ops}&entity=SHIPMENT`,
        cookies.managerPts,
      );
      expect(
        shipments.entries.some(
          (e) => e.action === 'CANCELLED' && e.reference === numbers.get(s.s4),
        ),
      ).toBe(true);
      const none = await report<AuditLogDto>(
        `/reports/audit-log?${today()}&userId=${ids.warehouse}&entity=CUSTOMS`,
        cookies.managerPts,
      );
      expect(none.entries).toEqual([]);
    });

    it('filters a source on the wanted kind in its SQL, before the source’s limit', async () => {
      // A new trip by the operations user today: newer than their trip expenses.
      const shipmentId = await shipment(c2, khartoum, '1', '1', '08-01');
      await post('/trips', cookies.opsPts, {
        branchId: pts,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        shipmentIds: [shipmentId],
        kind: 'EXTERNAL',
        carrierId: carrier.id,
        agreedCost: '10',
        currency: 'USD',
      }).expect(201);
      const manager: AuthUser = {
        id: ids.manager,
        email: 'manager@example.test',
        fullName: 'Manager',
        preferredLocale: 'en',
        sessionId: randomUUID(),
        credentialStamp: 'c',
        roles: ['BRANCH_MANAGER'],
        permissions: ROLE_PERMISSIONS.BRANCH_MANAGER,
        allBranches: false,
        allowedBranchIds: [pts],
      };
      const trips = t.app.get(TripReportsService);
      const q = { from: ptsToday(), to: ptsToday(), userId: ids.ops, limit: 1 };
      const newest = await trips.auditEntries(manager, q);
      expect(newest[0]?.entity).toBe('TRIP');
      const expenses = await trips.auditEntries(manager, { ...q, entity: 'TRIP_EXPENSE' });
      expect(expenses.map((e) => [e.entity, e.action])).toEqual([
        ['TRIP_EXPENSE', 'CREATED'],
        ['TRIP_EXPENSE', 'CREATED'],
      ]);
      const r = await report<AuditLogDto>(
        `/reports/audit-log?${today()}&userId=${ids.ops}&entity=TRIP_EXPENSE`,
        cookies.managerPts,
      );
      expect(r.entries).toHaveLength(2);
      expect(r.entries.every((e) => e.entity === 'TRIP_EXPENSE')).toBe(true);
      expect(r.truncated).toBe(false);
    });

    it('needs audit_log:view and stays in the user’s branches', async () => {
      await get(`/reports/audit-log?${today()}`, cookies.opsPts).expect(403);
      await get(`/reports/audit-log/export?${today()}`, cookies.opsPts).expect(403);
      await get(`/reports/audit-log?${today()}&branchId=${pts}`, cookies.managerJed).expect(403);
      const jedView = await report<AuditLogDto>(
        `/reports/audit-log?${today()}&userId=${ids.warehouse}`,
        cookies.managerJed,
      );
      expect(jedView.entries).toEqual([]);
      const res = await get(
        `/reports/audit-log/export?${today()}&userId=${ids.warehouse}&locale=ar`,
        cookies.managerPts,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      const values = await workbookValues(res);
      expect(values).toContain('سجل التدقيق');
      expect(values).toContain(movementNumbers[0]);
      expect(values).toContain('استلام بضاعة');
    });
  });

  describe('module permissions', () => {
    const paths = {
      shipments: `/reports/shipments?${march()}`,
      late: `/reports/late-shipments?${march()}`,
      conversion: `/reports/sales-conversion?${march()}`,
      activity: `/reports/customer-activity?${march()}`,
      onHand: '/reports/warehouse-on-hand',
      movements: `/reports/warehouse-movements?${march()}`,
      customs: `/reports/customs-files?${march()}`,
      trips: `/reports/trips?${may()}`,
      audit: `/reports/audit-log?${march()}`,
    };
    const exportOf = (path: string) => path.replace(/^(\/reports\/[a-z-]+)/, '$1/export');

    it('a warehouse user reads neither quotations, customs files nor the audit log', async () => {
      const expected: Record<keyof typeof paths, number> = {
        shipments: 200,
        late: 200,
        conversion: 403,
        activity: 200,
        onHand: 200,
        movements: 200,
        customs: 403,
        trips: 200,
        audit: 403,
      };
      for (const [key, status] of Object.entries(expected) as [keyof typeof paths, number][]) {
        await get(paths[key], cookies.warehousePts).expect(status);
        await get(exportOf(paths[key]), cookies.warehousePts)
          .buffer(true)
          .parse(binary)
          .expect(status);
      }
    });

    it('a customs user reads neither quotations, trips nor the audit log', async () => {
      const expected: Record<keyof typeof paths, number> = {
        shipments: 200,
        late: 200,
        conversion: 403,
        activity: 200,
        onHand: 200,
        movements: 200,
        customs: 200,
        trips: 403,
        audit: 403,
      };
      for (const [key, status] of Object.entries(expected) as [keyof typeof paths, number][]) {
        await get(paths[key], cookies.customsPts).expect(status);
        await get(exportOf(paths[key]), cookies.customsPts)
          .buffer(true)
          .parse(binary)
          .expect(status);
      }
    });
  });

  describe('dashboards', () => {
    it('management: the period’s shipments, finance per branch and top customers', async () => {
      const r = await report<ManagementDashboardDto>(
        `/dashboard/management?${march()}&branchId=${pts}`,
        cookies.admin,
      );
      expect(r.shipments).toMatchObject({ newInPeriod: 3, deliveredInPeriod: 2 });
      expect(r.shipments?.late).toBeGreaterThanOrEqual(1);
      expect(r.shipments?.open).toBe(r.shipments?.byStatus.reduce((n, x) => n + x.count, 0));
      expect(
        r.finance?.branches.map((b) => [b.code, b.revenueUsd, b.costUsd, b.profitUsd]),
      ).toEqual([['PTS', '1250.5', '0', '1250.5']]);
      expect(r.finance?.totals).toEqual({
        revenueUsd: '1250.5',
        costUsd: '0',
        profitUsd: '1250.5',
      });
      expect(r.topCustomers).toEqual([
        { customerId: c1.id, customerName: c1.name, invoices: 2, revenueUsd: '1250.5' },
      ]);
      // Overdue: the AR aging of the period's end, less what is not yet due (I1's 1000 is late).
      const aging = (
        await get(`/reports/ar-aging?asOf=${d('03-31')}&branchId=${pts}`, cookies.admin).expect(200)
      ).body as { totals: { total: string; current: string } };
      const overdue = new Prisma.Decimal(r.finance?.overdueReceivablesUsd ?? '0');
      expect(overdue.toFixed()).toBe(
        new Prisma.Decimal(aging.totals.total).minus(aging.totals.current).toFixed(),
      );
      expect(overdue.gte(1000)).toBe(true);
      const may = await report<ManagementDashboardDto>(
        `/dashboard/management?${march().replace(/03-/g, '05-')}&branchId=${pts}`,
        cookies.admin,
      );
      // May: the expenses of 300 and 50 and the accrual of 400 (the 50's reversal is dated today).
      expect(may.finance?.totals.costUsd).toBe('750');
    });

    it('leaves out finance for a user without financial reports', async () => {
      const r = await report<ManagementDashboardDto>(`/dashboard/management?${march()}`);
      expect(r.finance).toBeNull();
      expect(r.topCustomers).toBeNull();
      expect(r.shipments).toMatchObject({ newInPeriod: 3, deliveredInPeriod: 2 });
    });

    it('branch: the day’s shipments, warehouse and trips of the user’s branch', async () => {
      const r = await report<BranchDashboardDto>(`/dashboard/branch?${march()}`);
      expect(r.branch.id).toBe(pts);
      expect(r.today).toBe(ptsToday());
      expect(r.todayShipments?.inbound.map((x) => x.shipmentId)).toContain(s.s5);
      expect(r.todayShipments?.outbound.map((x) => x.shipmentId)).toContain(s.s5);
      expect(r.trips?.active.map((x) => x.tripId)).toContain(ownTrip.id);
      expect(r.trips?.active.map((x) => x.tripId)).not.toContain(externalTrip.id);
      expect(r.warehouse?.packages).toBeGreaterThanOrEqual(8);
      expect(r.shipments?.newInPeriod).toBe(3);
      expect(r.finance).toBeNull();
    });

    it('needs dashboards:view and one of the user’s branches', async () => {
      await get(`/dashboard/branch?branchId=${jed}`, cookies.opsPts).expect(403);
      await get(`/dashboard/management?branchId=${jed}`, cookies.opsPts).expect(403);
      await get('/dashboard/branch', cookies.warehousePts).expect(403);
      await get('/dashboard/management', cookies.driver).expect(403);
      await get(`/dashboard/management?from=${d('03-31')}&to=${d('03-01')}`, cookies.opsPts).expect(
        400,
      );
      const jedView = await report<BranchDashboardDto>('/dashboard/branch', cookies.opsJed);
      expect(jedView.branch.id).toBe(jed);
      expect(jedView.todayShipments?.inbound.map((x) => x.shipmentId)).not.toContain(s.s5);
    });
  });
});
