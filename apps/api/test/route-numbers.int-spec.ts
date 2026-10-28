import { randomUUID } from 'node:crypto';
import type {
  BookingDto,
  BookingSummaryDto,
  ConsolidationSummaryDto,
  CustomerDto,
  LocationDto,
  Page,
  ShipmentDto,
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
import { uniquePhone, waitForLockWaiter } from './test-data.js';

// Route numbers (plan docs/reviews/lcl-numbering-capacity-plan-2026-10-27.md): an LCL booking is
// numbered by its route's letters (JED-PTS-0001), any other booking BK00001, and a confirmed
// booking's shipment keeps the booking's number. A shared container is JED-PTS-C0001 on its own
// counter. The people keep the ledger prefix: containers are not removed by the usual cleanup.

let t: TestApp;
let jed: string;
const loc: Record<string, string> = {};
let customer: CustomerDto;
const cookies = { admin: '', salesJed: '', opsJed: '', salesDxb: '' };
const tag = `ZR${randomUUID().slice(0, 5).toUpperCase()}`;

const get = (path: string, cookie: string) => t.http().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: object = {}) =>
  t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
const patch = (path: string, cookie: string, body: object) =>
  t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

const fields = (origin: string, destination: string, loadType: 'LCL' | 'FCL' | null = 'LCL') => ({
  originLocationId: origin,
  destinationLocationId: destination,
  mode: 'SEA',
  loadType,
  cargoType: 'GENERAL',
  services: [],
  items: [{ cargoType: 'GENERAL', quantity: 2, weightKg: '300', volumeCbm: '1.5' }],
});
const book = async (origin: string, destination: string, loadType: 'LCL' | 'FCL' | null = 'LCL') =>
  (
    await post('/bookings', cookies.salesJed, {
      customerId: customer.id,
      ...fields(origin, destination, loadType),
    }).expect(201)
  ).body as BookingDto;
const serial = (number: string) => Number(/(\d+)$/.exec(number)?.[1]);
const createLocation = async (suffix: string, extra: object = {}) =>
  (
    await post('/master-data/locations', cookies.admin, {
      code: `${tag}${suffix}`,
      kind: 'PORT',
      nameEn: `Route numbers ${tag}${suffix}`,
      nameAr: 'اختبار أرقام المسارات',
      countryCode: 'SD',
      ...extra,
    }).expect(201)
  ).body as LocationDto;

