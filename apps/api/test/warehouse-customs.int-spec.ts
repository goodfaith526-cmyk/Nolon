import type {
  BookingDto,
  CustomerDto,
  ShipmentCustomsDto,
  ShipmentDocumentDto,
  ShipmentDto,
  ShipmentWarehouseDto,
  WarehouseDto,
  WarehouseMovementDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/auth-user.js';
import { todayIn } from '../src/common/dates.js';
import { CustomsService } from '../src/customs/customs.service.js';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { AGENT_PREFIX, registerClient, tokenFor } from './agent-drafts-helpers.js';
import { deleteCommercialTestData, uniquePhone, waitForLockWaiter } from './test-data.js';
import { Access } from '../src/access-control/access.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

describe('warehouse and customs', () => {
  let t: TestApp;
  let dxb: string;
  let pts: string;
  let jebelAli: string;
  let portSudan: string;
  let customer: CustomerDto;
  let dxbWarehouse: WarehouseDto;
  let ptsWarehouse: WarehouseDto;
  let warehouseUserId: string;
  let customsUserId: string;
  const cookies = {
    admin: '',
    opsDxb: '',
    salesDxb: '',
    managerDxb: '',
    warehouseDxb: '',
    warehouseJed: '',
    warehouseDxbPts: '',
    customsDxb: '',
    customsJed: '',
    driver: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const del = (path: string, cookie: string) =>
    t.http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);

  /** A confirmed sea booking of 10 general packages with the given services; its shipment. */
  async function confirmedShipment(services: string[]): Promise<ShipmentDto> {
    const booking = (
      await post('/bookings', cookies.opsDxb, {
        customerId: customer.id,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'GENERAL',
        services,
        items: [
          { cargoType: 'GENERAL', quantity: 6, weightKg: '600' },
          { cargoType: 'GENERAL', quantity: 4, weightKg: '400' },
        ],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsDxb).expect(200))
      .body as BookingDto;
    return (await get(`/shipments/${confirmed.shipmentId}`, cookies.opsDxb).expect(200))
      .body as ShipmentDto;
  }

  const view = async (id: string, cookie = cookies.warehouseDxb) =>
    (await get(`/shipments/${id}/warehouse`, cookie).expect(200)).body as ShipmentWarehouseDto;
  const receive = (id: string, cookie: string, body: object) =>
    post(`/shipments/${id}/warehouse/receipts`, cookie, {
      warehouseId: dxbWarehouse.id,
      condition: 'GOOD',
      ...body,
    });
  const release = (id: string, cookie: string, body: object) =>
    post(`/shipments/${id}/warehouse/releases`, cookie, { warehouseId: dxbWarehouse.id, ...body });
  const status = async (id: string) =>
    (await t.prisma.shipment.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jebelAli = await loc('AEJEA');
    portSudan = await loc('SDPZU');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR']),
      opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
      salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
      managerDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
      warehouseDxb: await createUser(t.prisma, ['WAREHOUSE'], ['DXB']),
      warehouseJed: await createUser(t.prisma, ['WAREHOUSE'], ['JED']),
      warehouseDxbPts: await createUser(t.prisma, ['WAREHOUSE'], ['DXB', 'PTS']),
      customsDxb: await createUser(t.prisma, ['CUSTOMS'], ['DXB']),
      customsJed: await createUser(t.prisma, ['CUSTOMS'], ['JED']),
      driver: await createUser(t.prisma, ['DRIVER'], ['DXB']),
    };
    warehouseUserId = users.warehouseDxb.id;
    customsUserId = users.customsDxb.id;
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const created = (
      await post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Warehouse Test Trading',
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;
    customer = (await get(`/customers/${created.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDto;
    dxbWarehouse = (
      await post('/warehouses', cookies.warehouseDxb, {
        branchId: dxb,
        code: 'zz-dxb-1',
        nameEn: 'Jebel Ali store',
        nameAr: 'مستودع جبل علي',
      }).expect(201)
    ).body as WarehouseDto;
    ptsWarehouse = (
      await post('/warehouses', cookies.admin, {
        branchId: pts,
        code: 'ZZ-PTS-1',
        nameEn: 'Port Sudan store',
        nameAr: 'مستودع بورتسودان',
      }).expect(201)
    ).body as WarehouseDto;
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('warehouses master', () => {
    it('a branch manages its own warehouses and storage locations only', async () => {
      expect(dxbWarehouse).toMatchObject({ code: 'ZZ-DXB-1', branchId: dxb, isActive: true });
      await post('/warehouses', cookies.warehouseDxb, {
        branchId: pts,
        code: 'ZZ-X',
        nameEn: 'x',
        nameAr: 'x',
      }).expect(403);
      await post('/warehouses', cookies.salesDxb, {
        branchId: dxb,
        code: 'ZZ-Y',
        nameEn: 'y',
        nameAr: 'y',
      }).expect(403);
      await post('/warehouses', cookies.admin, {
        branchId: dxb,
        code: 'ZZ-DXB-1',
        nameEn: 'dup',
        nameAr: 'dup',
      }).expect(409);

      const withLocation = (
        await post(`/warehouses/${dxbWarehouse.id}/locations`, cookies.warehouseDxb, {
          code: 'a-01',
          name: 'Row A',
        }).expect(201)
      ).body as WarehouseDto;
      expect(withLocation.storageLocations).toMatchObject([{ code: 'A-01', name: 'Row A' }]);
      await post(`/warehouses/${dxbWarehouse.id}/locations`, cookies.warehouseDxb, {
        code: 'A-01',
      }).expect(409);
      dxbWarehouse = withLocation;

      const dxbList = (await get('/warehouses', cookies.warehouseDxb).expect(200))
        .body as WarehouseDto[];
      expect(dxbList.map((w) => w.id)).toContain(dxbWarehouse.id);
      expect(dxbList.map((w) => w.id)).not.toContain(ptsWarehouse.id);
      const jedList = (await get('/warehouses', cookies.warehouseJed).expect(200))
        .body as WarehouseDto[];
      expect(jedList.map((w) => w.id)).not.toContain(dxbWarehouse.id);
      await patch(`/warehouses/${dxbWarehouse.id}`, cookies.warehouseJed, {
        nameEn: 'x',
      }).expect(404);
      await post(`/warehouses/${dxbWarehouse.id}/locations`, cookies.warehouseJed, {
        code: 'B',
      }).expect(404);
      await get('/warehouses', cookies.driver).expect(403);
      const renamed = (
        await patch(`/warehouses/${dxbWarehouse.id}`, cookies.warehouseDxb, {
          nameEn: 'Jebel Ali main store',
        }).expect(200)
      ).body as WarehouseDto;
      expect(renamed.nameEn).toBe('Jebel Ali main store');
    });
  });

  describe('goods receipt and release', () => {
    it('partial receipts and releases keep what is held; GRN numbers run in sequence', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const empty = await view(s.id);
      expect(empty).toMatchObject({ expectedPackages: 10, balances: [], movements: [] });
      expect(empty.actions).toMatchObject({
        canReceive: true,
        canRelease: false,
        receiptStatuses: [],
        defaultReceiptStatus: null,
      });

      const first = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 6,
          weightKg: '600.5',
          condition: 'DAMAGED',
          storageLocationId: dxbWarehouse.storageLocations[0]?.id,
          partyName: 'Truck 42',
          note: 'Two cartons wet',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(first).toMatchObject({
        kind: 'RECEIPT',
        packages: 6,
        weightKg: '600.5',
        condition: 'DAMAGED',
        storageLocationCode: 'A-01',
        warehouseCode: 'ZZ-DXB-1',
        statusApplied: null,
        createdByName: 'Integration Test',
      });
      expect(first.number).toMatch(/^NOL-GRN-\d{4}-\d{6}$/);
      const second = (await receive(s.id, cookies.warehouseDxb, { packages: 4 }).expect(201))
        .body as WarehouseMovementDto;
      const serial = (n: string) => Number(n.slice(-6));
      expect(second.number.slice(0, 13)).toBe(first.number.slice(0, 13));
      expect(serial(second.number)).toBe(serial(first.number) + 1);

      const out = (
        await release(s.id, cookies.warehouseDxb, {
          packages: 3,
          partyName: 'Consignee driver',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(out).toMatchObject({ kind: 'RELEASE', packages: 3, condition: null });
      expect(out.number).toMatch(/^NOL-GRL-\d{4}-\d{6}$/);

      const after = await view(s.id);
      expect(after.balances).toEqual([
        {
          warehouseId: dxbWarehouse.id,
          warehouseCode: 'ZZ-DXB-1',
          nameEn: 'Jebel Ali main store',
          nameAr: 'مستودع جبل علي',
          receivedPackages: 10,
          releasedPackages: 3,
          onHandPackages: 7,
          receivedWeightKg: '600.5',
          releasedWeightKg: '0',
          // The second receipt was not weighed: what is left is not known.
          remainingWeightKg: null,
        },
      ]);
      expect(after.movements.map((m) => m.number)).toEqual([
        first.number,
        second.number,
        out.number,
      ]);
      expect(after.actions.canRelease).toBe(true);
    });

    it('refuses holding more packages than the cargo lines unless confirmed with a reason', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      await receive(s.id, cookies.warehouseDxb, { packages: 6 }).expect(201);
      let v = await view(s.id);
      expect(v).toMatchObject({ expectedPackages: 10, heldPackages: 6, remainingPackages: 4 });
      await receive(s.id, cookies.warehouseDxb, { packages: 5 }).expect(409);
      await receive(s.id, cookies.warehouseDxb, { packages: 4 }).expect(201);
      await receive(s.id, cookies.warehouseDxb, { packages: 1 }).expect(409);
      await receive(s.id, cookies.warehouseDxb, {
        packages: 1,
        extraPackagesConfirmed: true,
      }).expect(400);
      const extra = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 1,
          extraPackagesConfirmed: true,
          note: 'Booked 10, the truck brought 11',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(extra.note).toBe('Booked 10, the truck brought 11');
      v = await view(s.id);
      expect(v).toMatchObject({ heldPackages: 11, remainingPackages: 0 });
      // Released goods are no longer held: the next warehouse may receive them again.
      await release(s.id, cookies.warehouseDxb, { packages: 11 }).expect(201);
      v = await view(s.id);
      expect(v).toMatchObject({ heldPackages: 0, remainingPackages: 10 });
      await receive(s.id, cookies.warehouseDxbPts, {
        warehouseId: ptsWarehouse.id,
        packages: 10,
      }).expect(201);
    });

    it("suggests a full release's weight from what each warehouse weighed in and out (D5)", async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const remaining = async () =>
        Object.fromEntries(
          (await view(s.id)).balances.map((b) => [b.warehouseCode, b.remainingWeightKg]),
        );
      // Two warehouses, both weighed in: each keeps its own weight, not the booking's 1000 kg.
      await receive(s.id, cookies.warehouseDxbPts, { packages: 6, weightKg: '620' }).expect(201);
      await receive(s.id, cookies.warehouseDxbPts, {
        warehouseId: ptsWarehouse.id,
        packages: 4,
        weightKg: '390.5',
      }).expect(201);
      expect(await remaining()).toEqual({ 'ZZ-DXB-1': '620', 'ZZ-PTS-1': '390.5' });
      // Two partial releases with their weights: the rest is what was weighed out.
      await release(s.id, cookies.warehouseDxbPts, { packages: 1, weightKg: '100' }).expect(201);
      await release(s.id, cookies.warehouseDxbPts, { packages: 2, weightKg: '200.25' }).expect(201);
      expect(await remaining()).toEqual({ 'ZZ-DXB-1': '319.75', 'ZZ-PTS-1': '390.5' });
      // A partial release without a weight makes that warehouse's rest unknown, not the other's.
      await release(s.id, cookies.warehouseDxbPts, {
        warehouseId: ptsWarehouse.id,
        packages: 1,
      }).expect(201);
      expect(await remaining()).toEqual({ 'ZZ-DXB-1': '319.75', 'ZZ-PTS-1': null });
      // Everything released: nothing left to suggest.
      await release(s.id, cookies.warehouseDxbPts, { packages: 3, weightKg: '319.75' }).expect(201);
      expect((await remaining())['ZZ-DXB-1']).toBeNull();
    });

    it('checks a backdated receipt against what the warehouses held from its date on', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
      await receive(s.id, cookies.warehouseDxb, { packages: 6, occurredAt: hoursAgo(3) }).expect(
        201,
      );
      await release(s.id, cookies.warehouseDxb, { packages: 6, occurredAt: hoursAgo(1) }).expect(
        201,
      );
      expect(await view(s.id)).toMatchObject({ heldPackages: 0 });
      // Dated between the receipt and the release, 6 more would have held 12 of 10 meanwhile.
      await receive(s.id, cookies.warehouseDxb, { packages: 6, occurredAt: hoursAgo(2) }).expect(
        409,
      );
      // After the release they fit.
      await receive(s.id, cookies.warehouseDxb, {
        packages: 6,
        occurredAt: hoursAgo(0.5),
      }).expect(201);
    });

    it('cannot release more than is received and not yet released (409)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      await release(s.id, cookies.warehouseDxb, { packages: 1 }).expect(409);
      await receive(s.id, cookies.warehouseDxb, { packages: 5 }).expect(201);
      await release(s.id, cookies.warehouseDxb, { packages: 6 }).expect(409);
      await release(s.id, cookies.warehouseDxb, { packages: 2 }).expect(201);
      await release(s.id, cookies.warehouseDxb, { packages: 4 }).expect(409);
      await release(s.id, cookies.warehouseDxb, { packages: 3 }).expect(201);
      await release(s.id, cookies.warehouseDxb, { packages: 1 }).expect(409);
      // Goods held in one warehouse do not leave from another.
      await receive(s.id, cookies.warehouseDxbPts, { packages: 2 }).expect(201);
      await release(s.id, cookies.warehouseDxbPts, {
        warehouseId: ptsWarehouse.id,
        packages: 1,
      }).expect(409);
      const v = await view(s.id);
      expect(v.balances[0]).toMatchObject({ receivedPackages: 7, onHandPackages: 2 });
      await release(s.id, cookies.warehouseDxb, { packages: 0 }).expect(400);
      await release(s.id, cookies.warehouseDxb, { packages: 1.5 }).expect(400);
      await receive(s.id, cookies.warehouseDxb, { packages: -1 }).expect(400);
      await receive(s.id, cookies.warehouseDxb, { packages: 1, weightKg: '-5' }).expect(400);
      await receive(s.id, cookies.warehouseDxb, { packages: 1, condition: undefined }).expect(400);
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await receive(s.id, cookies.warehouseDxb, { packages: 1, occurredAt: future }).expect(400);
    });

    it('a release waiting on a concurrent release sees it and is refused', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      await receive(s.id, cookies.warehouseDxb, { packages: 5 }).expect(201);
      // Another release of all 5 holds the shipment lock while this request arrives.
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        await tx.warehouseMovement.create({
          data: {
            number: `NOL-GRL-TEST-${s.number.slice(-6)}`,
            kind: 'RELEASE',
            branchId: dxb,
            shipmentId: s.id,
            warehouseId: dxbWarehouse.id,
            packages: 5,
            occurredAt: new Date(),
            createdById: warehouseUserId,
          },
        });
        const request = release(s.id, cookies.warehouseDxb, { packages: 5 }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(409);
      const released = await t.prisma.warehouseMovement.aggregate({
        where: { shipmentId: s.id, kind: 'RELEASE' },
        _sum: { packages: true },
      });
      expect(released._sum.packages).toBe(5);
    });

    it('two releases at once: one takes the goods, the other is refused', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      await receive(s.id, cookies.warehouseDxb, { packages: 4 }).expect(201);
      const results = await Promise.all([
        release(s.id, cookies.warehouseDxb, { packages: 3 }),
        release(s.id, cookies.warehouseDxb, { packages: 3 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect((await view(s.id)).balances[0]?.onHandPackages).toBe(1);
    });

    it('a shipment with goods in a warehouse does not close until they are released (B1-5)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      await receive(s.id, cookies.warehouseDxb, { packages: 4 }).expect(201);
      for (const next of ['LOADED', 'DEPARTED', 'ARRIVED_PORT', 'DELIVERED']) {
        await post(`/shipments/${s.id}/status`, cookies.opsDxb, { status: next }).expect(200);
      }
      const delivered = (await get(`/shipments/${s.id}`, cookies.opsDxb).expect(200))
        .body as ShipmentDto;
      expect(delivered.actions.closeCheck).toEqual({
        goodsOnHand: [{ warehouseCode: 'ZZ-DXB-1', packages: 4 }],
        invoiced: false,
      });
      const close = () =>
        post(`/shipments/${s.id}/status`, cookies.opsDxb, {
          status: 'CLOSED',
          noChargeReason: 'Test shipment',
        });
      const refused = await close().expect(409);
      expect(refused.body).toMatchObject({
        code: 'SHIPMENT_CLOSE_GOODS_ON_HAND',
        params: { shipment: s.number, warehouses: 'ZZ-DXB-1 (4)' },
      });
      await release(s.id, cookies.warehouseDxb, { packages: 3 }).expect(201);
      await close().expect(409);
      await release(s.id, cookies.warehouseDxb, { packages: 1 }).expect(201);
      await close().expect(200);
      expect(await status(s.id)).toBe('CLOSED');
    });

    it('a closed or cancelled shipment takes no receipt (409); a cancelled one can return goods', async () => {
      const closed = await confirmedShipment(['MAIN_FREIGHT']);
      for (const next of ['LOADED', 'DEPARTED', 'ARRIVED_PORT', 'DELIVERED']) {
        await post(`/shipments/${closed.id}/status`, cookies.opsDxb, { status: next }).expect(200);
      }
      await post(`/shipments/${closed.id}/status`, cookies.opsDxb, {
        status: 'CLOSED',
        noChargeReason: 'Test shipment',
      }).expect(200);
      await receive(closed.id, cookies.warehouseDxb, { packages: 1 }).expect(409);
      await release(closed.id, cookies.warehouseDxb, { packages: 1 }).expect(409);

      const cancelled = await confirmedShipment(['MAIN_FREIGHT']);
      await receive(cancelled.id, cookies.warehouseDxb, { packages: 3 }).expect(201);
      await post(`/shipments/${cancelled.id}/cancel`, cookies.opsDxb, {
        reason: 'Customer withdrew',
      }).expect(200);
      await receive(cancelled.id, cookies.warehouseDxb, { packages: 1 }).expect(409);
      const v = await view(cancelled.id);
      expect(v.actions).toMatchObject({ canReceive: false, canRelease: true });
      await release(cancelled.id, cookies.warehouseDxb, { packages: 3 }).expect(201);
    });

    it('a backdated release cannot take goods received after its date (409)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      await receive(s.id, cookies.warehouseDxb, { packages: 5, occurredAt: daysAgo(3) }).expect(
        201,
      );
      await receive(s.id, cookies.warehouseDxb, { packages: 5, occurredAt: daysAgo(1) }).expect(
        201,
      );
      // Ten are held today, but only five were there two days ago.
      await release(s.id, cookies.warehouseDxb, { packages: 6, occurredAt: daysAgo(2) }).expect(
        409,
      );
      await release(s.id, cookies.warehouseDxb, { packages: 10, occurredAt: daysAgo(4) }).expect(
        409,
      );
      await release(s.id, cookies.warehouseDxb, { packages: 5, occurredAt: daysAgo(2) }).expect(
        201,
      );
      // Those five are gone from day 2 on, so a release dated before them finds nothing left.
      await release(s.id, cookies.warehouseDxb, {
        packages: 1,
        occurredAt: daysAgo(2.5),
      }).expect(409);
      await release(s.id, cookies.warehouseDxb, { packages: 5 }).expect(201);
      expect((await view(s.id)).balances[0]?.onHandPackages).toBe(0);
    });

    it('a receipt waiting on a warehouse or location being deactivated is refused', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const closing = (
        await post('/warehouses', cookies.warehouseDxb, {
          branchId: dxb,
          code: 'ZZ-DXB-CLOSING',
          nameEn: 'Closing store',
          nameAr: 'مستودع يُغلق',
        }).expect(201)
      ).body as WarehouseDto;
      const withShelf = (
        await post(`/warehouses/${closing.id}/locations`, cookies.warehouseDxb, {
          code: 'A1',
        }).expect(201)
      ).body as WarehouseDto;
      const shelf = withShelf.storageLocations[0];
      if (!shelf) throw new Error('Location not created');

      // The location is deactivated and committed while the receipt waits on its row.
      const first = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "storage_locations" SET "is_active" = false WHERE "id" = ${shelf.id}::uuid`;
        const request = receive(s.id, cookies.warehouseDxb, {
          warehouseId: closing.id,
          storageLocationId: shelf.id,
          packages: 1,
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await first.pending).toBe(400);

      // Then the warehouse itself.
      const second = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "warehouses" SET "is_active" = false WHERE "id" = ${closing.id}::uuid`;
        const request = receive(s.id, cookies.warehouseDxb, {
          warehouseId: closing.id,
          packages: 1,
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await second.pending).toBe(400);
      expect(await t.prisma.warehouseMovement.count({ where: { shipmentId: s.id } })).toBe(0);
    });

    it('a receipt waiting on a concurrent cancel sees it and is refused', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        await tx.shipment.update({
          where: { id: s.id },
          data: { status: 'CANCELLED', cancelReason: 'x', cancelledAt: new Date() },
        });
        const request = receive(s.id, cookies.warehouseDxb, { packages: 1 }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(409);
      expect(await t.prisma.warehouseMovement.count({ where: { shipmentId: s.id } })).toBe(0);
    });
  });

  describe('shipment status through the state machine', () => {
    it('the first receipt moves the shipment to RECEIVED_ORIGIN_WAREHOUSE when allowed', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      const before = await view(s.id);
      expect(before.actions.receiptStatuses).toEqual(['RECEIVED_ORIGIN_WAREHOUSE']);
      expect(before.actions.defaultReceiptStatus).toBe('RECEIVED_ORIGIN_WAREHOUSE');

      // Not allowed now (destination side before the sea leg): recorded, status unchanged.
      const early = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 2,
          shipmentStatus: 'RECEIVED_DESTINATION_WAREHOUSE',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(early.statusApplied).toBeNull();
      expect(await status(s.id)).toBe('CREATED');

      const first = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 4,
          shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(first.statusApplied).toBe('RECEIVED_ORIGIN_WAREHOUSE');
      const moved = (await get(`/shipments/${s.id}`, cookies.opsDxb).expect(200))
        .body as ShipmentDto;
      expect(moved.status).toBe('RECEIVED_ORIGIN_WAREHOUSE');
      expect(moved.events.at(-1)).toMatchObject({
        kind: 'STATUS',
        status: 'RECEIVED_ORIGIN_WAREHOUSE',
        fromStatus: 'CREATED',
        note: first.number,
      });

      // The move is no longer available: a later receipt only records the goods.
      const later = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 4,
          shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(later.statusApplied).toBeNull();
      expect((await view(s.id)).actions.receiptStatuses).toEqual([]);
      expect(await t.prisma.shipmentEvent.count({ where: { shipmentId: s.id } })).toBe(2);
    });

    it('B2: the status a receipt applied is not undone from the shipment page', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      const grn = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 4,
          shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
        }).expect(201)
      ).body as WarehouseMovementDto;
      const refused = await post(`/shipments/${s.id}/revert`, cookies.admin, {
        reason: 'Entered by mistake',
        undoEventId: (
          (await get(`/shipments/${s.id}`, cookies.admin).expect(200)).body as ShipmentDto
        ).actions.revertUndoes?.eventId,
      }).expect(409);
      expect(refused.body).toMatchObject({
        code: 'REVERT_BY_WAREHOUSE',
        params: { record: grn.number },
      });
      expect(await status(s.id)).toBe('RECEIVED_ORIGIN_WAREHOUSE');
    });

    it("a receipt that moves the shipment records it at the warehouse's place (D9)", async () => {
      const placed = (
        await post('/warehouses', cookies.warehouseDxb, {
          branchId: dxb,
          code: 'ZZ-DXB-D9',
          nameEn: 'Placed store',
          nameAr: 'مستودع بموقع',
          locationId: portSudan,
        }).expect(201)
      ).body as WarehouseDto;
      expect(placed.locationId).toBe(portSudan);

      const s = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      const before = await t.prisma.shipment.findUniqueOrThrow({ where: { id: s.id } });
      expect(before.currentLocationId).not.toBe(portSudan);
      // A receipt that moves nothing leaves the shipment where it was.
      await receive(s.id, cookies.warehouseDxb, { warehouseId: placed.id, packages: 1 }).expect(
        201,
      );
      expect(
        (await t.prisma.shipment.findUniqueOrThrow({ where: { id: s.id } })).currentLocationId,
      ).toBe(before.currentLocationId);
      await receive(s.id, cookies.warehouseDxb, {
        warehouseId: placed.id,
        packages: 2,
        shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
      }).expect(201);
      const moved = await t.prisma.shipment.findUniqueOrThrow({
        where: { id: s.id },
        include: { events: { orderBy: { id: 'desc' }, take: 1 } },
      });
      expect(moved.currentLocationId).toBe(portSudan);
      expect(moved.events[0]).toMatchObject({
        status: 'RECEIVED_ORIGIN_WAREHOUSE',
        locationId: portSudan,
      });

      // A warehouse without a place moves the shipment and leaves its location as it was.
      const other = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      const otherBefore = await t.prisma.shipment.findUniqueOrThrow({ where: { id: other.id } });
      await receive(other.id, cookies.warehouseDxb, {
        packages: 2,
        shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
      }).expect(201);
      const otherAfter = await t.prisma.shipment.findUniqueOrThrow({
        where: { id: other.id },
        include: { events: { orderBy: { id: 'desc' }, take: 1 } },
      });
      expect(otherAfter.status).toBe('RECEIVED_ORIGIN_WAREHOUSE');
      expect(otherAfter.currentLocationId).toBe(otherBefore.currentLocationId);
      expect(otherAfter.events[0]?.locationId).toBeNull();
    });

    it("a warehouse's place is an active location; it can be changed and cleared (D9)", async () => {
      const inactive = await t.prisma.location.create({
        data: {
          code: `ZQ${String(Date.now()).slice(-6)}`,
          kind: 'OTHER',
          nameEn: 'Closed yard',
          nameAr: 'ساحة مغلقة',
          countryCode: 'AE',
          isActive: false,
        },
      });
      try {
        const body = { branchId: dxb, code: 'ZZ-DXB-D9B', nameEn: 'b', nameAr: 'ب' };
        await post('/warehouses', cookies.warehouseDxb, {
          ...body,
          locationId: inactive.id,
        }).expect(400);
        await post('/warehouses', cookies.warehouseDxb, {
          ...body,
          locationId: '00000000-0000-4000-8000-000000000000',
        }).expect(400);
        const w = (await post('/warehouses', cookies.warehouseDxb, body).expect(201))
          .body as WarehouseDto;
        expect(w.locationId).toBeNull();
        await patch(`/warehouses/${w.id}`, cookies.warehouseDxb, {
          locationId: inactive.id,
        }).expect(400);
        const set = (
          await patch(`/warehouses/${w.id}`, cookies.warehouseDxb, {
            locationId: portSudan,
          }).expect(200)
        ).body as WarehouseDto;
        expect(set.locationId).toBe(portSudan);
        const renamed = (
          await patch(`/warehouses/${w.id}`, cookies.warehouseDxb, { nameEn: 'bb' }).expect(200)
        ).body as WarehouseDto;
        expect(renamed.locationId).toBe(portSudan);
        const cleared = (
          await patch(`/warehouses/${w.id}`, cookies.warehouseDxb, { locationId: null }).expect(200)
        ).body as WarehouseDto;
        expect(cleared.locationId).toBeNull();
        // Another branch's user cannot set it.
        await patch(`/warehouses/${w.id}`, cookies.warehouseJed, {
          locationId: portSudan,
        }).expect(404);
      } finally {
        await t.prisma.location.delete({ where: { id: inactive.id } });
      }
    });

    it('without the warehouse service the receipt never moves the shipment', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const r = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 1,
          shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(r.statusApplied).toBeNull();
      expect(await status(s.id)).toBe('CREATED');
    });

    it('storage only: both sides are allowed, none is preselected, the receipt says which', async () => {
      // Every new booking carries the main freight (owner, 2026-10-19); a storage-only shipment
      // is one booked before that.
      const s = await confirmedShipment(['WAREHOUSE']);
      expect([...s.services].sort()).toEqual(['MAIN_FREIGHT', 'WAREHOUSE']);
      await t.prisma.shipment.update({ where: { id: s.id }, data: { services: ['WAREHOUSE'] } });
      const v = await view(s.id);
      expect(v.actions.receiptStatuses).toEqual([
        'RECEIVED_ORIGIN_WAREHOUSE',
        'RECEIVED_DESTINATION_WAREHOUSE',
      ]);
      expect(v.actions.defaultReceiptStatus).toBeNull();
      const r = (
        await receive(s.id, cookies.warehouseDxb, {
          packages: 10,
          shipmentStatus: 'RECEIVED_DESTINATION_WAREHOUSE',
        }).expect(201)
      ).body as WarehouseMovementDto;
      expect(r.statusApplied).toBe('RECEIVED_DESTINATION_WAREHOUSE');
      expect(await status(s.id)).toBe('RECEIVED_DESTINATION_WAREHOUSE');
    });

    it('an invalid storage location records nothing and moves nothing', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      await receive(s.id, cookies.warehouseDxb, {
        packages: 1,
        storageLocationId: '00000000-0000-4000-8000-000000000000',
        shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
      }).expect(400);
      expect(await status(s.id)).toBe('CREATED');
      expect(await t.prisma.warehouseMovement.count({ where: { shipmentId: s.id } })).toBe(0);
    });
  });

  describe('B3-1: cancelling a receipt or release', () => {
    const cancel = (
      id: string,
      movementId: string,
      cookie: string,
      reason = 'Recorded by mistake',
    ) => post(`/shipments/${id}/warehouse/movements/${movementId}/cancel`, cookie, { reason });
    const movement = async (id: string, cookie: string, path: string, body: object) =>
      (await post(`/shipments/${id}/warehouse/${path}`, cookie, body).expect(201))
        .body as WarehouseMovementDto;

    it('a receipt nothing was released from is cancelled: kept, marked, and counted nowhere', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const kept = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 4,
      });
      const wrong = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 6,
      });
      expect((await view(s.id)).actions.canCancelMovements).toBe(true);
      const done = (await cancel(s.id, wrong.id, cookies.warehouseDxb).expect(201))
        .body as WarehouseMovementDto;
      expect(done.cancellation).toMatchObject({
        reason: 'Recorded by mistake',
        cancelledByName: 'Integration Test',
      });
      const after = await view(s.id);
      expect(after).toMatchObject({ heldPackages: 4, remainingPackages: 6 });
      expect(after.balances[0]).toMatchObject({ receivedPackages: 4, onHandPackages: 4 });
      expect(after.movements.map((m) => [m.number, m.cancellation?.reason ?? null])).toEqual([
        [kept.number, null],
        [wrong.number, 'Recorded by mistake'],
      ]);
      // The 6 can be received again: the cancelled receipt holds nothing.
      await receive(s.id, cookies.warehouseDxb, { packages: 6 }).expect(201);

      // The same cancel again changes nothing; another reason is refused.
      await cancel(s.id, wrong.id, cookies.warehouseDxb).expect(201);
      const other = await cancel(s.id, wrong.id, cookies.warehouseDxb, 'Another reason').expect(
        409,
      );
      expect(other.body).toMatchObject({
        code: 'CORRECTION_ALREADY_DONE',
        params: { record: wrong.number },
      });
      expect(
        await t.prisma.warehouseMovementCancellation.count({ where: { movementId: wrong.id } }),
      ).toBe(1);

      // Reports leave it out; the audit log keeps the receipt and shows its cancel.
      const day = (offset: number) =>
        new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const report = (
        await get(
          `/reports/warehouse-movements?from=${day(-1)}&to=${day(1)}&branchId=${dxb}`,
          cookies.managerDxb,
        ).expect(200)
      ).body as { movements: { number: string }[] };
      const numbers = report.movements.map((m) => m.number);
      expect(numbers).toContain(kept.number);
      expect(numbers).not.toContain(wrong.number);
      const onHand = (
        await get(`/reports/warehouse-on-hand?branchId=${dxb}`, cookies.managerDxb).expect(200)
      ).body as { rows: { shipmentId: string; packages: number }[] };
      expect(onHand.rows.find((r) => r.shipmentId === s.id)?.packages).toBe(10);
      const audit = (
        await get(
          `/reports/audit-log?from=${day(-1)}&to=${day(1)}&branchId=${dxb}`,
          cookies.managerDxb,
        ).expect(200)
      ).body as { entries: { reference: string; action: string; detail: string | null }[] };
      expect(
        audit.entries
          .filter((e) => e.reference === wrong.number)
          .map((e) => [e.action, e.detail])
          .sort(),
      ).toEqual([
        ['CANCELLED', 'Recorded by mistake'],
        ['RECEIVED', null],
      ]);

      // The cancellation is insert-only.
      await expect(
        t.prisma.warehouseMovementCancellation.update({
          where: { movementId: wrong.id },
          data: { reason: 'Changed' },
        }),
      ).rejects.toThrow(/cannot be changed or deleted/);
      await expect(
        t.prisma.warehouseMovementCancellation.delete({ where: { movementId: wrong.id } }),
      ).rejects.toThrow(/cannot be changed or deleted/);
    });

    it('a receipt a release took goods from stays until the release is cancelled', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const grn = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 10,
      });
      const out = await movement(s.id, cookies.warehouseDxb, 'releases', {
        warehouseId: dxbWarehouse.id,
        packages: 4,
      });
      const refused = await cancel(s.id, grn.id, cookies.warehouseDxb).expect(409);
      expect(refused.body).toMatchObject({
        code: 'MOVEMENT_CANCEL_NEGATIVE',
        params: { movement: grn.number, warehouse: 'ZZ-DXB-1' },
      });
      await cancel(s.id, out.id, cookies.warehouseDxb).expect(201);
      await cancel(s.id, grn.id, cookies.warehouseDxb).expect(201);
      expect(await view(s.id)).toMatchObject({ heldPackages: 0, balances: [] });
    });

    it('a release cancel never holds the goods in two warehouses at once (F132-3)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const cookie = cookies.warehouseDxbPts;
      await movement(s.id, cookie, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 10,
      });
      const out = await movement(s.id, cookie, 'releases', {
        warehouseId: dxbWarehouse.id,
        packages: 10,
      });
      const there = await movement(s.id, cookie, 'receipts', {
        warehouseId: ptsWarehouse.id,
        condition: 'GOOD',
        packages: 10,
      });
      const refused = await cancel(s.id, out.id, cookie).expect(409);
      expect(refused.body).toMatchObject({
        code: 'MOVEMENT_CANCEL_OVER_PACKAGES',
        params: { movement: out.number, peak: '20', packages: '10' },
      });
      await cancel(s.id, there.id, cookie).expect(201);
      await cancel(s.id, out.id, cookie).expect(201);
      expect((await view(s.id, cookie)).heldPackages).toBe(10);
    });

    it('the status a receipt applied goes back while it is the current step', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      const grn = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 4,
        shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
      });
      expect(await status(s.id)).toBe('RECEIVED_ORIGIN_WAREHOUSE');
      await cancel(s.id, grn.id, cookies.warehouseDxb, 'Wrong shipment').expect(201);
      const back = (await get(`/shipments/${s.id}`, cookies.opsDxb).expect(200))
        .body as ShipmentDto;
      expect(back.status).toBe('CREATED');
      expect(back.events.at(-1)).toMatchObject({
        kind: 'REVERT',
        status: 'CREATED',
        fromStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
        reason: 'Wrong shipment',
        note: grn.number,
      });
      // The receipt's step is gone: a new receipt moves the shipment again.
      expect((await view(s.id)).actions.receiptStatuses).toEqual(['RECEIVED_ORIGIN_WAREHOUSE']);
    });

    it('a later step keeps the receipt (409) until it is undone', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      const grn = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 4,
        shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
      });
      await post(`/shipments/${s.id}/hold`, cookies.opsDxb, { reason: 'Customer asked' }).expect(
        200,
      );
      const refused = await cancel(s.id, grn.id, cookies.warehouseDxb).expect(409);
      expect(refused.body).toMatchObject({
        code: 'MOVEMENT_CANCEL_STATUS_MOVED',
        params: { movement: grn.number, status: 'RECEIVED_ORIGIN_WAREHOUSE' },
      });
      expect(await status(s.id)).toBe('ON_HOLD');
      expect(
        await t.prisma.warehouseMovementCancellation.count({ where: { movementId: grn.id } }),
      ).toBe(0);
      await post(`/shipments/${s.id}/resume`, cookies.opsDxb, {}).expect(200);
      await cancel(s.id, grn.id, cookies.warehouseDxb).expect(201);
      expect(await status(s.id)).toBe('CREATED');
    });

    it('a closed shipment keeps its movements (409)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const grn = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 4,
      });
      // Closing needs its own conditions; the guard under test is the cancel's.
      await t.prisma.shipment.update({
        where: { id: s.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      expect((await view(s.id)).actions.canCancelMovements).toBe(false);
      const refused = await cancel(s.id, grn.id, cookies.warehouseDxb).expect(409);
      expect(refused.body).toMatchObject({
        code: 'MOVEMENT_CANCEL_CLOSED',
        params: { movement: grn.number },
      });
    });

    it('needs warehouse:cancel in the branch, a reason, and the shipment in sight', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const grn = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 4,
      });
      expect((await view(s.id, cookies.salesDxb)).actions.canCancelMovements).toBe(false);
      await cancel(s.id, grn.id, cookies.salesDxb).expect(403);
      await cancel(s.id, grn.id, cookies.opsDxb).expect(403);
      await cancel(s.id, grn.id, cookies.warehouseJed).expect(404);
      await cancel(s.id, grn.id, cookies.warehouseDxb, 'x').expect(400);
      // Another shipment's movement id is not found under this shipment.
      const other = await confirmedShipment(['MAIN_FREIGHT']);
      await cancel(other.id, grn.id, cookies.warehouseDxb).expect(404);
      expect(
        await t.prisma.warehouseMovementCancellation.count({ where: { movementId: grn.id } }),
      ).toBe(0);
    });

    it("the assistant's warehouse read leaves cancelled movements out", async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const kept = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 4,
      });
      const wrong = await movement(s.id, cookies.warehouseDxb, 'receipts', {
        warehouseId: dxbWarehouse.id,
        condition: 'GOOD',
        packages: 6,
      });
      await cancel(s.id, wrong.id, cookies.warehouseDxb).expect(201);
      // Users acting through the assistant are never deleted (agent_access_events references them).
      const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX);
      const agentUser = await createUser(t.prisma, ['WAREHOUSE'], ['DXB'], AGENT_PREFIX);
      const client = await registerClient(t, await signIn(t, admin.email), 'B3-1 warehouse');
      const token = await tokenFor(t, await signIn(t, agentUser.email), client);
      const seen = (
        await t
          .http()
          .get(`/api/v1/shipments/${s.id}/warehouse`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as ShipmentWarehouseDto;
      expect(seen.movements.map((m) => m.number)).toEqual([kept.number]);
      expect(seen.heldPackages).toBe(4);
      expect(seen.actions.canCancelMovements).toBe(false);
    });
  });

  describe('branch scope and permissions', () => {
    it('another branch neither sees nor writes the shipment warehouse (404)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      await get(`/shipments/${s.id}/warehouse`, cookies.warehouseJed).expect(404);
      await post(`/shipments/${s.id}/warehouse/receipts`, cookies.warehouseJed, {
        warehouseId: dxbWarehouse.id,
        packages: 1,
        condition: 'GOOD',
      }).expect(404);
      await post(`/shipments/${s.id}/warehouse/releases`, cookies.warehouseJed, {
        warehouseId: dxbWarehouse.id,
        packages: 1,
      }).expect(404);
      // A warehouse of a branch the user does not have.
      await receive(s.id, cookies.warehouseDxb, {
        warehouseId: ptsWarehouse.id,
        packages: 1,
      }).expect(404);
      // A Driver sees no shipments yet: and has no warehouse access at all.
      await get(`/shipments/${s.id}/warehouse`, cookies.driver).expect(403);
    });

    it('view-only roles see the warehouse but cannot receive or release (403)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'WAREHOUSE']);
      const v = await view(s.id, cookies.salesDxb);
      expect(v.actions).toMatchObject({
        canReceive: false,
        canRelease: false,
        canAddPhotos: false,
        receiptStatuses: [],
      });
      await receive(s.id, cookies.salesDxb, { packages: 1 }).expect(403);
      await receive(s.id, cookies.customsDxb, { packages: 1 }).expect(403);
      await release(s.id, cookies.opsDxb, { packages: 1 }).expect(403);
      expect(await t.prisma.warehouseMovement.count({ where: { shipmentId: s.id } })).toBe(0);
    });

    it('photos are shipment documents linked to the receipt', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT']);
      const r = (await receive(s.id, cookies.warehouseDxb, { packages: 2 }).expect(201))
        .body as WarehouseMovementDto;
      const photo = (path: string, cookie: string, file: Buffer) =>
        t
          .http()
          .post(`/api/v1${path}`)
          .set('Origin', APP_ORIGIN)
          .set('Cookie', cookie)
          .field('fileName', 'carton.png')
          .attach('file', file, 'upload.bin');
      const path = `/shipments/${s.id}/warehouse/movements/${r.id}/photos`;
      const withPhoto = (await photo(path, cookies.warehouseDxb, PNG).expect(201))
        .body as WarehouseMovementDto;
      expect(withPhoto.photos).toHaveLength(1);
      expect(withPhoto.photos[0]?.fileName).toBe('carton.png');
      await photo(path, cookies.warehouseDxb, PDF).expect(400);
      await photo(path, cookies.salesDxb, PNG).expect(403);
      await photo(path, cookies.warehouseJed, PNG).expect(404);
      await photo(
        `/shipments/${s.id}/warehouse/movements/00000000-0000-4000-8000-000000000000/photos`,
        cookies.warehouseDxb,
        PNG,
      ).expect(404);
      const docs = (await get(`/shipments/${s.id}/documents`, cookies.warehouseDxb).expect(200))
        .body as ShipmentDocumentDto[];
      expect(docs).toMatchObject([{ typeCode: 'PHOTO', fileName: 'carton.png' }]);
      const file = await get(
        `/shipments/${s.id}/documents/${withPhoto.photos[0]?.documentId}/file`,
        cookies.warehouseDxb,
      ).expect(200);
      expect(file.headers['content-type']).toBe('image/png');
    });
  });

  describe('customs', () => {
    it('saves one customs file per shipment and records fees without posting', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      const empty = (await get(`/shipments/${s.id}/customs`, cookies.customsDxb).expect(200))
        .body as ShipmentCustomsDto;
      expect(empty).toMatchObject({
        clearance: null,
        fees: [],
        totals: [],
        actions: { canEdit: true, canAddFee: true, canRemoveFee: true },
      });
      const saved = (
        await put(`/shipments/${s.id}/customs`, cookies.customsDxb, {
          status: 'SUBMITTED',
          declarationNumber: 'PZU-2026-1234',
          brokerName: 'Red Sea Clearing',
          submittedOn: '2026-10-01',
          note: 'Original BL with broker',
        }).expect(200)
      ).body as ShipmentCustomsDto;
      expect(saved.clearance).toMatchObject({
        status: 'SUBMITTED',
        declarationNumber: 'PZU-2026-1234',
        submittedOn: '2026-10-01',
        clearedOn: null,
      });
      const cleared = (
        await put(`/shipments/${s.id}/customs`, cookies.customsDxb, {
          status: 'CLEARED',
          declarationNumber: 'PZU-2026-1234',
          submittedOn: '2026-10-01',
          clearedOn: '2026-10-03',
        }).expect(200)
      ).body as ShipmentCustomsDto;
      expect(cleared.clearance).toMatchObject({ status: 'CLEARED', brokerName: null });
      expect(await t.prisma.customsClearance.count({ where: { shipmentId: s.id } })).toBe(1);
      await put(`/shipments/${s.id}/customs`, cookies.customsDxb, {
        status: 'CLEARED',
        submittedOn: '2026-10-05',
        clearedOn: '2026-10-03',
      }).expect(400);
      await put(`/shipments/${s.id}/customs`, cookies.customsDxb, { status: 'CLEARED' }).expect(
        400,
      );

      const journalsBefore = await t.prisma.journalEntry.count();
      await post(`/shipments/${s.id}/customs/fees`, cookies.customsDxb, {
        description: 'Customs duty',
        amount: '1500000.50',
        currency: 'SDG',
      }).expect(201);
      const withFees = (
        await post(`/shipments/${s.id}/customs/fees`, cookies.customsDxb, {
          description: 'Port storage',
          amount: '120',
          currency: 'USD',
        }).expect(201)
      ).body as ShipmentCustomsDto;
      expect(withFees.fees.map((f) => [f.description, f.amount, f.currency])).toEqual([
        ['Customs duty', '1500000.5', 'SDG'],
        ['Port storage', '120', 'USD'],
      ]);
      expect(withFees.totals).toEqual([
        { currency: 'SDG', amount: '1500000.5' },
        { currency: 'USD', amount: '120' },
      ]);
      expect(await t.prisma.journalEntry.count()).toBe(journalsBefore);
      await post(`/shipments/${s.id}/customs/fees`, cookies.customsDxb, {
        description: 'x',
        amount: '0',
        currency: 'USD',
      }).expect(400);
      await post(`/shipments/${s.id}/customs/fees`, cookies.customsDxb, {
        description: 'x',
        amount: '1.005',
        currency: 'USD',
      }).expect(400);
      await post(`/shipments/${s.id}/customs/fees`, cookies.customsDxb, {
        description: 'x',
        amount: '1',
        currency: 'ZZZ',
      }).expect(400);
      const feeId = withFees.fees[1]?.id ?? '';
      const removed = (
        await del(`/shipments/${s.id}/customs/fees/${feeId}`, cookies.customsDxb).expect(200)
      ).body as ShipmentCustomsDto;
      expect(removed.fees).toHaveLength(1);
      await del(`/shipments/${s.id}/customs/fees/${feeId}`, cookies.customsDxb).expect(404);
    });

    it('customs follows the shipment branch and the customs permission', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      await get(`/shipments/${s.id}/customs`, cookies.customsJed).expect(404);
      await put(`/shipments/${s.id}/customs`, cookies.customsJed, { status: 'PENDING' }).expect(
        404,
      );
      await post(`/shipments/${s.id}/customs/fees`, cookies.customsJed, {
        description: 'x',
        amount: '1',
        currency: 'USD',
      }).expect(404);
      // The Warehouse role has no customs access; Operations views only.
      await get(`/shipments/${s.id}/customs`, cookies.warehouseDxb).expect(403);
      const ops = (await get(`/shipments/${s.id}/customs`, cookies.opsDxb).expect(200))
        .body as ShipmentCustomsDto;
      expect(ops.actions).toEqual({ canEdit: false, canAddFee: false, canRemoveFee: false });
      await put(`/shipments/${s.id}/customs`, cookies.opsDxb, { status: 'PENDING' }).expect(403);
      await post(`/shipments/${s.id}/customs/fees`, cookies.opsDxb, {
        description: 'x',
        amount: '1',
        currency: 'USD',
      }).expect(403);
      await put(`/shipments/${s.id}/customs`, cookies.managerDxb, { status: 'PENDING' }).expect(
        200,
      );
    });

    describe('saving the file moves the shipment (functional review D1)', () => {
      const today = () => todayIn('Asia/Dubai');
      const events = (id: string) =>
        t.prisma.shipmentEvent.findMany({ where: { shipmentId: id }, orderBy: { id: 'asc' } });
      const move = (id: string, to: string) =>
        post(`/shipments/${id}/status`, cookies.opsDxb, { status: to }).expect(200);
      /** A sea shipment with customs booked, arrived at the port. */
      async function atPort(): Promise<ShipmentDto> {
        const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
        for (const to of ['LOADED', 'DEPARTED', 'ARRIVED_PORT']) await move(s.id, to);
        return s;
      }
      const save = (id: string, body: object, cookie = cookies.customsDxb) =>
        put(`/shipments/${id}/customs`, cookie, body);

      it('a file in progress moves it once; a cleared file moves it to cleared once', async () => {
        const s = await atPort();
        await save(s.id, { status: 'PENDING' }).expect(200);
        expect(await status(s.id)).toBe('ARRIVED_PORT');
        await save(s.id, { status: 'SUBMITTED', declarationNumber: 'D-1' }).expect(200);
        expect(await status(s.id)).toBe('CUSTOMS_IN_PROGRESS');
        const inProgress = await events(s.id);
        expect(inProgress.at(-1)).toMatchObject({
          status: 'CUSTOMS_IN_PROGRESS',
          fromStatus: 'ARRIVED_PORT',
          userId: customsUserId,
          note: 'D-1',
        });
        // Inspection and held keep it in customs: no new event.
        await save(s.id, { status: 'INSPECTION' }).expect(200);
        await save(s.id, { status: 'HELD' }).expect(200);
        expect(await events(s.id)).toHaveLength(inProgress.length);

        await save(s.id, { status: 'CLEARED', clearedOn: today() }).expect(200);
        expect(await status(s.id)).toBe('CUSTOMS_CLEARED');
        const cleared = await events(s.id);
        expect(cleared).toHaveLength(inProgress.length + 1);
        // An already cleared file saved again (a note fixed) records no second event.
        await save(s.id, { status: 'CLEARED', clearedOn: today(), note: 'fixed' }).expect(200);
        expect(await events(s.id)).toHaveLength(cleared.length);
        // A file set back to in progress never moves the shipment backwards.
        await save(s.id, { status: 'SUBMITTED' }).expect(200);
        expect(await status(s.id)).toBe('CUSTOMS_CLEARED');
        expect(await events(s.id)).toHaveLength(cleared.length);
      });

      it('B2: a step the customs file stands for is not undone from the shipment page', async () => {
        const s = await atPort();
        const revert = async () =>
          post(`/shipments/${s.id}/revert`, cookies.admin, {
            reason: 'Entered by mistake',
            undoEventId: (
              (await get(`/shipments/${s.id}`, cookies.admin).expect(200)).body as ShipmentDto
            ).actions.revertUndoes?.eventId,
          });
        await save(s.id, { status: 'SUBMITTED', declarationNumber: 'D-B2' }).expect(200);
        const inProgress = await revert();
        expect(inProgress.status).toBe(409);
        expect(inProgress.body).toMatchObject({
          code: 'REVERT_BY_CUSTOMS',
          params: { record: 'D-B2' },
        });
        await save(s.id, { status: 'CLEARED', clearedOn: today() }).expect(200);
        expect((await revert()).status).toBe(409);
        // The file set back to in progress no longer stands for cleared: that step can go back.
        await save(s.id, { status: 'SUBMITTED' }).expect(200);
        expect((await revert()).status).toBe(200);
        expect(await status(s.id)).toBe('CUSTOMS_IN_PROGRESS');
        expect((await revert()).status).toBe(409);
      });

      it('a cleared file moves a shipment at the port through customs to cleared', async () => {
        const s = await atPort();
        const before = (await events(s.id)).length;
        await save(s.id, { status: 'CLEARED', clearedOn: today() }).expect(200);
        const after = await events(s.id);
        expect(after.slice(before).map((e) => e.status)).toEqual([
          'CUSTOMS_IN_PROGRESS',
          'CUSTOMS_CLEARED',
        ]);
        expect(await status(s.id)).toBe('CUSTOMS_CLEARED');
      });

      it('a past clearance date dates the event that day, never before the latest event', async () => {
        const s = await atPort();
        // Arrived today: a clearance dated yesterday would rewrite the timeline (409, nothing saved).
        const yesterday = new Date(Date.now() - 86_400_000);
        await save(s.id, { status: 'CLEARED', clearedOn: todayIn('Asia/Dubai', yesterday) }).expect(
          409,
        );
        expect(await t.prisma.customsClearance.count({ where: { shipmentId: s.id } })).toBe(0);
        expect(await status(s.id)).toBe('ARRIVED_PORT');
        // Backdate the port events: the clearance is then dated the end of yesterday (Dubai).
        await t.prisma.shipmentEvent.updateMany({
          where: { shipmentId: s.id },
          data: { occurredAt: new Date(Date.now() - 3 * 86_400_000) },
        });
        const day = todayIn('Asia/Dubai', yesterday);
        await save(s.id, { status: 'CLEARED', clearedOn: day }).expect(200);
        const last = (await events(s.id)).at(-1);
        expect(last?.status).toBe('CUSTOMS_CLEARED');
        expect(todayIn('Asia/Dubai', last?.occurredAt)).toBe(day);
        expect(last && todayIn('Asia/Dubai', new Date(last.occurredAt.getTime() + 1))).not.toBe(
          day,
        );
      });

      it('refuses a clearance date in the future (400)', async () => {
        const s = await atPort();
        const tomorrow = todayIn('Asia/Dubai', new Date(Date.now() + 86_400_000));
        await save(s.id, { status: 'CLEARED', clearedOn: tomorrow }).expect(400);
        expect(await status(s.id)).toBe('ARRIVED_PORT');
      });

      it('after a later stage the file is saved and the shipment stays where it is', async () => {
        const s = await atPort();
        await move(s.id, 'CUSTOMS_IN_PROGRESS');
        await move(s.id, 'CUSTOMS_CLEARED');
        await move(s.id, 'DELIVERED');
        const before = (await events(s.id)).length;
        await save(s.id, { status: 'SUBMITTED' }).expect(200);
        await save(s.id, { status: 'CLEARED', clearedOn: today() }).expect(200);
        expect(await status(s.id)).toBe('DELIVERED');
        expect(await events(s.id)).toHaveLength(before);
      });

      it('a shipment not yet at the port keeps its status; the file is saved', async () => {
        const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
        const before = (await events(s.id)).length;
        await save(s.id, { status: 'SUBMITTED' }).expect(200);
        expect(await status(s.id)).toBe('CREATED');
        expect(await events(s.id)).toHaveLength(before);
        expect((await get(`/shipments/${s.id}/customs`, cookies.customsDxb)).body).toMatchObject({
          clearance: { status: 'SUBMITTED' },
        });
      });

      it('without the permission for the move, nothing is saved (403)', async () => {
        const s = await atPort();
        const customs = t.app.get(CustomsService);
        const withoutMove: AuthUser = {
          id: customsUserId,
          email: 'x@test',
          fullName: 'x',
          preferredLocale: 'en',
          sessionId: 's',
          credentialStamp: 'c',
          roles: ['CUSTOMS'],
          access: Access.uniform(['customs:view'], [dxb]),
          allBranches: false,
          allowedBranchIds: [dxb],
        };
        await expect(
          customs.save(withoutMove, s.id, { status: 'SUBMITTED' }),
        ).rejects.toMatchObject({ status: 403 });
        expect(await t.prisma.customsClearance.count({ where: { shipmentId: s.id } })).toBe(0);
        expect(await status(s.id)).toBe('ARRIVED_PORT');
      });
    });

    it('a cancelled shipment keeps its customs file read-only (409)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      await put(`/shipments/${s.id}/customs`, cookies.customsDxb, { status: 'PENDING' }).expect(
        200,
      );
      await post(`/shipments/${s.id}/cancel`, cookies.opsDxb, { reason: 'Wrong entry' }).expect(
        200,
      );
      await put(`/shipments/${s.id}/customs`, cookies.customsDxb, { status: 'SUBMITTED' }).expect(
        409,
      );
      await post(`/shipments/${s.id}/customs/fees`, cookies.customsDxb, {
        description: 'x',
        amount: '1',
        currency: 'USD',
      }).expect(409);
      const v = (await get(`/shipments/${s.id}/customs`, cookies.customsDxb).expect(200))
        .body as ShipmentCustomsDto;
      expect(v.actions.canEdit).toBe(false);
    });
  });
});
