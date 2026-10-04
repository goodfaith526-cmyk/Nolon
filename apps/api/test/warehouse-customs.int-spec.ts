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
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, waitForLockWaiter } from './test-data.js';

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
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const created = (
      await post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Warehouse Test Trading',
        phone: '+971501110002',
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
        },
      ]);
      expect(after.movements.map((m) => m.number)).toEqual([
        first.number,
        second.number,
        out.number,
      ]);
      expect(after.actions.canRelease).toBe(true);
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

    it('a closed or cancelled shipment takes no receipt (409); a cancelled one can return goods', async () => {
      const closed = await confirmedShipment(['MAIN_FREIGHT']);
      for (const next of ['LOADED', 'DEPARTED', 'ARRIVED_PORT', 'DELIVERED', 'CLOSED']) {
        await post(`/shipments/${closed.id}/status`, cookies.opsDxb, { status: next }).expect(200);
      }
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
      const s = await confirmedShipment(['WAREHOUSE']);
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

    it('a cancelled shipment keeps its customs file read-only (409)', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      await put(`/shipments/${s.id}/customs`, cookies.customsDxb, { status: 'PENDING' }).expect(
        200,
      );
      await post(`/shipments/${s.id}/cancel`, cookies.opsDxb, { reason: 'x' }).expect(200);
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