beforeAll(async () => {
  t = await createTestApp();
  jed = await branchId(t.prisma, 'JED');
  for (const code of ['SAJED', 'SDPZU', 'SDKRT', 'AEJEA', 'AEDXB']) {
    loc[code] = (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  }
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
    opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  customer = (
    await post('/customers', cookies.salesJed, {
      branchId: jed,
      kind: 'COMPANY',
      name: `Route Numbers ${tag}`,
      phone: uniquePhone(),
    }).expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await t.close();
});

describe('booking numbers', () => {
  it('numbers an LCL booking by its route, any other BK; the shipment keeps it', async () => {
    const lcl = await book(loc.SAJED!, loc.SDPZU!);
    expect(lcl.number).toMatch(/^JED-PTS-\d{4,}$/);
    const fcl = await book(loc.SAJED!, loc.SDPZU!, 'FCL');
    expect(fcl.number).toMatch(/^BK\d{5,}$/);
    const unset = await book(loc.SAJED!, loc.SDPZU!, null);
    expect(unset.number).toMatch(/^BK\d{5,}$/);
    expect(serial(unset.number)).toBe(serial(fcl.number) + 1);

    for (const booking of [lcl, fcl]) {
      const confirmed = (
        await post(`/bookings/${booking.id}/confirm`, cookies.salesJed).expect(200)
      ).body as BookingDto;
      const shipment = (
        await get(`/shipments/${confirmed.shipmentId}`, cookies.salesJed).expect(200)
      ).body as ShipmentDto;
      expect(shipment.number).toBe(booking.number);
    }
  });

  it('counts each route on its own, and aliases of one city share a counter', async () => {
    const first = await book(loc.SAJED!, loc.SDPZU!);
    const second = await book(loc.SAJED!, loc.SDPZU!);
    expect(serial(second.number)).toBe(serial(first.number) + 1);
    const other = await book(loc.SAJED!, loc.SDKRT!);
    expect(other.number).toMatch(/^JED-KRT-\d{4,}$/);
    const third = await book(loc.SAJED!, loc.SDPZU!);
    expect(serial(third.number)).toBe(serial(second.number) + 1);

    // Jebel Ali and Dubai are both DXB.
    const jebelAli = await book(loc.AEJEA!, loc.SDPZU!);
    const dubai = await book(loc.AEDXB!, loc.SDPZU!);
    expect(jebelAli.number).toMatch(/^DXB-PTS-\d{4,}$/);
    expect(dubai.number).toMatch(/^DXB-PTS-\d{4,}$/);
    expect(serial(dubai.number)).toBe(serial(jebelAli.number) + 1);
  });

  it("refuses an LCL booking at a place without letters, and uses its city's", async () => {
    const bare = await createLocation('1A');
    const refused = (
      await post('/bookings', cookies.salesJed, {
        customerId: customer.id,
        ...fields(bare.id, loc.SDPZU!),
      }).expect(400)
    ).body as { code: string; fields: string[]; params: Record<string, string> };
    expect(refused).toMatchObject({
      code: 'ROUTE_CODE_MISSING',
      fields: ['originLocationId'],
      params: { location: bare.code },
    });
    // The same place takes FCL bookings: BK numbers need no letters.
    expect((await book(bare.id, loc.SDPZU!, 'FCL')).number).toMatch(/^BK\d{5,}$/);
    // No booking was half made.
    expect(
      await t.prisma.booking.count({ where: { originLocationId: bare.id, loadType: 'LCL' } }),
    ).toBe(0);

    const city = await createLocation('2C', { kind: 'CITY', shortCode: 'ZQX' });
    const port = await createLocation('2P', { cityId: city.id });
    expect((await book(port.id, loc.SDPZU!)).number).toMatch(/^ZQX-PTS-\d{4,}$/);
  });
});

describe('route letters in master data', () => {
  it('are set by an administrator, upper-cased, checked and logged', async () => {
    const place = await createLocation('3P');
    expect(place.shortCode).toBeNull();
    const set = (
      await patch(`/master-data/locations/${place.id}`, cookies.admin, { shortCode: 'zqy' }).expect(
        200,
      )
    ).body as LocationDto;
    expect(set.shortCode).toBe('ZQY');
    for (const bad of ['Z', 'ZQYXW', 'Z1Q', 'ز ق']) {
      await patch(`/master-data/locations/${place.id}`, cookies.admin, { shortCode: bad }).expect(
        400,
      );
    }
    await patch(`/master-data/locations/${place.id}`, cookies.salesJed, {
      shortCode: 'ZQW',
    }).expect(403);
    const events = await t.prisma.auditEvent.findMany({
      where: { entity: 'LOCATION', entityId: place.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['CREATED', 'UPDATED']);
    expect(events[1]?.changes).toEqual([{ field: 'shortCode', before: null, after: 'ZQY' }]);
    // Cleared again, the place falls back to nothing (its code ends in a digit and letters).
    const cleared = (
      await patch(`/master-data/locations/${place.id}`, cookies.admin, { shortCode: null }).expect(
        200,
      )
    ).body as LocationDto;
    expect(cleared.shortCode).toBeNull();
  });
});

describe('a draft whose route changes', () => {
  it('takes a number of its new series, and is found by its old one', async () => {
    const draft = await book(loc.SAJED!, loc.SDPZU!);
    // An edit that keeps the route keeps the number.
    const same = (
      await patch(`/bookings/${draft.id}`, cookies.salesJed, {
        ...fields(loc.SAJED!, loc.SDPZU!),
        specialInstructions: 'Fragile',
      }).expect(200)
    ).body as BookingDto;
    expect(same.number).toBe(draft.number);

    const moved = (
      await patch(`/bookings/${draft.id}`, cookies.salesJed, fields(loc.SAJED!, loc.SDKRT!)).expect(
        200,
      )
    ).body as BookingDto;
    expect(moved.number).toMatch(/^JED-KRT-\d{4,}$/);
    const fcl = (
      await patch(
        `/bookings/${draft.id}`,
        cookies.salesJed,
        fields(loc.SAJED!, loc.SDKRT!, 'FCL'),
      ).expect(200)
    ).body as BookingDto;
    expect(fcl.number).toMatch(/^BK\d{5,}$/);
    // FCL on another route keeps its BK number: BK fits any route.
    const fclAgain = (
      await patch(
        `/bookings/${draft.id}`,
        cookies.salesJed,
        fields(loc.SAJED!, loc.SDPZU!, 'FCL'),
      ).expect(200)
    ).body as BookingDto;
    expect(fclAgain.number).toBe(fcl.number);

    const mappings = await t.prisma.referenceRenumbering.findMany({
      where: { kind: 'BOOKING', recordId: draft.id },
      orderBy: { id: 'asc' },
    });
    expect(mappings.map((m) => [m.oldNumber, m.newNumber, m.reason])).toEqual([
      [draft.number, moved.number, 'DRAFT_ROUTE_CHANGE'],
      [moved.number, fcl.number, 'DRAFT_ROUTE_CHANGE'],
    ]);

    const found = (await get(`/bookings?q=${draft.number}`, cookies.salesJed).expect(200))
      .body as Page<BookingSummaryDto>;
    expect(found.items.map((b) => b.id)).toContain(draft.id);
    // Another branch's staff never find it, by any number.
    const elsewhere = (await get(`/bookings?q=${draft.number}`, cookies.salesDxb).expect(200))
      .body as Page<BookingSummaryDto>;
    expect(elsewhere.items.map((b) => b.id)).not.toContain(draft.id);
  });

  it('never confirms a booking under a number of a route it no longer has', async () => {
    const draft = await book(loc.SAJED!, loc.SDPZU!);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const holdingNow = new Promise<void>((resolve) => (holding = resolve));
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "bookings" WHERE "id" = ${draft.id}::uuid FOR UPDATE`;
        holding();
        await held;
      },
      { timeout: 20_000 },
    );
    await holdingNow;
    const edit = patch(
      `/bookings/${draft.id}`,
      cookies.salesJed,
      fields(loc.SAJED!, loc.SDKRT!),
    ).then((res) => res);
    await waitForLockWaiter(t.prisma, 1);
    const confirm = post(`/bookings/${draft.id}/confirm`, cookies.salesJed).then((res) => res);
    await waitForLockWaiter(t.prisma, 2);
    release();
    await holder;
    await Promise.all([edit, confirm]);

    const booking = await t.prisma.booking.findUniqueOrThrow({
      where: { id: draft.id },
      include: { shipment: true },
    });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.shipment?.number).toBe(booking.number);
  });

  it('confirms nothing once cancelled', async () => {
    const draft = await book(loc.SAJED!, loc.SDPZU!);
    await post(`/bookings/${draft.id}/cancel`, cookies.salesJed, { reason: 'Test' }).expect(200);
    await post(`/bookings/${draft.id}/confirm`, cookies.salesJed).expect(409);
    expect(await t.prisma.shipment.count({ where: { bookingId: draft.id } })).toBe(0);
  });
});

describe('shared containers', () => {
  it('are numbered by route on their own counter', async () => {
    const make = async () =>
      (
        await post('/consolidations', cookies.opsJed, {
          branchId: jed,
          originLocationId: loc.SAJED,
          destinationLocationId: loc.SDPZU,
          containerTypeCode: '20GP',
          shipmentIds: [],
        }).expect(201)
      ).body as ConsolidationSummaryDto;
    const booking = await book(loc.SAJED!, loc.SDPZU!);
    const first = await make();
    const second = await make();
    expect(first.number).toMatch(/^JED-PTS-C\d{4,}$/);
    expect(serial(second.number)).toBe(serial(first.number) + 1);
    // Bookings on the route count on, untouched by containers.
    expect(serial((await book(loc.SAJED!, loc.SDPZU!)).number)).toBe(serial(booking.number) + 1);
  });
});

describe('old numbers', () => {
  it("find a renumbered shipment in its branch's list, not in another branch's", async () => {
    const booking = await book(loc.SAJED!, loc.SDPZU!);
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesJed).expect(200))
      .body as BookingDto;
    const shipmentId = confirmed.shipmentId!;
    const old = `NOL-SHP-2026-${randomUUID().replace(/\D/g, '').padEnd(6, '7').slice(0, 6)}`;
    await t.prisma.referenceRenumbering.create({
      data: {
        kind: 'SHIPMENT',
        recordId: shipmentId,
        oldNumber: old,
        newNumber: booking.number,
        reason: 'MIGRATION',
      },
    });
    const mine = (await get(`/shipments?q=${old}`, cookies.salesJed).expect(200))
      .body as Page<ShipmentDto>;
    expect(mine.items.map((s) => s.id)).toEqual([shipmentId]);
    const theirs = (await get(`/shipments?q=${old}`, cookies.salesDxb).expect(200))
      .body as Page<ShipmentDto>;
    expect(theirs.items).toEqual([]);
  });

  it('are kept: a mapping is never changed or removed', async () => {
    const row = await t.prisma.referenceRenumbering.findFirstOrThrow({ orderBy: { id: 'desc' } });
    await expect(
      t.prisma.referenceRenumbering.update({ where: { id: row.id }, data: { newNumber: 'X' } }),
    ).rejects.toThrow();
    await expect(t.prisma.referenceRenumbering.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE "reference_renumberings"')).rejects.toThrow();
  });
});
