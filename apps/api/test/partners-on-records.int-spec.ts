import type { BookingDto, CustomerDto, PartnerDto, QuotationDto, ShipmentDto } from '@nolon/shared';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_PREFIX,
  draftKey,
  registerClient,
  requests,
  tokenFor,
} from './agent-drafts-helpers.js';
import {
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

// Business model PR-3 (docs/plans/02-business-model-batch-1.md 3.3, 7.2): the sales outlet on a
// customer, quotation, booking and shipment, each booking line's price category, the customer's
// segment, and the shipment's origin consolidator and distributor. Set from NOLON's screens only:
// a record names an active partner of the right kind of its own branches, Outlet Staff record
// their own outlet only, and assistant drafts take none of these fields.

const FAR_FUTURE = '2099-12-31';

/** The body without one of its keys. */
function without<T extends object, K extends keyof T>(body: T, key: K): Omit<T, K> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

describe('partners named on customers, quotations, bookings and shipments', () => {
  let t: TestApp;
  let r: ReturnType<typeof requests>;
  let jed: string;
  let dxb: string;
  let jeddahPort: string;
  let portSudan: string;
  const outlets: Record<'a' | 'b' | 'dxb' | 'inactive', PartnerDto> = {} as never;
  let consolidator: PartnerDto;
  let distributor: PartnerDto;
  let distributorDxb: PartnerDto;
  const cookies = {
    admin: '',
    jedManager: '',
    dxbManager: '',
    salesJed: '',
    opsJed: '',
    staffA: '',
  };
  const tokens = { sales: '' };

  const partner = async (kind: string, branch: string, cookie: string) =>
    (
      await r
        .post('/partners', cookie, {
          kind,
          branchId: branch,
          name: `ZZ ${kind} ${randomInt(1e9)}`,
          countryCode: 'SA',
          currency: 'SAR',
        })
        .expect(201)
    ).body as PartnerDto;

  const customerBody = (extra: object = {}) => ({
    branchId: jed,
    kind: 'INDIVIDUAL',
    name: `ZZ partner customer ${randomInt(1e9)}`,
    phone: uniquePhone(),
    ...extra,
  });
  const newCustomer = async (cookie = cookies.salesJed, extra: object = {}) =>
    (await r.post('/customers', cookie, customerBody(extra)).expect(201)).body as CustomerDto;

  const quotationBody = (customerId: string, extra: object = {}) => ({
    customerId,
    originLocationId: jeddahPort,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'LCL',
    cargoType: 'GENERAL',
    currency: 'USD',
    validUntil: FAR_FUTURE,
    lines: [{ chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', unitPrice: '500', quantity: '1' }],
    ...extra,
  });
  /** The quotation as an edit sends it (no customer). */
  const quotationEdit = () => without(quotationBody(''), 'customerId');

  const bookingBody = (customerId: string, extra: object = {}) => ({
    customerId,
    originLocationId: jeddahPort,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'LCL',
    cargoType: 'GENERAL',
    services: ['MAIN_FREIGHT'],
    items: [{ cargoType: 'GENERAL', quantity: 10, weightKg: '100' }],
    ...extra,
  });

  const refusal = (body: unknown) => body as { code?: string; fields?: string[] };

  beforeAll(async () => {
    t = await createTestApp();
    r = requests(t);
    jed = await branchId(t.prisma, 'JED');
    dxb = await branchId(t.prisma, 'DXB');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    cookies.admin = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX)).email,
    );
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
    outlets.a = await partner('SALES_OUTLET', jed, cookies.jedManager);
    outlets.b = await partner('SALES_OUTLET', jed, cookies.jedManager);
    outlets.dxb = await partner('SALES_OUTLET', dxb, cookies.dxbManager);
    outlets.inactive = await partner('SALES_OUTLET', jed, cookies.jedManager);
    await r.patch(`/partners/${outlets.inactive.id}`, cookies.jedManager, { isActive: false });
    consolidator = await partner('ORIGIN_CONSOLIDATOR', jed, cookies.jedManager);
    distributor = await partner('DISTRIBUTOR', jed, cookies.jedManager);
    distributorDxb = await partner('DISTRIBUTOR', dxb, cookies.dxbManager);
    // Outlet Staff of outlet A, written directly (assignment is locked until the owner opens it).
    const staff = await createUser(t.prisma, ['OUTLET_STAFF'], ['JED']);
    await t.prisma.userPartner.create({ data: { userId: staff.id, partnerId: outlets.a.id } });
    cookies.staffA = await signIn(t, staff.email);
    const client = await registerClient(t, cookies.admin, 'Partners on records platform');
    const agentSales = await createUser(t.prisma, ['SALES'], ['JED'], AGENT_PREFIX);
    tokens.sales = await tokenFor(t, await signIn(t, agentSales.email), client);
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('customer: segment and the outlet that brought it', () => {
    it('records both from the screen, and changes or clears them', async () => {
      const created = await newCustomer(cookies.salesJed, {
        segmentCode: 'merchant',
        acquiredViaOutletId: outlets.a.id,
      });
      expect(created.segmentCode).toBe('MERCHANT');
      expect(created.acquiredViaOutlet).toEqual({
        id: outlets.a.id,
        number: outlets.a.number,
        name: outlets.a.name,
        isActive: true,
      });
      const moved = (
        await r
          .patch(`/customers/${created.id}`, cookies.salesJed, {
            acquiredViaOutletId: outlets.b.id,
            segmentCode: 'BUSINESS',
          })
          .expect(200)
      ).body as CustomerDto;
      expect([moved.acquiredViaOutlet?.id, moved.segmentCode]).toEqual([outlets.b.id, 'BUSINESS']);
      // Omitted: kept; null: cleared.
      const renamed = (
        await r.patch(`/customers/${created.id}`, cookies.salesJed, { notes: 'x' }).expect(200)
      ).body as CustomerDto;
      expect(renamed.acquiredViaOutlet?.id).toBe(outlets.b.id);
      const cleared = (
        await r
          .patch(`/customers/${created.id}`, cookies.salesJed, {
            acquiredViaOutletId: null,
            segmentCode: null,
          })
          .expect(200)
      ).body as CustomerDto;
      expect([cleared.acquiredViaOutlet, cleared.segmentCode]).toEqual([null, null]);
      const audit = await t.prisma.auditEvent.findFirstOrThrow({
        where: { entity: 'CUSTOMER', entityId: created.id, action: 'UPDATED' },
        orderBy: { id: 'asc' },
      });
      expect(JSON.stringify(audit.changes)).toContain('acquiredViaOutletId');
    });

    it('refuses an outlet of another branch, an inactive one, another kind, and an unknown segment', async () => {
      for (const id of [outlets.dxb.id, outlets.inactive.id, distributor.id, randomUUID()]) {
        const res = await r
          .post('/customers', cookies.salesJed, customerBody({ acquiredViaOutletId: id }))
          .expect(400);
        expect(refusal(res.body)).toMatchObject({
          code: 'PARTNER_NOT_USABLE',
          fields: ['acquiredViaOutletId'],
        });
      }
      const res = await r
        .post('/customers', cookies.salesJed, customerBody({ segmentCode: 'NOPE' }))
        .expect(400);
      expect(refusal(res.body)).toMatchObject({
        code: 'CUSTOMER_SEGMENT_NOT_USABLE',
        fields: ['segmentCode'],
      });
    });

    it('keeps an outlet the customer holds after the outlet is deactivated', async () => {
      const outlet = await partner('SALES_OUTLET', jed, cookies.jedManager);
      const customer = await newCustomer(cookies.salesJed, { acquiredViaOutletId: outlet.id });
      await r.patch(`/partners/${outlet.id}`, cookies.jedManager, { isActive: false }).expect(200);
      const edited = (
        await r
          .patch(`/customers/${customer.id}`, cookies.salesJed, {
            notes: 'still theirs',
            acquiredViaOutletId: outlet.id,
          })
          .expect(200)
      ).body as CustomerDto;
      expect(edited.acquiredViaOutlet).toMatchObject({ id: outlet.id, isActive: false });
    });

    it('lets Outlet Staff record their own outlet only (403 for any other, or none)', async () => {
      const own = await newCustomer(cookies.staffA, { acquiredViaOutletId: outlets.a.id });
      expect(own.acquiredViaOutlet?.id).toBe(outlets.a.id);
      for (const acquiredViaOutletId of [outlets.b.id, null]) {
        await r
          .post('/customers', cookies.staffA, customerBody({ acquiredViaOutletId }))
          .expect(403);
        await r.patch(`/customers/${own.id}`, cookies.staffA, { acquiredViaOutletId }).expect(403);
      }
      const row = await t.prisma.customer.findUniqueOrThrow({ where: { id: own.id } });
      expect(row.acquiredViaOutletId).toBe(outlets.a.id);
    });
  });

  describe('quotation and booking: the sales outlet, and each cargo line’s category', () => {
    it('records a quotation’s outlet, changes and clears it on a draft', async () => {
      const customer = await newCustomer();
      const quotation = (
        await r
          .post(
            '/quotations',
            cookies.salesJed,
            quotationBody(customer.id, { salesOutletId: outlets.a.id }),
          )
          .expect(201)
      ).body as QuotationDto;
      expect(quotation.salesOutlet?.id).toBe(outlets.a.id);
      const kept = (
        await r.patch(`/quotations/${quotation.id}`, cookies.salesJed, quotationEdit()).expect(200)
      ).body as QuotationDto;
      expect(kept.salesOutlet?.id).toBe(outlets.a.id);
      const moved = (
        await r
          .patch(`/quotations/${quotation.id}`, cookies.salesJed, {
            ...quotationEdit(),
            salesOutletId: outlets.b.id,
          })
          .expect(200)
      ).body as QuotationDto;
      expect(moved.salesOutlet?.id).toBe(outlets.b.id);
      const res = await r
        .patch(`/quotations/${quotation.id}`, cookies.salesJed, {
          ...quotationEdit(),
          salesOutletId: outlets.dxb.id,
        })
        .expect(400);
      expect(refusal(res.body)).toMatchObject({
        code: 'PARTNER_NOT_USABLE',
        fields: ['salesOutletId'],
      });
      const cleared = (
        await r
          .patch(`/quotations/${quotation.id}`, cookies.salesJed, {
            ...quotationEdit(),
            salesOutletId: null,
          })
          .expect(200)
      ).body as QuotationDto;
      expect(cleared.salesOutlet).toBeNull();
    });

    it('refuses another outlet from Outlet Staff on a quotation or a booking', async () => {
      const customer = await newCustomer(cookies.staffA);
      await r
        .post(
          '/quotations',
          cookies.staffA,
          quotationBody(customer.id, { salesOutletId: outlets.b.id }),
        )
        .expect(403);
      await r
        .post(
          '/bookings',
          cookies.staffA,
          bookingBody(customer.id, { salesOutletId: outlets.b.id }),
        )
        .expect(403);
      const own = (
        await r
          .post(
            '/bookings',
            cookies.staffA,
            bookingBody(customer.id, { salesOutletId: outlets.a.id }),
          )
          .expect(201)
      ).body as BookingDto;
      expect(own.salesOutlet?.id).toBe(outlets.a.id);
    });

    it('records a category of the line’s cargo type on each booking line', async () => {
      const customer = await newCustomer();
      const booking = (
        await r
          .post(
            '/bookings',
            cookies.salesJed,
            bookingBody(customer.id, {
              salesOutletId: outlets.a.id,
              items: [
                { cargoType: 'GENERAL', quantity: 10, priceCategoryCode: 'carton' },
                { cargoType: 'PALLET', quantity: 2, priceCategoryCode: 'PALLET' },
                { cargoType: 'GENERAL', quantity: 1 },
              ],
            }),
          )
          .expect(201)
      ).body as BookingDto;
      expect(booking.salesOutlet?.id).toBe(outlets.a.id);
      expect(booking.items.map((i) => i.priceCategoryCode)).toEqual(['CARTON', 'PALLET', null]);
      for (const priceCategoryCode of ['BARREL', 'NOPE']) {
        const res = await r
          .post(
            '/bookings',
            cookies.salesJed,
            bookingBody(customer.id, {
              items: [
                { cargoType: 'GENERAL', quantity: 1 },
                { cargoType: 'GENERAL', quantity: 1, priceCategoryCode },
              ],
            }),
          )
          .expect(400);
        expect(refusal(res.body)).toMatchObject({
          code: 'PRICE_CATEGORY_NOT_USABLE',
          fields: ['items.1.priceCategoryCode'],
        });
      }
    });

    it('keeps the quotation’s outlet on a booking made from it, through to the shipment', async () => {
      const customer = await newCustomer();
      const quotation = (
        await r
          .post(
            '/quotations',
            cookies.salesJed,
            quotationBody(customer.id, { salesOutletId: outlets.a.id }),
          )
          .expect(201)
      ).body as QuotationDto;
      await r.post(`/quotations/${quotation.id}/send`, cookies.salesJed).expect(200);
      await r.post(`/quotations/${quotation.id}/approve`, cookies.jedManager).expect(200);
      const booking = (
        await r
          .post(`/bookings/from-quotation/${quotation.id}`, cookies.salesJed, {
            items: [{ cargoType: 'GENERAL', quantity: 4, priceCategoryCode: 'CARTON' }],
          })
          .expect(201)
      ).body as BookingDto;
      expect([booking.salesOutlet?.id, booking.items[0]?.priceCategoryCode]).toEqual([
        outlets.a.id,
        'CARTON',
      ]);
      const edit = without(bookingBody(customer.id), 'customerId');
      const res = await r
        .patch(`/bookings/${booking.id}`, cookies.salesJed, {
          ...edit,
          salesOutletId: outlets.b.id,
        })
        .expect(400);
      expect(refusal(res.body)).toMatchObject({
        code: 'QUOTED_OUTLET_FIXED',
        fields: ['salesOutletId'],
      });
      await r
        .patch(`/bookings/${booking.id}`, cookies.salesJed, {
          ...edit,
          salesOutletId: outlets.a.id,
        })
        .expect(200);
      const confirmed = (
        await r.post(`/bookings/${booking.id}/confirm`, cookies.opsJed).expect(200)
      ).body as BookingDto;
      const shipment = (
        await r.get(`/shipments/${confirmed.shipmentId}`, cookies.opsJed).expect(200)
      ).body as ShipmentDto;
      expect(shipment.salesOutlet?.id).toBe(outlets.a.id);
    });
  });

  describe('shipment: origin consolidator and distributor', () => {
    async function shipment(): Promise<ShipmentDto> {
      const customer = await newCustomer();
      const booking = (
        await r.post('/bookings', cookies.salesJed, bookingBody(customer.id)).expect(201)
      ).body as BookingDto;
      const confirmed = (
        await r.post(`/bookings/${booking.id}/confirm`, cookies.opsJed).expect(200)
      ).body as BookingDto;
      return (await r.get(`/shipments/${confirmed.shipmentId}`, cookies.opsJed).expect(200))
        .body as ShipmentDto;
    }

    it('names partners of the right kind of the shipment’s branches, and keeps one it holds', async () => {
      const s = await shipment();
      const set = (body: object, cookie = cookies.opsJed) =>
        r.patch(`/shipments/${s.id}`, cookie, body);
      const named = (
        await set({ originConsolidatorId: consolidator.id, distributorId: distributor.id }).expect(
          200,
        )
      ).body as ShipmentDto;
      expect([named.originConsolidator?.id, named.distributor?.id]).toEqual([
        consolidator.id,
        distributor.id,
      ]);
      // Wrong kind, or a partner of a branch not working on the shipment.
      for (const body of [
        { originConsolidatorId: distributor.id },
        { distributorId: outlets.a.id },
      ]) {
        const res = await set(body).expect(400);
        expect(refusal(res.body).code).toBe('PARTNER_NOT_USABLE');
      }
      expect(
        refusal((await set({ distributorId: distributorDxb.id }, cookies.admin).expect(400)).body),
      ).toMatchObject({ code: 'PARTNER_NOT_USABLE', fields: ['distributorId'] });
      // Once DXB shares the shipment, its distributor may be named (by a user of DXB too).
      await set({ sharedBranchIds: [dxb] }, cookies.jedManager).expect(200);
      const shared = (
        await set({ distributorId: distributorDxb.id }, cookies.dxbManager).expect(200)
      ).body as ShipmentDto;
      expect(shared.distributor?.id).toBe(distributorDxb.id);
      // Held after deactivation; an unrelated edit keeps it; null removes it.
      await r
        .patch(`/partners/${consolidator.id}`, cookies.jedManager, { isActive: false })
        .expect(200);
      const kept = (
        await set({ carrierName: 'ZZ Line', originConsolidatorId: consolidator.id }).expect(200)
      ).body as ShipmentDto;
      expect(kept.originConsolidator).toMatchObject({ id: consolidator.id, isActive: false });
      const removed = (await set({ originConsolidatorId: null }).expect(200)).body as ShipmentDto;
      expect(removed.originConsolidator).toBeNull();
      await r
        .patch(`/partners/${consolidator.id}`, cookies.jedManager, { isActive: true })
        .expect(200);
      // Outlet Staff never edit a shipment.
      await set({ distributorId: distributor.id }, cookies.staffA).expect(403);
    });
  });

  describe('assistant drafts take none of the new fields (plan 7.2)', () => {
    it('refuses them on quotation, booking and customer drafts', async () => {
      const customer = await newCustomer();
      const quotation = without(quotationBody(customer.id), 'customerId');
      const quotationDraft = { idempotencyKey: draftKey(), customerId: customer.id, ...quotation };
      await r.agentPost('/quotation-drafts/check', tokens.sales, quotationDraft).expect(200);
      await r
        .agentPost('/quotation-drafts', tokens.sales, {
          ...quotationDraft,
          salesOutletId: outlets.a.id,
        })
        .expect(400);
      const bookingDraft = { idempotencyKey: draftKey(), ...bookingBody(customer.id) };
      await r.agentPost('/booking-drafts/check', tokens.sales, bookingDraft).expect(200);
      await r
        .agentPost('/booking-drafts', tokens.sales, {
          ...bookingDraft,
          salesOutletId: outlets.a.id,
        })
        .expect(400);
      await r
        .agentPost('/booking-drafts', tokens.sales, {
          ...bookingDraft,
          items: [{ cargoType: 'GENERAL', quantity: 1, priceCategoryCode: 'CARTON' }],
        })
        .expect(400);
      const customerDraft = {
        idempotencyKey: draftKey(),
        branchId: jed,
        kind: 'INDIVIDUAL',
        name: 'ZZ draft customer',
        phone: uniquePhone(),
      };
      for (const extra of [{ segmentCode: 'MERCHANT' }, { acquiredViaOutletId: outlets.a.id }]) {
        await r
          .agentPost('/customer-drafts', tokens.sales, { ...customerDraft, ...extra })
          .expect(400);
      }
    });
  });
});
