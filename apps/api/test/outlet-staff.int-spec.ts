import type {
  BookingDto,
  CustomerDto,
  Page,
  PartnerDto,
  PartnerSummaryDto,
  QuotationDto,
  ShipmentDocumentDto,
  ShipmentDto,
  ShipmentSummaryDto,
  UserSummary,
} from '@nolon/shared';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  PASSWORD,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, uniquePhone, waitForLockWaiter } from './test-data.js';
import type { Prisma } from '../src/generated/prisma/client.js';

// Outlet isolation (business model plan 4.2, condition ش1): an Outlet Staff user sees and writes
// only the customers, quotations, bookings, shipments and documents of their own outlet, even in
// their own branch; every route not built for the filter refuses them; assigning the role stays
// locked until the owner opens it.

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const FAR_FUTURE = '2099-12-31';

describe('outlet staff: isolation by sales outlet', () => {
  let t: TestApp;
  let jed: string;
  let dxb: string;
  let jeddahPort: string;
  let portSudan: string;
  let outletA: PartnerDto;
  let outletB: PartnerDto;
  let outletDxb: PartnerDto;
  let distributor: PartnerDto;
  const cookies = {
    admin: '',
    jedManager: '',
    dxbManager: '',
    salesJed: '',
    opsJed: '',
    staffA: '',
    staffB: '',
    staffNone: '',
  };
  let staffAId = '';

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const upload = (shipmentId: string, cookie: string) =>
    t
      .http()
      .post(`/api/v1/shipments/${shipmentId}/documents`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .field('typeCode', 'BL')
      .field('fileName', 'bl.pdf')
      .attach('file', PDF, 'upload.bin');

  const partner = async (kind: string, branch: string, cookie: string) =>
    (
      await post('/partners', cookie, {
        kind,
        branchId: branch,
        name: `ZZ ${kind} ${randomInt(1e9)}`,
        countryCode: 'SA',
        currency: 'SAR',
      }).expect(201)
    ).body as PartnerDto;

  /** An Outlet Staff user of JED for `outlets`, written directly (assignment is locked). */
  async function outletStaff(outlets: PartnerDto[]): Promise<{ id: string; cookie: string }> {
    const user = await createUser(t.prisma, ['OUTLET_STAFF'], ['JED']);
    for (const o of outlets) {
      await t.prisma.userPartner.create({ data: { userId: user.id, partnerId: o.id } });
    }
    return { id: user.id, cookie: await signIn(t, user.email) };
  }

  const newCustomer = async (cookie: string) =>
    (
      await post('/customers', cookie, {
        branchId: jed,
        kind: 'INDIVIDUAL',
        name: `ZZ outlet customer ${randomInt(1e9)}`,
        phone: uniquePhone(),
      }).expect(201)
    ).body as CustomerDto;

  const quotationBody = (customerId: string) => ({
    customerId,
    originLocationId: jeddahPort,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    currency: 'USD',
    validUntil: FAR_FUTURE,
    lines: [{ chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', unitPrice: '500', quantity: '1' }],
  });

  const bookingBody = (customerId: string) => ({
    customerId,
    originLocationId: jeddahPort,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    services: ['MAIN_FREIGHT'],
    items: [{ cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 1, weightKg: '9000' }],
  });

  beforeAll(async () => {
    t = await createTestApp();
    jed = await branchId(t.prisma, 'JED');
    dxb = await branchId(t.prisma, 'DXB');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    cookies.admin = await signIn(t, (await createUser(t.prisma, ['ADMINISTRATOR'])).email);
    cookies.jedManager = await signIn(
      t,
      (await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'])).email,
    );
    cookies.dxbManager = await signIn(
      t,
      (await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB'])).email,
    );
    cookies.salesJed = await signIn(t, (await createUser(t.prisma, ['SALES'], ['JED'])).email);
    cookies.opsJed = await signIn(t, (await createUser(t.prisma, ['OPERATIONS'], ['JED'])).email);
    outletA = await partner('SALES_OUTLET', jed, cookies.jedManager);
    outletB = await partner('SALES_OUTLET', jed, cookies.jedManager);
    outletDxb = await partner('SALES_OUTLET', dxb, cookies.dxbManager);
    distributor = await partner('DISTRIBUTOR', jed, cookies.jedManager);
    const a = await outletStaff([outletA]);
    staffAId = a.id;
    cookies.staffA = a.cookie;
    cookies.staffB = (await outletStaff([outletB])).cookie;
    cookies.staffNone = (await outletStaff([])).cookie;
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('keeps a customer with the outlet that brought it, hidden from the next outlet', async () => {
    const mine = await newCustomer(cookies.staffA);
    const row = await t.prisma.customer.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.acquiredViaOutletId).toBe(outletA.id);
    await get(`/customers/${mine.id}`, cookies.staffA).expect(200);
    await patch(`/customers/${mine.id}`, cookies.staffA, { name: 'ZZ renamed' }).expect(200);

    // Outlet B, same branch: not found, on every read and write.
    await get(`/customers/${mine.id}`, cookies.staffB).expect(404);
    await patch(`/customers/${mine.id}`, cookies.staffB, { name: 'ZZ taken' }).expect(404);
    await post(`/customers/${mine.id}/contacts`, cookies.staffB, {
      name: 'ZZ contact',
      phone: uniquePhone(),
    }).expect(404);
    await post(`/customers/${mine.id}/deactivate`, cookies.staffB).expect(404);
    const listB = (await get('/customers?pageSize=100', cookies.staffB).expect(200))
      .body as Page<CustomerSummaryLike>;
    expect(listB.items.some((c) => c.id === mine.id)).toBe(false);
    // An outlet user without an outlet sees nothing at all.
    const none = (await get('/customers?pageSize=100', cookies.staffNone).expect(200))
      .body as Page<CustomerSummaryLike>;
    expect(none.total).toBe(0);

    // The branch's own staff see it; the branch's customers without an outlet stay hidden from
    // outlet staff.
    await get(`/customers/${mine.id}`, cookies.salesJed).expect(200);
    const branchOwn = await newCustomer(cookies.salesJed);
    expect(
      (await t.prisma.customer.findUniqueOrThrow({ where: { id: branchOwn.id } }))
        .acquiredViaOutletId,
    ).toBeNull();
    await get(`/customers/${branchOwn.id}`, cookies.staffA).expect(404);
    const listA = (await get('/customers?pageSize=100', cookies.staffA).expect(200))
      .body as Page<CustomerSummaryLike>;
    expect(listA.items.map((c) => c.id)).toContain(mine.id);
    expect(listA.items.some((c) => c.id === branchOwn.id)).toBe(false);
  });

  it('keeps quotations with their outlet; another outlet’s customer cannot be quoted', async () => {
    const mine = await newCustomer(cookies.staffA);
    const theirs = await newCustomer(cookies.staffB);
    const quotation = (
      await post('/quotations', cookies.staffA, quotationBody(mine.id)).expect(201)
    ).body as QuotationDto;
    expect(
      (await t.prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).salesOutletId,
    ).toBe(outletA.id);
    await post('/quotations', cookies.staffA, quotationBody(theirs.id)).expect(404);
    await get(`/quotations/defaults?customerId=${theirs.id}`, cookies.staffA).expect(404);
    await get(`/quotations/${quotation.id}`, cookies.staffB).expect(404);
    const quotationEdit: Partial<ReturnType<typeof quotationBody>> = quotationBody(theirs.id);
    delete quotationEdit.customerId;
    await patch(`/quotations/${quotation.id}`, cookies.staffB, quotationEdit).expect(404);
    await post(`/quotations/${quotation.id}/send`, cookies.staffB).expect(404);
    const listB = (await get('/quotations?pageSize=100', cookies.staffB).expect(200)).body as Page<{
      id: string;
    }>;
    expect(listB.items.some((q) => q.id === quotation.id)).toBe(false);
    // Outlet staff never approve.
    await post(`/quotations/${quotation.id}/approve`, cookies.staffA).expect(403);
    await get(`/quotations/${quotation.id}`, cookies.salesJed).expect(200);
  });

  it('carries the outlet from quotation to booking to shipment, and keeps it there', async () => {
    const mine = await newCustomer(cookies.staffA);
    const quotation = (
      await post('/quotations', cookies.staffA, quotationBody(mine.id)).expect(201)
    ).body as QuotationDto;
    await post(`/quotations/${quotation.id}/send`, cookies.staffA).expect(200);
    await post(`/quotations/${quotation.id}/approve`, cookies.salesJed).expect(200);
    await get(`/bookings/from-quotation/${quotation.id}`, cookies.staffB).expect(404);
    // Booked by the branch's own staff from the outlet's quotation: still the outlet's sale.
    const booking = (
      await post(`/bookings/from-quotation/${quotation.id}`, cookies.salesJed, {
        services: ['MAIN_FREIGHT'],
        items: [
          { cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 1, weightKg: '9000' },
        ],
      }).expect(201)
    ).body as BookingDto;
    expect(
      (await t.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).salesOutletId,
    ).toBe(outletA.id);
    await get(`/bookings/${booking.id}`, cookies.staffA).expect(200);
    await get(`/bookings/${booking.id}`, cookies.staffB).expect(404);

    // A booking the outlet makes itself is theirs; outlet staff never confirm.
    const direct = (await post('/bookings', cookies.staffA, bookingBody(mine.id)).expect(201))
      .body as BookingDto;
    expect(
      (await t.prisma.booking.findUniqueOrThrow({ where: { id: direct.id } })).salesOutletId,
    ).toBe(outletA.id);
    await post(`/bookings/${direct.id}/confirm`, cookies.staffA).expect(403);
    const bookingEdit: Partial<ReturnType<typeof bookingBody>> = bookingBody(mine.id);
    delete bookingEdit.customerId;
    await patch(`/bookings/${direct.id}`, cookies.staffB, bookingEdit).expect(404);
    await get(`/bookings/party-suggestion?customerId=${mine.id}`, cookies.staffB).expect(404);
    const listB = (await get('/bookings?pageSize=100', cookies.staffB).expect(200)).body as Page<{
      id: string;
    }>;
    expect(listB.items.some((b) => b.id === direct.id || b.id === booking.id)).toBe(false);

    const confirmed = (await post(`/bookings/${direct.id}/confirm`, cookies.opsJed).expect(200))
      .body as BookingDto;
    const shipmentId = confirmed.shipmentId ?? '';
    expect(
      (await t.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).salesOutletId,
    ).toBe(outletA.id);
    // Tracking only: the outlet reads its shipment, the next outlet does not find it.
    const seen = (await get(`/shipments/${shipmentId}`, cookies.staffA).expect(200))
      .body as ShipmentDto;
    expect(seen.id).toBe(shipmentId);
    await patch(`/shipments/${shipmentId}`, cookies.staffA, { vesselName: 'ZZ' }).expect(403);
    await get(`/shipments/${shipmentId}`, cookies.staffB).expect(404);
    const listA = (await get('/shipments?pageSize=100', cookies.staffA).expect(200))
      .body as Page<ShipmentSummaryDto>;
    expect(listA.items.map((s) => s.id)).toContain(shipmentId);
    const listB2 = (await get('/shipments?pageSize=100', cookies.staffB).expect(200))
      .body as Page<ShipmentSummaryDto>;
    expect(listB2.items.some((s) => s.id === shipmentId)).toBe(false);

    // Documents follow the shipment.
    const doc = (await upload(shipmentId, cookies.staffA).expect(201)).body as ShipmentDocumentDto;
    await get(`/shipments/${shipmentId}/documents`, cookies.staffA).expect(200);
    await get(`/shipments/${shipmentId}/documents/${doc.id}/file`, cookies.staffA).expect(200);
    await get(`/shipments/${shipmentId}/documents`, cookies.staffB).expect(404);
    await get(`/shipments/${shipmentId}/documents/${doc.id}/file`, cookies.staffB).expect(404);
    await upload(shipmentId, cookies.staffB).expect(404);
  });

  it('shows outlet staff only their own outlet among the partners', async () => {
    const list = (await get('/partners?pageSize=100', cookies.staffA).expect(200))
      .body as Page<PartnerSummaryDto>;
    expect(list.items.map((p) => p.id)).toEqual([outletA.id]);
    await get(`/partners/${outletB.id}`, cookies.staffA).expect(404);
    await patch(`/partners/${outletA.id}`, cookies.staffA, { name: 'ZZ' }).expect(403);
  });

  it('refuses outlet staff every route not built for the outlet filter', async () => {
    // Routes their permissions would allow, but whose services do not filter by outlet.
    await get('/shipments/pick?q=SHP', cookies.staffA).expect(403);
    await get('/assistant-drafts/mine', cookies.staffA).expect(403);
    await get('/customers/import/template', cookies.staffA).expect(403);
    // Routes outside their permissions.
    await get('/customer-invoices', cookies.staffA).expect(403);
    await get('/reports/audit-log', cookies.staffA).expect(403);
    await get('/users', cookies.staffA).expect(403);
    // What they need to work.
    await get('/auth/me', cookies.staffA).expect(200);
    await get('/master-data', cookies.staffA).expect(200);
    await get('/rates', cookies.staffA).expect(200);
  });

  it('closes everything once their outlet is deactivated', async () => {
    const outlet = await partner('SALES_OUTLET', jed, cookies.jedManager);
    const staff = await outletStaff([outlet]);
    const customer = await newCustomer(staff.cookie);
    await patch(`/partners/${outlet.id}`, cookies.jedManager, { isActive: false }).expect(200);
    await get(`/customers/${customer.id}`, staff.cookie).expect(404);
    // With no active outlet, nothing new can be recorded either.
    await post('/customers', staff.cookie, {
      branchId: jed,
      kind: 'INDIVIDUAL',
      name: 'ZZ',
      phone: uniquePhone(),
    }).expect(403);
  });

  it('never names a customer of another outlet, or of the branch, in a duplicate refusal', async () => {
    const mine = await newCustomer(cookies.staffA);
    await patch(`/customers/${mine.id}`, cookies.staffA, { taxNumber: `ZZTX${randomInt(1e9)}` });
    const held = await t.prisma.customer.findUniqueOrThrow({ where: { id: mine.id } });
    const branchOwn = await newCustomer(cookies.salesJed);
    const taxed = `ZZTX${randomInt(1e9)}`;
    await patch(`/customers/${branchOwn.id}`, cookies.salesJed, { taxNumber: taxed }).expect(200);
    const message = (res: { body: unknown }) => (res.body as { message: string }).message;
    const create = (cookie: string, extra: object) =>
      post('/customers', cookie, {
        branchId: jed,
        kind: 'INDIVIDUAL',
        name: `ZZ duplicate ${randomInt(1e9)}`,
        phone: uniquePhone(),
        ...extra,
      });

    // Create: outlet B is refused (the value stays unique in the branch) without learning whose.
    for (const [extra, field] of [
      [{ phone: held.phone }, 'phone'],
      [{ taxNumber: held.taxNumber }, 'tax number'],
      [{ phone: branchOwn.phone }, 'phone'],
      [{ taxNumber: taxed }, 'tax number'],
    ] as const) {
      const refused = await create(cookies.staffB, extra).expect(409);
      expect(message(refused)).toBe(`Another customer of this branch has this ${field}`);
      expect(JSON.stringify(refused.body)).not.toMatch(/CS\d/);
    }
    // Update: the same, on a customer of outlet B.
    const theirs = await newCustomer(cookies.staffB);
    for (const body of [
      { phone: held.phone },
      { taxNumber: held.taxNumber },
      { phone: branchOwn.phone },
      { taxNumber: taxed },
    ]) {
      const refused = await patch(`/customers/${theirs.id}`, cookies.staffB, body).expect(409);
      expect(message(refused)).toMatch(/^Another customer of this branch has this /);
      expect(JSON.stringify(refused.body)).not.toMatch(/CS\d/);
    }
    // Their own outlet's customer, and the branch's staff: named as before.
    expect(message(await create(cookies.staffA, { phone: held.phone }).expect(409))).toBe(
      `Customer ${held.number} of this branch has this phone`,
    );
    expect(message(await create(cookies.salesJed, { taxNumber: taxed }).expect(409))).toBe(
      `Customer ${branchOwn.number} of this branch has this tax number`,
    );
  });

  describe('a write queued while the outlet is taken away', () => {
    /**
     * Runs `revoke` in a transaction that stays open until `write` (signed in before, so its
     * sign-in snapshot still names the outlet) waits on its locks, then commits it: the revocation
     * wins serialization, and the write must see it.
     */
    async function queuedBehind<T>(
      revoke: (tx: Prisma.TransactionClient) => Promise<void>,
      write: () => PromiseLike<T>,
    ): Promise<T> {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let holding = () => {};
      const holdingNow = new Promise<void>((resolve) => (holding = resolve));
      const holder = t.prisma.$transaction(
        async (tx) => {
          await revoke(tx);
          holding();
          await held;
        },
        { timeout: 20_000 },
      );
      await holdingNow;
      const result = Promise.resolve(write());
      await waitForLockWaiter(t.prisma);
      release();
      await holder;
      return result;
    }

    const deactivate = (outlet: PartnerDto) => async (tx: Prisma.TransactionClient) => {
      await tx.partner.update({ where: { id: outlet.id }, data: { isActive: false } });
    };
    const reassign =
      (userId: string, from: PartnerDto, to: PartnerDto) =>
      async (tx: Prisma.TransactionClient) => {
        await tx.userPartner.delete({
          where: { userId_partnerId: { userId, partnerId: from.id } },
        });
        await tx.userPartner.create({ data: { userId, partnerId: to.id } });
      };

    /** A fresh outlet with its own Outlet Staff user, a customer and a draft quotation. */
    async function freshOutlet() {
      const outlet = await partner('SALES_OUTLET', jed, cookies.jedManager);
      const staff = await outletStaff([outlet]);
      const customer = await newCustomer(staff.cookie);
      const quotation = (
        await post('/quotations', staff.cookie, quotationBody(customer.id)).expect(201)
      ).body as QuotationDto;
      return { outlet, staff, customer, quotation };
    }

    it('refuses a customer create once the outlet is deactivated', async () => {
      const { outlet, staff } = await freshOutlet();
      const name = `ZZ queued ${randomInt(1e9)}`;
      const res = await queuedBehind(deactivate(outlet), () =>
        post('/customers', staff.cookie, {
          branchId: jed,
          kind: 'INDIVIDUAL',
          name,
          phone: uniquePhone(),
        }),
      );
      expect(res.status).toBe(403);
      expect(await t.prisma.customer.count({ where: { name } })).toBe(0);
    });

    it('refuses a customer create once the user is moved to another outlet', async () => {
      const { outlet, staff } = await freshOutlet();
      const other = await partner('SALES_OUTLET', jed, cookies.jedManager);
      const name = `ZZ queued ${randomInt(1e9)}`;
      const res = await queuedBehind(reassign(staff.id, outlet, other), () =>
        post('/customers', staff.cookie, {
          branchId: jed,
          kind: 'INDIVIDUAL',
          name,
          phone: uniquePhone(),
        }),
      );
      expect(res.status).toBe(403);
      expect(await t.prisma.customer.count({ where: { name } })).toBe(0);
    });

    it('refuses customer edits, contacts and deactivation of the old outlet’s customer', async () => {
      const { outlet, staff, customer } = await freshOutlet();
      const other = await partner('SALES_OUTLET', jed, cookies.jedManager);
      const renamed = await queuedBehind(reassign(staff.id, outlet, other), () =>
        patch(`/customers/${customer.id}`, staff.cookie, { name: 'ZZ renamed late' }),
      );
      expect(renamed.status).toBe(404);
      const row = await t.prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(row.name).toBe(customer.name);

      const second = await freshOutlet();
      const contact = await queuedBehind(deactivate(second.outlet), () =>
        post(`/customers/${second.customer.id}/contacts`, second.staff.cookie, {
          name: 'ZZ contact',
          phone: uniquePhone(),
        }),
      );
      expect(contact.status).toBe(404);
      expect(
        await t.prisma.customerContact.count({ where: { customerId: second.customer.id } }),
      ).toBe(0);

      const third = await freshOutlet();
      const off = await queuedBehind(deactivate(third.outlet), () =>
        post(`/customers/${third.customer.id}/deactivate`, third.staff.cookie),
      );
      expect(off.status).toBe(404);
      expect(
        (await t.prisma.customer.findUniqueOrThrow({ where: { id: third.customer.id } })).isActive,
      ).toBe(true);
    });

    it('refuses quotation and booking creates, edits and sends', async () => {
      const a = await freshOutlet();
      const quoted = await queuedBehind(deactivate(a.outlet), () =>
        post('/quotations', a.staff.cookie, quotationBody(a.customer.id)),
      );
      expect(quoted.status).toBe(403);
      expect(await t.prisma.quotation.count({ where: { customerId: a.customer.id } })).toBe(1);

      const b = await freshOutlet();
      const booked = await queuedBehind(deactivate(b.outlet), () =>
        post('/bookings', b.staff.cookie, bookingBody(b.customer.id)),
      );
      expect(booked.status).toBe(403);
      expect(await t.prisma.booking.count({ where: { customerId: b.customer.id } })).toBe(0);

      // Moved to another outlet: the new outlet cannot sell to the old outlet's customer either.
      const c = await freshOutlet();
      const other = await partner('SALES_OUTLET', jed, cookies.jedManager);
      const crossed = await queuedBehind(reassign(c.staff.id, c.outlet, other), () =>
        post('/bookings', c.staff.cookie, bookingBody(c.customer.id)),
      );
      expect(crossed.status).toBe(403);
      expect(await t.prisma.booking.count({ where: { customerId: c.customer.id } })).toBe(0);

      const d = await freshOutlet();
      const sent = await queuedBehind(deactivate(d.outlet), () =>
        post(`/quotations/${d.quotation.id}/send`, d.staff.cookie),
      );
      expect(sent.status).toBe(404);
      expect(
        (await t.prisma.quotation.findUniqueOrThrow({ where: { id: d.quotation.id } })).status,
      ).toBe('DRAFT');

      const e = await freshOutlet();
      const edit: Partial<ReturnType<typeof quotationBody>> = quotationBody(e.customer.id);
      delete edit.customerId;
      const edited = await queuedBehind(deactivate(e.outlet), () =>
        patch(`/quotations/${e.quotation.id}`, e.staff.cookie, {
          ...edit,
          lines: [{ ...edit.lines?.[0], unitPrice: '999' }],
        }),
      );
      expect(edited.status).toBe(404);
      const lines = await t.prisma.quotationLine.findMany({
        where: { quotationId: e.quotation.id },
      });
      expect(lines.map((l) => l.unitPrice.toString())).toEqual(['500']);

      const f = await freshOutlet();
      const draft = (
        await post('/bookings', f.staff.cookie, bookingBody(f.customer.id)).expect(201)
      ).body as BookingDto;
      const bookingEdit: Partial<ReturnType<typeof bookingBody>> = bookingBody(f.customer.id);
      delete bookingEdit.customerId;
      const rebooked = await queuedBehind(deactivate(f.outlet), () =>
        patch(`/bookings/${draft.id}`, f.staff.cookie, {
          ...bookingEdit,
          items: [{ ...bookingEdit.items?.[0], quantity: 2 }],
        }),
      );
      expect(rebooked.status).toBe(404);
      const items = await t.prisma.bookingItem.findMany({ where: { bookingId: draft.id } });
      expect(items.map((i) => i.quantity)).toEqual([1]);
    });

    it('refuses a document upload on the outlet’s shipment', async () => {
      const g = await freshOutlet();
      const direct = (
        await post('/bookings', g.staff.cookie, bookingBody(g.customer.id)).expect(201)
      ).body as BookingDto;
      const confirmed = (await post(`/bookings/${direct.id}/confirm`, cookies.opsJed).expect(200))
        .body as BookingDto;
      const shipmentId = confirmed.shipmentId ?? '';
      const res = await queuedBehind(deactivate(g.outlet), () =>
        upload(shipmentId, g.staff.cookie),
      );
      expect(res.status).toBe(404);
      expect(await t.prisma.document.count({ where: { shipmentId } })).toBe(0);
    });
  });

  describe('assigning the role', () => {
    const userBody = (overrides: object = {}) => ({
      email: `it-${randomInt(1e9)}@nolon.test`,
      fullName: 'ZZ outlet user',
      password: PASSWORD,
      preferredLocale: 'ar',
      roles: ['OUTLET_STAFF'],
      branchIds: [jed],
      outletIds: [outletA.id],
      ...overrides,
    });

    it('is locked until the owner opens it; a user who holds it keeps it', async () => {
      const refused = await post('/users', cookies.admin, userBody()).expect(400);
      expect((refused.body as { message: string }).message).toMatch(/not open yet/);
      const sales = (
        await post('/users', cookies.admin, userBody({ roles: ['SALES'], outletIds: [] })).expect(
          201,
        )
      ).body as UserSummary;
      await patch(`/users/${sales.id}`, cookies.admin, { roles: ['OUTLET_STAFF'] }).expect(400);
      // Outlets belong to the Outlet Staff role only.
      await post('/users', cookies.admin, userBody({ roles: ['SALES'] })).expect(400);
      // An existing Outlet Staff user (assigned while open) can still be renamed.
      const renamed = (
        await patch(`/users/${staffAId}`, cookies.admin, { fullName: 'ZZ renamed' }).expect(200)
      ).body as UserSummary;
      expect(renamed).toMatchObject({ roles: ['OUTLET_STAFF'], outletIds: [outletA.id] });
    });

    it('once open: one role, one branch, one active sales outlet of that branch', async () => {
      const open = await createTestApp({ OUTLET_STAFF_ASSIGNABLE: true });
      try {
        const admin = await signIn(open, (await createUser(open.prisma, ['ADMINISTRATOR'])).email);
        const send = (body: object) =>
          open
            .http()
            .post('/api/v1/users')
            .set('Origin', APP_ORIGIN)
            .set('Cookie', admin)
            .send(body);
        await send(userBody({ roles: ['OUTLET_STAFF', 'FINANCE'] })).expect(400);
        await send(userBody({ branchIds: [jed, dxb] })).expect(400);
        await send(userBody({ outletIds: [] })).expect(400);
        await send(userBody({ outletIds: [outletA.id, outletB.id] })).expect(400);
        await send(userBody({ outletIds: [outletDxb.id] })).expect(400);
        await send(userBody({ outletIds: [distributor.id] })).expect(400);
        const created = (await send(userBody()).expect(201)).body as UserSummary;
        expect(created).toMatchObject({ roles: ['OUTLET_STAFF'], outletIds: [outletA.id] });
        // Leaving the role drops the outlets.
        const moved = (
          await open
            .http()
            .patch(`/api/v1/users/${created.id}`)
            .set('Origin', APP_ORIGIN)
            .set('Cookie', admin)
            .send({ roles: ['SALES'] })
            .expect(200)
        ).body as UserSummary;
        expect(moved).toMatchObject({ roles: ['SALES'], outletIds: [] });
      } finally {
        await open.close();
      }
    });
  });
});

interface CustomerSummaryLike {
  id: string;
}
