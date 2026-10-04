import type {
  BookingDto,
  CustomerDto,
  Page,
  PublicTrackingDto,
  ShipmentDocumentDto,
  ShipmentDto,
  ShipmentSummaryDto,
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

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

describe('shipments: creation, state machine, documents, public tracking', () => {
  let t: TestApp;
  let dxb: string;
  let jebelAli: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  const cookies: Record<
    | 'admin'
    | 'salesDxb'
    | 'salesJed'
    | 'managerDxb'
    | 'opsDxb'
    | 'customsDxb'
    | 'warehouseDxb'
    | 'driver',
    string
  > = {
    admin: '',
    salesDxb: '',
    salesJed: '',
    managerDxb: '',
    opsDxb: '',
    customsDxb: '',
    warehouseDxb: '',
    driver: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const del = (path: string, cookie: string) =>
    t.http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);
  const upload = (shipmentId: string, cookie: string, file: Buffer, name: string, type = 'BL') =>
    t
      .http()
      .post(`/api/v1/shipments/${shipmentId}/documents`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .field('typeCode', type)
      .field('fileName', name)
      .attach('file', file, 'upload.bin');

  /** A confirmed booking with the given services; returns its shipment. */
  async function confirmedShipment(services: string[] = ['MAIN_FREIGHT']): Promise<ShipmentDto> {
    const booking = (
      await post('/bookings', cookies.opsDxb, {
        customerId: customer.id,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        services,
        consigneeId: customer.parties[0]?.id,
        items: [
          { cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 2, weightKg: '18000' },
        ],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsDxb).expect(200))
      .body as BookingDto;
    expect(confirmed.shipmentId).not.toBeNull();
    return (await get(`/shipments/${confirmed.shipmentId}`, cookies.opsDxb).expect(200))
      .body as ShipmentDto;
  }

  const move = (id: string, cookie: string, status: string, extra: object = {}) =>
    post(`/shipments/${id}/status`, cookie, { status, ...extra });

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jebelAli = await loc('AEJEA');
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR']),
      salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
      managerDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
      opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
      customsDxb: await createUser(t.prisma, ['CUSTOMS'], ['DXB']),
      warehouseDxb: await createUser(t.prisma, ['WAREHOUSE'], ['DXB']),
      driver: await createUser(t.prisma, ['DRIVER'], ['DXB']),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const created = (
      await post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Shipment Test Trading',
        phone: '+971501110001',
      }).expect(201)
    ).body as CustomerDto;
    await post(`/customers/${created.id}/parties`, cookies.salesDxb, {
      name: 'Port Sudan Consignee',
      phone: '+249912347788',
    }).expect(201);
    customer = (await get(`/customers/${created.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDto;
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('creation from a booking', () => {
    it('confirming a booking creates one shipment that copies the booking', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      expect(s.number).toMatch(/^NOL-SHP-\d{4}-\d{6}$/);
      expect(s.status).toBe('CREATED');
      expect(s.branchId).toBe(dxb);
      expect(s.customerId).toBe(customer.id);
      expect(s.services).toEqual(['MAIN_FREIGHT', 'CUSTOMS']);
      expect(s.consigneeId).toBe(customer.parties[0]?.id);
      expect(s.items).toHaveLength(1);
      // Packages on the cargo lines, which the package labels number up to.
      expect(s.packages).toBe(2);
      expect(s.items[0]).toMatchObject({
        containerTypeCode: '40HC',
        quantity: 2,
        weightKg: '18000',
      });
      expect(s.trackingToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(s.events).toHaveLength(1);
      expect(s.events[0]).toMatchObject({ kind: 'CREATED', status: 'CREATED', source: 'USER' });
      expect(s.actions.transitions).toEqual(['LOADED']);
    });

    it('a booking cannot get a second shipment', async () => {
      const s = await confirmedShipment();
      await post(`/bookings/${s.bookingId}/confirm`, cookies.opsDxb).expect(409);
      expect(await t.prisma.shipment.count({ where: { bookingId: s.bookingId } })).toBe(1);
    });
  });

  describe('branch scope and permissions', () => {
    it('another branch neither sees nor changes the shipment', async () => {
      const s = await confirmedShipment();
      await get(`/shipments/${s.id}`, cookies.salesJed).expect(404);
      await move(s.id, cookies.salesJed, 'LOADED').expect(404);
      const list = (await get(`/shipments?q=${s.number}`, cookies.salesJed).expect(200))
        .body as Page<ShipmentSummaryDto>;
      expect(list.items).toHaveLength(0);
      await get(`/shipments/by-token/${s.trackingToken}`, cookies.salesJed).expect(404);
      const own = (
        await get(`/shipments/by-token/${s.trackingToken}`, cookies.salesDxb).expect(200)
      ).body as { id: string };
      expect(own.id).toBe(s.id);
    });

    it('a Driver sees no shipments until trips assign them', async () => {
      const s = await confirmedShipment();
      const list = (await get('/shipments', cookies.driver).expect(200))
        .body as Page<ShipmentSummaryDto>;
      expect(list.total).toBe(0);
      await get(`/shipments/${s.id}`, cookies.driver).expect(404);
      await get(`/shipments/${s.id}/documents`, cookies.driver).expect(404);
    });

    it('view-only roles cannot move a shipment; stage teams move their own stage only', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      await move(s.id, cookies.salesDxb, 'LOADED').expect(403);
      await move(s.id, cookies.customsDxb, 'LOADED').expect(403);
      for (const status of ['LOADED', 'DEPARTED', 'ARRIVED_PORT']) {
        await move(s.id, cookies.opsDxb, status).expect(200);
      }
      const customs = (await move(s.id, cookies.customsDxb, 'CUSTOMS_IN_PROGRESS').expect(200))
        .body as ShipmentDto;
      expect(customs.actions.transitions).toEqual(['CUSTOMS_CLEARED']);
      const sales = (await get(`/shipments/${s.id}`, cookies.salesDxb).expect(200))
        .body as ShipmentDto;
      expect(sales.actions).toMatchObject({
        transitions: [],
        canHold: false,
        canCancel: false,
        revertTo: null,
      });
    });
  });

  describe('state machine', () => {
    it('refuses skipped stages and stages whose service was not booked', async () => {
      const s = await confirmedShipment();
      await move(s.id, cookies.opsDxb, 'PICKUP_SCHEDULED').expect(409);
      await move(s.id, cookies.opsDxb, 'CUSTOMS_IN_PROGRESS').expect(409);
      await move(s.id, cookies.opsDxb, 'ARRIVED_PORT').expect(409);
      await move(s.id, cookies.opsDxb, 'CLOSED').expect(409);
      await move(s.id, cookies.opsDxb, 'NOT_A_STATUS').expect(400);
    });

    it('booked stages cannot be jumped: customs and last mile come before delivery', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS', 'LAST_MILE']);
      for (const status of ['LOADED', 'DEPARTED', 'ARRIVED_PORT']) {
        await move(s.id, cookies.opsDxb, status).expect(200);
      }
      const atPort = (await get(`/shipments/${s.id}`, cookies.opsDxb).expect(200))
        .body as ShipmentDto;
      expect(atPort.actions.transitions).toEqual(['CUSTOMS_IN_PROGRESS']);
      await move(s.id, cookies.opsDxb, 'DELIVERED').expect(409);
      await move(s.id, cookies.opsDxb, 'OUT_FOR_DELIVERY').expect(409);
      await move(s.id, cookies.opsDxb, 'CUSTOMS_IN_PROGRESS').expect(200);
      await move(s.id, cookies.opsDxb, 'CUSTOMS_CLEARED').expect(200);
      await move(s.id, cookies.opsDxb, 'DELIVERED').expect(409);
      await move(s.id, cookies.opsDxb, 'OUT_FOR_DELIVERY').expect(200);
      await move(s.id, cookies.opsDxb, 'DELIVERED').expect(200);
    });

    it('services are fixed once the shipment moves, so no stage can be removed', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      await patch(`/shipments/${s.id}`, cookies.opsDxb, {
        services: ['MAIN_FREIGHT', 'CUSTOMS', 'LAST_MILE'],
      }).expect(200);
      for (const status of ['LOADED', 'DEPARTED', 'ARRIVED_PORT']) {
        await move(s.id, cookies.opsDxb, status).expect(200);
      }
      await patch(`/shipments/${s.id}`, cookies.opsDxb, { services: ['MAIN_FREIGHT'] }).expect(409);
      // The same services in another order, with other details, are not a change.
      const same = (
        await patch(`/shipments/${s.id}`, cookies.opsDxb, {
          services: ['LAST_MILE', 'MAIN_FREIGHT', 'CUSTOMS'],
          vesselName: 'MSC Aurora',
        }).expect(200)
      ).body as ShipmentDto;
      expect(same.actions.transitions).toEqual(['CUSTOMS_IN_PROGRESS']);
    });

    it('a services change waiting on a concurrent status change is refused', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        await tx.shipment.update({ where: { id: s.id }, data: { status: 'LOADED' } });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: s.id,
            kind: 'STATUS',
            status: 'LOADED',
            fromStatus: 'CREATED',
            occurredAt: new Date(),
            branchId: dxb,
            source: 'SYSTEM',
          },
        });
        const request = patch(`/shipments/${s.id}`, cookies.opsDxb, {
          services: ['MAIN_FREIGHT'],
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(409);
      const row = await t.prisma.shipment.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.services).toEqual(['MAIN_FREIGHT', 'CUSTOMS']);
    });

    it('a services edit read before a concurrent change is compared with the locked row', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'CUSTOMS']);
      // Another request changes the services and the shipment moves while this one waits. Its
      // input equals what it read before the lock, which is no longer the row's value.
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        await tx.shipment.update({
          where: { id: s.id },
          data: { services: ['MAIN_FREIGHT'], status: 'LOADED' },
        });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: s.id,
            kind: 'STATUS',
            status: 'LOADED',
            fromStatus: 'CREATED',
            occurredAt: new Date(),
            branchId: dxb,
            source: 'SYSTEM',
          },
        });
        const request = patch(`/shipments/${s.id}`, cookies.opsDxb, {
          services: ['MAIN_FREIGHT', 'CUSTOMS'],
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(409);
      const row = await t.prisma.shipment.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.services).toEqual(['MAIN_FREIGHT']);
    });

    it('reverting repeated partial deliveries undoes one at a time', async () => {
      const s = await confirmedShipment(['MAIN_FREIGHT', 'LAST_MILE']);
      for (const status of [
        'LOADED',
        'DEPARTED',
        'ARRIVED_PORT',
        'OUT_FOR_DELIVERY',
        'PARTIALLY_DELIVERED',
        'PARTIALLY_DELIVERED',
      ]) {
        await move(s.id, cookies.opsDxb, status).expect(200);
      }
      const first = (
        await post(`/shipments/${s.id}/revert`, cookies.managerDxb, {
          reason: 'Double entry',
        }).expect(200)
      ).body as ShipmentDto;
      expect(first.status).toBe('PARTIALLY_DELIVERED');
      expect(first.actions.revertTo).toBe('OUT_FOR_DELIVERY');
      const second = (
        await post(`/shipments/${s.id}/revert`, cookies.managerDxb, {
          reason: 'Wrong batch',
        }).expect(200)
      ).body as ShipmentDto;
      expect(second.status).toBe('OUT_FOR_DELIVERY');
    });

    it('events must name an existing branch', async () => {
      const s = await confirmedShipment();
      await expect(
        t.prisma.shipmentEvent.create({
          data: {
            shipmentId: s.id,
            kind: 'STATUS',
            status: 'LOADED',
            occurredAt: new Date(),
            branchId: '00000000-0000-4000-8000-000000000000',
            source: 'SYSTEM',
          },
        }),
      ).rejects.toThrow();
    });

    it('records each change with time, location, user, source and note', async () => {
      const s = await confirmedShipment();
      const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const moved = (
        await move(s.id, cookies.opsDxb, 'LOADED', {
          occurredAt: at,
          locationId: jebelAli,
          note: 'Loaded on MSC Aurora',
        }).expect(200)
      ).body as ShipmentDto;
      expect(moved.status).toBe('LOADED');
      expect(moved.currentLocationId).toBe(jebelAli);
      expect(moved.events.at(-1)).toMatchObject({
        kind: 'STATUS',
        status: 'LOADED',
        fromStatus: 'CREATED',
        occurredAt: at,
        locationId: jebelAli,
        branchId: dxb,
        source: 'USER',
        note: 'Loaded on MSC Aurora',
        userName: 'Integration Test',
      });
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await move(s.id, cookies.opsDxb, 'DEPARTED', { occurredAt: future }).expect(400);
    });

    it('holds with a reason and resumes to the status before the hold', async () => {
      const s = await confirmedShipment();
      await move(s.id, cookies.opsDxb, 'LOADED').expect(200);
      await post(`/shipments/${s.id}/hold`, cookies.opsDxb, {}).expect(400);
      await post(`/shipments/${s.id}/hold`, cookies.salesDxb, { reason: 'x' }).expect(403);
      const held = (
        await post(`/shipments/${s.id}/hold`, cookies.opsDxb, { reason: 'Port strike' }).expect(200)
      ).body as ShipmentDto;
      expect(held).toMatchObject({
        status: 'ON_HOLD',
        statusBeforeHold: 'LOADED',
        holdReason: 'Port strike',
      });
      expect(held.actions.transitions).toEqual([]);
      await move(s.id, cookies.opsDxb, 'DEPARTED').expect(409);
      await post(`/shipments/${s.id}/hold`, cookies.opsDxb, { reason: 'again' }).expect(409);
      const resumed = (await post(`/shipments/${s.id}/resume`, cookies.opsDxb, {}).expect(200))
        .body as ShipmentDto;
      expect(resumed).toMatchObject({ status: 'LOADED', statusBeforeHold: null, holdReason: null });
      await post(`/shipments/${s.id}/resume`, cookies.opsDxb, {}).expect(409);
    });

    it('goes back one status only with shipments:approve and a reason', async () => {
      const s = await confirmedShipment();
      await move(s.id, cookies.opsDxb, 'LOADED', { locationId: jebelAli }).expect(200);
      await move(s.id, cookies.opsDxb, 'DEPARTED', { locationId: khartoum }).expect(200);
      await post(`/shipments/${s.id}/revert`, cookies.opsDxb, {}).expect(400);
      await post(`/shipments/${s.id}/revert`, cookies.salesDxb, { reason: 'x' }).expect(403);
      const reverted = (
        await post(`/shipments/${s.id}/revert`, cookies.managerDxb, {
          reason: 'Entered by mistake',
        }).expect(200)
      ).body as ShipmentDto;
      expect(reverted.status).toBe('LOADED');
      expect(reverted.currentLocationId).toBe(jebelAli);
      expect(reverted.events.at(-1)).toMatchObject({
        kind: 'REVERT',
        status: 'LOADED',
        fromStatus: 'DEPARTED',
        reason: 'Entered by mistake',
      });
      expect(reverted.actions.revertTo).toBe('CREATED');
    });

    it('closing a delivered shipment completes its booking and freezes the shipment', async () => {
      const s = await confirmedShipment();
      for (const status of ['LOADED', 'DEPARTED', 'ARRIVED_PORT', 'DELIVERED']) {
        await move(s.id, cookies.opsDxb, status).expect(200);
      }
      await move(s.id, cookies.salesDxb, 'CLOSED').expect(403);
      const closed = (await move(s.id, cookies.opsDxb, 'CLOSED').expect(200)).body as ShipmentDto;
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).not.toBeNull();
      const booking = (await get(`/bookings/${s.bookingId}`, cookies.opsDxb).expect(200))
        .body as BookingDto;
      expect(booking.status).toBe('COMPLETED');
      await patch(`/shipments/${s.id}`, cookies.opsDxb, { vesselName: 'x' }).expect(409);
      await post(`/shipments/${s.id}/revert`, cookies.managerDxb, { reason: 'x' }).expect(409);
      await post(`/shipments/${s.id}/hold`, cookies.opsDxb, { reason: 'x' }).expect(409);
    });

    it('two concurrent changes of the same status: one wins, the other is refused', async () => {
      const s = await confirmedShipment();
      const results = await Promise.all([
        move(s.id, cookies.opsDxb, 'LOADED'),
        move(s.id, cookies.opsDxb, 'LOADED'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const events = await t.prisma.shipmentEvent.count({ where: { shipmentId: s.id } });
      expect(events).toBe(2);
    });

    it('a status change waits for a concurrent one holding the row lock', async () => {
      const s = await confirmedShipment();
      // The pending request is wrapped in an object: returning the promise itself would make the
      // transaction wait for the request, which waits for the transaction's lock.
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        await tx.shipment.update({ where: { id: s.id }, data: { status: 'LOADED' } });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: s.id,
            kind: 'STATUS',
            status: 'LOADED',
            fromStatus: 'CREATED',
            occurredAt: new Date(),
            branchId: dxb,
            source: 'SYSTEM',
          },
        });
        const request = move(s.id, cookies.opsDxb, 'LOADED').then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      // It ran after the commit, saw LOADED, and refused LOADED → LOADED.
      expect(await pending).toBe(409);
    });
  });

  describe('cancellation', () => {
    it('before loading, Operations cancels and the booking is cancelled too', async () => {
      const s = await confirmedShipment();
      await post(`/shipments/${s.id}/cancel`, cookies.salesDxb, { reason: 'x' }).expect(403);
      await post(`/shipments/${s.id}/cancel`, cookies.opsDxb, {}).expect(400);
      const cancelled = (
        await post(`/shipments/${s.id}/cancel`, cookies.opsDxb, {
          reason: 'Customer withdrew',
        }).expect(200)
      ).body as ShipmentDto;
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer withdrew' });
      const booking = (await get(`/bookings/${s.bookingId}`, cookies.opsDxb).expect(200))
        .body as BookingDto;
      expect(booking).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer withdrew' });
      await move(s.id, cookies.opsDxb, 'LOADED').expect(409);
    });

    it('after loading only a Branch Manager cancels', async () => {
      const s = await confirmedShipment();
      await move(s.id, cookies.opsDxb, 'LOADED').expect(200);
      const ops = (await get(`/shipments/${s.id}`, cookies.opsDxb).expect(200)).body as ShipmentDto;
      expect(ops.actions.canCancel).toBe(false);
      await post(`/shipments/${s.id}/cancel`, cookies.opsDxb, { reason: 'x' }).expect(403);
      await post(`/bookings/${s.bookingId}/cancel`, cookies.salesDxb, { reason: 'x' }).expect(403);
      await post(`/shipments/${s.id}/cancel`, cookies.managerDxb, { reason: 'Vessel lost' }).expect(
        200,
      );
    });

    it('cancelling a confirmed booking cancels its shipment', async () => {
      const s = await confirmedShipment();
      await post(`/bookings/${s.bookingId}/cancel`, cookies.salesDxb, {
        reason: 'Changed mind',
      }).expect(200);
      const after = (await get(`/shipments/${s.id}`, cookies.opsDxb).expect(200))
        .body as ShipmentDto;
      expect(after.status).toBe('CANCELLED');
      expect(after.events.at(-1)).toMatchObject({ kind: 'CANCEL', reason: 'Changed mind' });
    });

    it('a delivered shipment cannot be cancelled', async () => {
      const s = await confirmedShipment();
      for (const status of ['LOADED', 'DEPARTED', 'ARRIVED_PORT', 'DELIVERED']) {
        await move(s.id, cookies.opsDxb, status).expect(200);
      }
      await post(`/shipments/${s.id}/cancel`, cookies.managerDxb, { reason: 'x' }).expect(409);
    });
  });

  describe('details and containers', () => {
    it('edits transport details and checks ETA after ETD', async () => {
      const s = await confirmedShipment();
      await patch(`/shipments/${s.id}`, cookies.salesDxb, { vesselName: 'x' }).expect(403);
      const updated = (
        await patch(`/shipments/${s.id}`, cookies.opsDxb, {
          carrierName: 'MSC',
          vesselName: 'MSC Aurora',
          voyageNumber: 'AU123',
          blNumber: 'MSCUJEA123456',
          etd: '2026-11-01',
          eta: '2026-11-10',
        }).expect(200)
      ).body as ShipmentDto;
      expect(updated).toMatchObject({
        vesselName: 'MSC Aurora',
        etd: '2026-11-01',
        eta: '2026-11-10',
      });
      await patch(`/shipments/${s.id}`, cookies.opsDxb, { eta: '2026-10-01' }).expect(400);
      await patch(`/shipments/${s.id}`, cookies.opsDxb, { services: [] }).expect(400);
    });

    it('adds containers with a valid ISO 6346 number, once per shipment', async () => {
      const s = await confirmedShipment();
      const body = {
        containerNumber: 'mscu 123456-5',
        sealNumber: 'SL1',
        containerTypeCode: '40HC',
      };
      const added = (await post(`/shipments/${s.id}/containers`, cookies.opsDxb, body).expect(201))
        .body as ShipmentDto;
      expect(added.containers[0]).toMatchObject({
        containerNumber: 'MSCU1234565',
        sealNumber: 'SL1',
      });
      await post(`/shipments/${s.id}/containers`, cookies.opsDxb, body).expect(409);
      await post(`/shipments/${s.id}/containers`, cookies.opsDxb, {
        ...body,
        containerNumber: '12345',
      }).expect(400);
      await post(`/shipments/${s.id}/containers`, cookies.opsDxb, {
        ...body,
        containerNumber: 'TGHU7654321',
        containerTypeCode: 'NOPE',
      }).expect(400);
      const containerId = added.containers[0]?.id ?? '';
      const removed = (
        await del(`/shipments/${s.id}/containers/${containerId}`, cookies.opsDxb).expect(200)
      ).body as ShipmentDto;
      expect(removed.containers).toHaveLength(0);
    });

    it('a container write waiting on a concurrent close is refused', async () => {
      const s = await confirmedShipment();
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        await tx.shipment.update({
          where: { id: s.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        });
        const request = post(`/shipments/${s.id}/containers`, cookies.opsDxb, {
          containerNumber: 'TGHU7654321',
          containerTypeCode: '40HC',
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(409);
      expect(await t.prisma.shipmentContainer.count({ where: { shipmentId: s.id } })).toBe(0);
    });

    it('serves the QR code of the tracking link', async () => {
      const s = await confirmedShipment();
      const res = await get(`/shipments/${s.id}/qr.svg`, cookies.salesDxb).expect(200);
      expect(res.headers['content-type']).toContain('image/svg+xml');
      expect(String(res.body ?? res.text)).toContain('<svg');
      await get(`/shipments/${s.id}/qr.svg`, cookies.salesJed).expect(404);
    });
  });

  describe('documents', () => {
    it('uploads a PDF, lists it and downloads the same bytes', async () => {
      const s = await confirmedShipment();
      const doc = (await upload(s.id, cookies.opsDxb, PDF, 'بوليصة.pdf').expect(201))
        .body as ShipmentDocumentDto;
      expect(doc).toMatchObject({
        typeCode: 'BL',
        fileName: 'بوليصة.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
      });
      const list = (await get(`/shipments/${s.id}/documents`, cookies.salesDxb).expect(200))
        .body as ShipmentDocumentDto[];
      expect(list.map((d) => d.id)).toEqual([doc.id]);
      const file = await get(`/shipments/${s.id}/documents/${doc.id}/file`, cookies.salesDxb)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-disposition']).toContain('attachment;');
      expect(file.headers['content-disposition']).toContain(
        `filename*=UTF-8''${encodeURIComponent('بوليصة.pdf')}`,
      );
      expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    });

    it('rejects files that are not PDF or images, unknown types and oversized files', async () => {
      const s = await confirmedShipment();
      await upload(s.id, cookies.opsDxb, Buffer.from('<html><script>x</script>'), 'x.pdf').expect(
        400,
      );
      await upload(s.id, cookies.opsDxb, PDF, 'x.pdf', 'NOT_A_TYPE').expect(400);
      const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
      await upload(s.id, cookies.opsDxb, big, 'big.pdf').expect(413);
    });

    it('an upload waiting on a concurrent cancel is refused', async () => {
      const s = await confirmedShipment();
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        await tx.shipment.update({
          where: { id: s.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: 'Customer cancelled',
          },
        });
        const request = upload(s.id, cookies.opsDxb, PDF, 'late.pdf').then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(409);
      expect(await t.prisma.document.count({ where: { shipmentId: s.id } })).toBe(0);
    });

    it('follows the shipment’s branch and the documents permissions', async () => {
      const s = await confirmedShipment();
      const doc = (await upload(s.id, cookies.warehouseDxb, PDF, 'pod.pdf', 'POD').expect(201))
        .body as ShipmentDocumentDto;
      await get(`/shipments/${s.id}/documents`, cookies.salesJed).expect(404);
      await get(`/shipments/${s.id}/documents/${doc.id}/file`, cookies.salesJed).expect(404);
      await upload(s.id, cookies.salesJed, PDF, 'x.pdf').expect(404);
      await del(`/shipments/${s.id}/documents/${doc.id}`, cookies.opsDxb).expect(403);
      await del(`/shipments/${s.id}/documents/${doc.id}`, cookies.managerDxb).expect(204);
      const list = (await get(`/shipments/${s.id}/documents`, cookies.opsDxb).expect(200))
        .body as ShipmentDocumentDto[];
      expect(list).toHaveLength(0);
      await get(`/shipments/${s.id}/documents/${doc.id}/file`, cookies.opsDxb).expect(404);
      const row = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row.deletedAt).not.toBeNull();
    });
  });

  describe('public tracking', () => {
    it('shows only the safe fields, without signing in', async () => {
      const s = await confirmedShipment();
      await patch(`/shipments/${s.id}`, cookies.opsDxb, { eta: '2026-12-01' }).expect(200);
      await move(s.id, cookies.opsDxb, 'LOADED', {
        locationId: jebelAli,
        note: 'secret note',
      }).expect(200);
      const res = await t.http().get(`/api/v1/public/tracking/${s.trackingToken}`).expect(200);
      const body = res.body as PublicTrackingDto;
      expect(body).toMatchObject({
        reference: s.number,
        mode: 'SEA',
        status: 'LOADED',
        eta: '2026-12-01',
        origin: { code: 'AEJEA' },
        destination: { code: 'SDPZU' },
        currentLocation: { code: 'AEJEA' },
      });
      expect(body.timeline.map((e) => e.status)).toEqual(['REGISTERED', 'LOADED']);
      const text = JSON.stringify(body);
      for (const secret of [
        customer.name,
        customer.phone,
        'Port Sudan Consignee',
        '18000',
        'secret note',
        s.customerId,
        s.id,
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('hides internal statuses and cancelled shipments', async () => {
      const s = await confirmedShipment();
      await move(s.id, cookies.opsDxb, 'LOADED').expect(200);
      await post(`/shipments/${s.id}/hold`, cookies.opsDxb, { reason: 'internal reason' }).expect(
        200,
      );
      const held = (await t.http().get(`/api/v1/public/tracking/${s.trackingToken}`).expect(200))
        .body as PublicTrackingDto;
      expect(held.status).toBe('ON_HOLD');
      expect(JSON.stringify(held)).not.toContain('internal reason');
      await post(`/shipments/${s.id}/cancel`, cookies.managerDxb, { reason: 'x' }).expect(200);
      await t.http().get(`/api/v1/public/tracking/${s.trackingToken}`).expect(404);
    });

    it('rejects unknown and malformed tokens', async () => {
      await t
        .http()
        .get(`/api/v1/public/tracking/${'A'.repeat(32)}`)
        .expect(404);
      await t.http().get('/api/v1/public/tracking/short').expect(400);
    });

    it('looks up by number and phone digits, and blocks guessing', async () => {
      const s = await confirmedShipment();
      const lookup = (phoneLast4: string, reference = s.number) =>
        t
          .http()
          .post('/api/v1/public/tracking/lookup')
          .set('Origin', APP_ORIGIN)
          .send({ reference, phoneLast4 });
      // Consignee's phone ends in 7788; the customer's in 0001.
      expect(((await lookup('7788').expect(200)).body as { token: string }).token).toBe(
        s.trackingToken,
      );
      await lookup('0001', s.number.toLowerCase()).expect(200);
      await lookup('12').expect(400);
      await lookup('9999', 'NOL-SHP-1999-000000').expect(404);
      for (let i = 0; i < 5; i++) await lookup('9999').expect(404);
      await lookup('7788').expect(429);
    });
  });
});
