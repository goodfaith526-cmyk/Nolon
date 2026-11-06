import { randomUUID } from 'node:crypto';
import type { BookingDto, WindowDeskBookingDto } from '@nolon/shared';
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
 * Plan 13 section 2 (and the adapter of 2a): the window desk. An Outlet Staff user sees the
 * CONFIRMED bookings handed over at their outlet's windows, also one sold by another outlet, and
 * nothing else. Negative cases: another outlet's window, a draft booking, a user not limited by
 * outlet, the switch off, an outlet removed after sign-in; no cost or customer-file fields.
 */
describe('Window desk (plan 13 section 2)', () => {
  let on: TestApp;
  let off: TestApp;
  let jed = '';
  const tag = `W${randomUUID().slice(0, 5).toUpperCase()}`;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const as = (t: TestApp, cookie: string) => ({
    get: (path: string, query: object = {}) =>
      t.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });

  async function outlet(name: string): Promise<string> {
    return (
      await on.prisma.partner.create({
        data: {
          number: `${tag}-${name}`,
          kind: 'SALES_OUTLET',
          branchId: jed,
          name: `${tag} ${name}`,
          countryCode: 'SA',
          currency: 'SAR',
          createdById: ids.creator!,
        },
      })
    ).id;
  }
  async function windowOf(partnerId: string, code: string): Promise<string> {
    return (
      await on.prisma.warehouse.create({
        data: {
          branchId: jed,
          code: `${tag}-${code}`,
          nameAr: `نافذة ${code}`,
          nameEn: `Window ${code}`,
          acceptsDropOff: true,
          partnerId,
          phone: '+966500000001',
        },
      })
    ).id;
  }
  async function booking(
    window: string,
    confirm: boolean,
    extra: object = {},
  ): Promise<BookingDto> {
    const made = (
      await as(on, cookies.sales!)
        .post('/bookings', {
          customerId: ids.customer,
          branchId: jed,
          originLocationId: ids.origin,
          destinationLocationId: ids.dest,
          mode: 'ROAD',
          services: [],
          dropOffWarehouseId: window,
          items: [{ cargoType: 'BARREL', quantity: 3, description: 'Barrels' }],
          ...extra,
        })
        .expect(201)
    ).body as BookingDto;
    if (confirm) await as(on, cookies.sales!).post(`/bookings/${made.id}/confirm`, {}).expect(200);
    return made;
  }
  async function outletStaff(
    partnerId: string,
    app: TestApp,
  ): Promise<{ id: string; cookie: string }> {
    const user = await createUser(app.prisma, ['OUTLET_STAFF'], ['JED'], LEDGER_PREFIX);
    await app.prisma.userPartner.create({ data: { userId: user.id, partnerId } });
    return { id: user.id, cookie: await signIn(app, user.email) };
  }

  beforeAll(async () => {
    on = await createTestApp({ WINDOW_DESK_ENABLED: true });
    off = await createTestApp({ WINDOW_DESK_ENABLED: false });
    jed = await branchId(on.prisma, 'JED');
    const sales = await createUser(on.prisma, ['SALES'], ['JED'], LEDGER_PREFIX);
    ids.creator = sales.id;
    cookies.sales = await signIn(on, sales.email);
    for (const [name, suffix] of [
      ['origin', 'ORG'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await on.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Window desk ${tag}${suffix}`,
            nameAr: 'مكان اختبار النافذة',
            countryCode: 'SA',
          },
        })
      ).id;
    }
    ids.customer = (
      await on.prisma.customer.create({
        data: {
          number: `${tag}-C`,
          name: `${tag} customer`,
          phone: uniquePhone(),
          kind: 'INDIVIDUAL',
          createdById: sales.id,
        },
      })
    ).id;
    ids.outletA = await outlet('A');
    ids.outletB = await outlet('B');
    ids.windowA = await windowOf(ids.outletA, 'A');
    ids.windowB = await windowOf(ids.outletB, 'B');
    const staffA = await outletStaff(ids.outletA, on);
    ids.staffA = staffA.id;
    cookies.staffA = staffA.cookie;
    cookies.staffOff = (await outletStaff(ids.outletA, off)).cookie;
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
  });

  it("lists the confirmed bookings at the outlet's windows, also one another outlet sold", async () => {
    const mine = await booking(ids.windowA!, true);
    const soldByB = await booking(ids.windowA!, true, { salesOutletId: ids.outletB });
    const atB = await booking(ids.windowB!, true);
    const draft = await booking(ids.windowA!, false);
    ids.mine = mine.id;
    ids.soldByB = soldByB.id;
    ids.atB = atB.id;
    ids.draft = draft.id;
    const list = (await as(on, cookies.staffA!).get('/window-desk/expected').expect(200))
      .body as WindowDeskBookingDto[];
    const listed = list.map((r) => r.bookingId);
    expect(listed).toEqual(expect.arrayContaining([mine.id, soldByB.id]));
    expect(listed).not.toContain(atB.id);
    expect(listed).not.toContain(draft.id);
    const row = list.find((r) => r.bookingId === mine.id)!;
    expect(row).toMatchObject({
      bookingNumber: mine.number,
      sender: { name: `${tag} customer` },
      window: { id: ids.windowA, code: `${tag}-A`, phone: '+966500000001' },
      received: false,
    });
    expect(row.todo).toContain('receive');
    expect(row.items).toEqual([expect.objectContaining({ quantity: 3, description: 'Barrels' })]);
    // A projection for the window: no cost, margin or customer file.
    expect(JSON.stringify(row)).not.toMatch(/cost|margin|customerId|creditLimit/i);
    // Expected is the default; received lists none yet; search finds by number.
    expect(
      (
        (await as(on, cookies.staffA!).get('/window-desk/expected', { status: 'received' }))
          .body as WindowDeskBookingDto[]
      ).map((r) => r.bookingId),
    ).not.toContain(mine.id);
    const found = (await as(on, cookies.staffA!).get('/window-desk/expected', { q: mine.number }))
      .body as WindowDeskBookingDto[];
    expect(found.map((r) => r.bookingId)).toEqual([mine.id]);
    // The sender shown is the customer (no shipper): its phone finds the booking.
    const customerPhone = (
      await on.prisma.customer.findUniqueOrThrow({
        where: { id: ids.customer },
        select: { phone: true },
      })
    ).phone!;
    const byPhone = (
      await as(on, cookies.staffA!).get('/window-desk/expected', { q: customerPhone })
    ).body as WindowDeskBookingDto[];
    expect(byPhone.map((r) => r.bookingId)).toContain(mine.id);
  });

  it("opens only its own windows' confirmed bookings", async () => {
    const one = (await as(on, cookies.staffA!).get(`/window-desk/bookings/${ids.mine}`).expect(200))
      .body as WindowDeskBookingDto;
    expect(one.bookingId).toBe(ids.mine);
    await as(on, cookies.staffA!).get(`/window-desk/bookings/${ids.atB}`).expect(404);
    await as(on, cookies.staffA!).get(`/window-desk/bookings/${ids.draft}`).expect(404);
    await as(on, cookies.staffA!).get(`/window-desk/bookings/${randomUUID()}`).expect(404);
    // Section 2a: the booking another outlet sold opens on the desk, and nowhere else.
    await as(on, cookies.staffA!).get(`/window-desk/bookings/${ids.soldByB}`).expect(200);
    await as(on, cookies.staffA!).get(`/bookings/${ids.soldByB}`).expect(404);
    await as(on, cookies.staffA!).get(`/customers/${ids.customer}`).expect(404);
  });

  it('reads what the customer owes: total less paid less credited; no cancelled invoice', async () => {
    const shipment = await on.prisma.shipment.findUniqueOrThrow({
      where: { bookingId: ids.mine },
      select: { id: true },
    });
    // Any invoice confirmation made is set aside, so the one written here is the MAIN one.
    await on.prisma.customerInvoice.updateMany({
      where: { shipmentId: shipment.id, status: 'DRAFT' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'test' },
    });
    const day = new Date('2026-11-05');
    const invoice = await on.prisma.customerInvoice.create({
      data: {
        branchId: jed,
        customerId: ids.customer!,
        shipmentId: shipment.id,
        kind: 'MAIN',
        currency: 'SAR',
        fxRate: '3.75',
        invoiceDate: day,
        dueDate: day,
        total: '100',
        totalUsd: '26.6667',
        paidAmount: '20',
        paidUsd: '5.3333',
        creditedAmount: '30',
        creditedUsd: '8',
        createdById: ids.creator!,
      },
    });
    const read = async () =>
      (await as(on, cookies.staffA!).get(`/window-desk/bookings/${ids.mine}`).expect(200))
        .body as WindowDeskBookingDto;
    expect((await read()).invoice).toMatchObject({ total: '100', balance: '50', currency: 'SAR' });
    expect((await read()).todo).toContain('collect');
    await on.prisma.customerInvoice.update({
      where: { id: invoice.id },
      data: { paidAmount: '70', paidUsd: '18.6667' },
    });
    expect((await read()).invoice?.balance).toBe('0');
    expect((await read()).todo).not.toContain('collect');
    await on.prisma.customerInvoice.update({
      where: { id: invoice.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'test' },
    });
    expect((await read()).invoice).toBeNull();
  });

  it("hides a booking whose window is not the outlet's usable window of the booking's branch", async () => {
    const pts = await branchId(on.prisma, 'PTS');
    const make = async (data: object) =>
      (
        await on.prisma.warehouse.create({
          data: {
            branchId: jed,
            code: `${tag}-${randomUUID().slice(0, 4).toUpperCase()}`,
            nameAr: 'نافذة',
            nameEn: 'Window',
            acceptsDropOff: true,
            partnerId: ids.outletA,
            ...data,
          },
        })
      ).id;
    const outletC = await outlet('C');
    await on.prisma.userPartner.create({ data: { userId: ids.staffA!, partnerId: outletC } });
    const cases = {
      otherBranchWindow: await make({ branchId: pts }),
      inactive: await make({}),
      closed: await make({}),
      inactivePartner: await make({ partnerId: outletC }),
    };
    const moved: Record<string, string> = {};
    for (const [name, window] of Object.entries(cases)) {
      const b = await booking(ids.windowA!, true);
      await on.prisma.booking.update({ where: { id: b.id }, data: { dropOffWarehouseId: window } });
      moved[name] = b.id;
    }
    // A booking of a branch the user does not hold, at a window of that branch run by the outlet.
    const outside = await booking(ids.windowA!, true);
    await on.prisma.booking.update({
      where: { id: outside.id },
      data: { branchId: pts, dropOffWarehouseId: cases.otherBranchWindow },
    });
    moved.outsideBranch = outside.id;
    await on.prisma.warehouse.update({ where: { id: cases.inactive }, data: { isActive: false } });
    await on.prisma.warehouse.update({
      where: { id: cases.closed },
      data: { acceptsDropOff: false },
    });
    await on.prisma.partner.update({ where: { id: outletC }, data: { isActive: false } });
    const listed = (
      (await as(on, cookies.staffA!).get('/window-desk/expected', { status: 'all' }).expect(200))
        .body as WindowDeskBookingDto[]
    ).map((r) => r.bookingId);
    expect(listed).toContain(ids.mine);
    for (const [name, id] of Object.entries(moved)) {
      expect(listed, name).not.toContain(id);
      await as(on, cookies.staffA!).get(`/window-desk/bookings/${id}`).expect(404);
    }
  });

  it('is closed to everyone else, and while the switch is off', async () => {
    await as(on, cookies.sales!).get('/window-desk/expected').expect(403);
    await as(on, cookies.sales!).get(`/window-desk/bookings/${ids.mine}`).expect(403);
    await as(off, cookies.staffOff!).get('/window-desk/expected').expect(404);
    await as(off, cookies.staffOff!).get(`/window-desk/bookings/${ids.mine}`).expect(404);
  });

  it('shows nothing to a user whose outlet was removed after sign-in', async () => {
    await on.prisma.userPartner.deleteMany({ where: { userId: ids.staffA } });
    // Each request reads the user's outlets afresh, and the locked recheck inside the transaction
    // refuses one that changed while it runs (lockOutletsInTx): the window is no longer theirs.
    await as(on, cookies.staffA!).get(`/window-desk/bookings/${ids.mine}`).expect(404);
    const list = (await as(on, cookies.staffA!).get('/window-desk/expected').expect(200))
      .body as WindowDeskBookingDto[];
    expect(list).toEqual([]);
  });
});
