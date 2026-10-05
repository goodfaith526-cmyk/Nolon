import { randomInt } from 'node:crypto';
import type {
  AuditLogDto,
  BookingDto,
  CustomerDto,
  MasterDataDto,
  Page,
  QuotationDto,
  RateCardDto,
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
import { deleteCommercialTestData, uniquePhone, waitForLockWaiter } from './test-data.js';

const PAST = '2020-01-01';
const FAR_FUTURE = '2099-12-31';

// Each rate starts on a day of its own before PAST: a branch holds one draft or approved rate
// per offer, start date included.
let rateDay = randomInt(0, 6000);
const nextRateDay = () =>
  new Date(Date.UTC(2000, 0, 1) + rateDay++ * 86_400_000).toISOString().slice(0, 10);

describe('commercial cycle: customers, rates, quotations, bookings', () => {
  let t: TestApp;
  let dxb: string;
  let jed: string;
  let jebelAli: string;
  let portSudan: string;
  let jeddah: string;
  const cookies: Record<
    'admin' | 'salesDxb' | 'salesJed' | 'managerDxb' | 'opsDxb' | 'financeDxb' | 'driver',
    string
  > = {
    admin: '',
    salesDxb: '',
    salesJed: '',
    managerDxb: '',
    opsDxb: '',
    financeDxb: '',
    driver: '',
  };

  const ids = {} as Record<keyof typeof cookies, string>;

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  function customerBody(branch: string, overrides: object = {}) {
    return {
      branchId: branch,
      kind: 'COMPANY',
      name: 'Al Noor Trading',
      companyName: 'Al Noor Trading LLC',
      phone: uniquePhone(),
      preferredCurrency: 'USD',
      ...overrides,
    };
  }

  function rateBody(branch: string, overrides: object = {}) {
    return {
      branchId: branch,
      originLocationId: jebelAli,
      destinationLocationId: portSudan,
      mode: 'SEA',
      loadType: 'FCL',
      cargoType: 'CONTAINER',
      containerTypeCode: '40HC',
      unit: 'PER_CONTAINER',
      price: '1250.50',
      minimumCharge: '0',
      currency: 'USD',
      validFrom: nextRateDay(),
      validTo: FAR_FUTURE,
      ...overrides,
    };
  }

  async function createCustomer(cookie: string, branch: string): Promise<CustomerDto> {
    const res = await post('/customers', cookie, customerBody(branch)).expect(201);
    return res.body as CustomerDto;
  }

  async function approvedRate(overrides: object = {}): Promise<RateCardDto> {
    const draft = (await post('/rates', cookies.salesDxb, rateBody(dxb, overrides)).expect(201))
      .body as RateCardDto;
    return (await post(`/rates/${draft.id}/approve`, cookies.managerDxb).expect(200))
      .body as RateCardDto;
  }

  function quotationBody(customerId: string, lines: object[], overrides: object = {}) {
    return {
      customerId,
      originLocationId: jebelAli,
      destinationLocationId: portSudan,
      mode: 'SEA',
      loadType: 'FCL',
      cargoType: 'CONTAINER',
      currency: 'USD',
      validUntil: FAR_FUTURE,
      lines,
      ...overrides,
    };
  }

  async function approvedQuotation(customerId: string): Promise<QuotationDto> {
    const rate = await approvedRate();
    const q = (
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customerId, [{ rateCardId: rate.id, quantity: '1' }]),
      ).expect(201)
    ).body as QuotationDto;
    await post(`/quotations/${q.id}/send`, cookies.salesDxb).expect(200);
    return (await post(`/quotations/${q.id}/approve`, cookies.salesDxb).expect(200))
      .body as QuotationDto;
  }

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jebelAli = await loc('AEJEA');
    portSudan = await loc('SDPZU');
    jeddah = await loc('SAJED');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR']),
      salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
      managerDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
      opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
      financeDxb: await createUser(t.prisma, ['FINANCE'], ['DXB']),
      driver: await createUser(t.prisma, ['DRIVER'], ['DXB']),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
      ids[key] = users[key].id;
    }
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('master data', () => {
    it('every signed-in user reads it, with the reference data from the migration', async () => {
      const res = await get('/master-data', cookies.driver).expect(200);
      const data = res.body as MasterDataDto;
      expect(data.containerTypes.map((c) => c.code)).toEqual(
        expect.arrayContaining(['20GP', '40GP', '40HC']),
      );
      expect(data.chargeTypes.map((c) => c.code)).toContain('FREIGHT');
      expect(data.locations.map((l) => l.code)).toEqual(
        expect.arrayContaining(['AEJEA', 'SAJED', 'SDPZU']),
      );
      expect(data.currencies.map((c) => c.code)).toContain('SDG');
    });

    it('only the Administrator adds a location; codes are unique', async () => {
      const body = {
        code: 'zzsua',
        kind: 'PORT',
        nameEn: 'Suakin',
        nameAr: 'سواكن',
        countryCode: 'SD',
      };
      await post('/master-data/locations', cookies.managerDxb, body).expect(403);
      const res = await post('/master-data/locations', cookies.admin, body).expect(201);
      expect((res.body as { code: string }).code).toBe('ZZSUA');
      await post('/master-data/locations', cookies.admin, body).expect(409);
    });

    it('requires a session', async () => {
      await t.http().get('/api/v1/master-data').expect(401);
    });
  });

  describe('customers', () => {
    it('creates a customer in the user’s branch with a running number', async () => {
      const a = await createCustomer(cookies.salesDxb, dxb);
      const b = await createCustomer(cookies.salesDxb, dxb);
      expect(a.number).toMatch(/^NOL-CUS-\d{6}$/);
      expect(b.number).not.toBe(a.number);
      expect(a.branchId).toBe(dxb);
      expect(a.preferredCurrency).toBe('USD');
    });

    it('refuses another branch: create 403, read 404, not listed', async () => {
      await post('/customers', cookies.salesDxb, customerBody(jed)).expect(403);
      const jedCustomer = await createCustomer(cookies.salesJed, jed);
      await get(`/customers/${jedCustomer.id}`, cookies.salesDxb).expect(404);
      await patch(`/customers/${jedCustomer.id}`, cookies.salesDxb, { name: 'x' }).expect(404);
      const list = (
        await get(`/customers?pageSize=100&q=${jedCustomer.number}`, cookies.salesDxb).expect(200)
      ).body as Page<CustomerDto>;
      expect(list.items).toHaveLength(0);
      const own = (await get(`/customers?q=${jedCustomer.number}`, cookies.salesJed).expect(200))
        .body as Page<CustomerDto>;
      expect(own.items.map((c) => c.id)).toEqual([jedCustomer.id]);
    });

    it('enforces the permission matrix', async () => {
      await get('/customers', cookies.driver).expect(403);
      await get('/customers', cookies.opsDxb).expect(200);
      await post('/customers', cookies.opsDxb, customerBody(dxb)).expect(403);
      await post('/customers', cookies.financeDxb, customerBody(dxb)).expect(403);
    });

    it('validates phone format, currency and the credit limit pair', async () => {
      await post('/customers', cookies.salesDxb, customerBody(dxb, { phone: '0501234567' })).expect(
        400,
      );
      await post(
        '/customers',
        cookies.salesDxb,
        customerBody(dxb, { preferredCurrency: 'XXX' }),
      ).expect(400);
      await post('/customers', cookies.salesDxb, customerBody(dxb, { creditLimit: '5000' })).expect(
        400,
      );
      await post(
        '/customers',
        cookies.salesDxb,
        customerBody(dxb, { creditLimit: '5000.5', creditLimitCurrency: 'AED' }),
      ).expect(201);
      await post('/customers', cookies.salesDxb, customerBody(dxb, { creditLimit: 5000 })).expect(
        400,
      );
    });

    it('keeps one primary contact and stores parties', async () => {
      const c = await createCustomer(cookies.salesDxb, dxb);
      const contact = { phone: '+249912345678', canReceiveCargo: true, isPrimary: true };
      await post(`/customers/${c.id}/contacts`, cookies.salesDxb, { name: 'A', ...contact }).expect(
        201,
      );
      const res = await post(`/customers/${c.id}/contacts`, cookies.salesDxb, {
        name: 'B',
        ...contact,
      }).expect(201);
      const contacts = (res.body as CustomerDto).contacts;
      expect(contacts.filter((x) => x.isPrimary).map((x) => x.name)).toEqual(['B']);
      const withParty = (
        await post(`/customers/${c.id}/parties`, cookies.salesDxb, {
          name: 'Consignee Co',
          countryCode: 'SD',
        }).expect(201)
      ).body as CustomerDto;
      expect(withParty.parties.map((p) => p.name)).toEqual(['Consignee Co']);
    });
  });

  describe('customer contacts under concurrency', () => {
    it('keeps exactly one primary when two primaries are added at once', async () => {
      const c = await createCustomer(cookies.salesDxb, dxb);
      const add = (name: string) =>
        post(`/customers/${c.id}/contacts`, cookies.salesDxb, {
          name,
          phone: '+249912345678',
          isPrimary: true,
        });
      const results = await Promise.all([add('A'), add('B'), add('C'), add('D')]);
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const primaries = await t.prisma.customerContact.count({
        where: { customerId: c.id, isPrimary: true },
      });
      expect(primaries).toBe(1);
    });

    it('refuses a second primary at the database level', async () => {
      const c = await createCustomer(cookies.salesDxb, dxb);
      const data = { customerId: c.id, name: 'X', phone: '+249912345678', isPrimary: true };
      await t.prisma.customerContact.create({ data });
      await expect(t.prisma.customerContact.create({ data })).rejects.toThrow();
    });
  });

  describe('audit log', () => {
    /** Yesterday to tomorrow (UTC): today in any branch's time zone. */
    const around = () => {
      const day = (offset: number) =>
        new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      return `from=${day(-1)}&to=${day(1)}`;
    };
    const entries = async (cookie: string, query: string) =>
      (
        (await get(`/reports/audit-log?${around()}&${query}`, cookie).expect(200))
          .body as AuditLogDto
      ).entries;

    it('records a rate’s edits and approval field by field, before and after', async () => {
      const sales = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, sales.email);
      const draft = (await post('/rates', cookie, rateBody(dxb, { price: '2300' })).expect(201))
        .body as RateCardDto;
      await patch(`/rates/${draft.id}`, cookie, { price: '2350', notes: 'Peak season' }).expect(
        200,
      );
      await patch(`/rates/${draft.id}`, cookie, { price: '2350' }).expect(200); // no change: no row
      await post(`/rates/${draft.id}/approve`, cookies.managerDxb).expect(200);

      const own = await entries(cookies.managerDxb, `userId=${sales.id}&entity=RATE`);
      expect(own.map((e) => e.action)).toEqual(['UPDATED', 'CREATED']);
      const [updated, created] = own;
      expect(updated?.changes).toEqual([
        { field: 'price', before: '2300', after: '2350' },
        { field: 'notes', before: null, after: 'Peak season' },
      ]);
      expect(updated).toMatchObject({
        source: 'USER',
        branchCode: 'DXB',
        userName: 'Integration Test',
      });
      expect(updated?.reference).toContain('AEJEA→SDPZU');
      expect(created?.changes).toEqual(
        expect.arrayContaining([
          { field: 'status', before: null, after: 'DRAFT' },
          { field: 'originLocationId', before: null, after: 'AEJEA' },
          { field: 'price', before: null, after: '2300' },
        ]),
      );
      const [approval] = await entries(cookies.managerDxb, `userId=${ids.managerDxb}&entity=RATE`);
      expect(approval).toMatchObject({
        action: 'APPROVED',
        changes: [{ field: 'status', before: 'DRAFT', after: 'APPROVED' }],
      });
    });

    it('records a customer’s edits and deactivation, in the customer’s branch only', async () => {
      const sales = await createUser(t.prisma, ['SALES'], ['DXB']);
      const cookie = await signIn(t, sales.email);
      const c = await createCustomer(cookie, dxb);
      await patch(`/customers/${c.id}`, cookie, { city: 'Dubai', paymentTermsDays: 30 }).expect(
        200,
      );
      await post(`/customers/${c.id}/deactivate`, cookies.admin).expect(200);

      const own = await entries(cookies.managerDxb, `userId=${sales.id}&entity=CUSTOMER`);
      expect(own.map((e) => [e.action, e.reference])).toEqual([
        ['UPDATED', expect.stringContaining(c.number)],
        ['CREATED', expect.stringContaining(c.number)],
      ]);
      expect(own[0]?.changes).toEqual([
        { field: 'city', before: null, after: 'Dubai' },
        { field: 'paymentTermsDays', before: '0', after: '30' },
      ]);
      const [deactivated] = await entries(
        cookies.managerDxb,
        `userId=${ids.admin}&entity=CUSTOMER`,
      );
      expect(deactivated?.changes).toEqual([{ field: 'isActive', before: 'true', after: 'false' }]);

      // Another branch's manager and a role without audit_log:view see nothing of it.
      const managerJed = await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED']);
      const jedCookie = await signIn(t, managerJed.email);
      expect(await entries(jedCookie, `userId=${sales.id}`)).toEqual([]);
      await get(`/reports/audit-log?${around()}`, cookie).expect(403);
    });

    it('records contact and party changes, before and after, under the customer', async () => {
      const c = await createCustomer(cookies.salesDxb, dxb);
      const withContact = (
        await post(`/customers/${c.id}/contacts`, cookies.salesDxb, {
          name: 'Omar',
          phone: '+971501234111',
          isPrimary: true,
        }).expect(201)
      ).body as CustomerDto;
      const omar = withContact.contacts[0];
      if (!omar) throw new Error('No contact');
      // A second primary contact moves the flag off Omar: both changes are logged.
      await post(`/customers/${c.id}/contacts`, cookies.salesDxb, {
        name: 'Huda',
        phone: '+971501234222',
        isPrimary: true,
      }).expect(201);
      await patch(`/customers/${c.id}/contacts/${omar.id}`, cookies.salesDxb, {
        phone: '+971501234333',
      }).expect(200);
      const withParty = (
        await post(`/customers/${c.id}/parties`, cookies.salesDxb, {
          name: 'Nile Consignee',
        }).expect(201)
      ).body as CustomerDto;
      const party = withParty.parties[0];
      if (!party) throw new Error('No party');
      await patch(`/customers/${c.id}/parties/${party.id}`, cookies.salesDxb, {
        city: 'Khartoum',
      }).expect(200);

      const log = (await entries(cookies.managerDxb, `userId=${ids.salesDxb}&entity=CUSTOMER`))
        .filter((e) => e.reference.startsWith(c.number))
        .map((e) => [e.action, e.changes]);
      expect(log).toEqual([
        [
          'UPDATED',
          [
            { field: 'party', before: 'Nile Consignee', after: 'Nile Consignee' },
            { field: 'party.city', before: null, after: 'Khartoum' },
          ],
        ],
        [
          'UPDATED',
          expect.arrayContaining([
            { field: 'party', before: null, after: 'Nile Consignee' },
            { field: 'party.name', before: null, after: 'Nile Consignee' },
          ]),
        ],
        [
          'UPDATED',
          [
            { field: 'contact', before: 'Omar', after: 'Omar' },
            { field: 'contact.phone', before: '+971501234111', after: '+971501234333' },
          ],
        ],
        [
          'UPDATED',
          expect.arrayContaining([
            { field: 'contact', before: 'Omar', after: 'Omar' },
            { field: 'contact.isPrimary', before: 'true', after: 'false' },
            { field: 'contact', before: null, after: 'Huda' },
            { field: 'contact.isPrimary', before: null, after: 'true' },
          ]),
        ],
        [
          'UPDATED',
          expect.arrayContaining([
            { field: 'contact', before: null, after: 'Omar' },
            { field: 'contact.phone', before: null, after: '+971501234111' },
          ]),
        ],
        ['CREATED', expect.any(Array)],
      ]);
    });

    it('concurrent deactivations and reactivations log each change as it happened', async () => {
      const c = await createCustomer(cookies.salesDxb, dxb);
      const flip = (active: boolean) =>
        post(`/customers/${c.id}/${active ? 'activate' : 'deactivate'}`, cookies.admin);
      await Promise.all([
        flip(false),
        flip(true),
        flip(false),
        flip(true),
        flip(false),
        flip(true),
      ]);
      const log = (await entries(cookies.managerDxb, `userId=${ids.admin}&entity=CUSTOMER`))
        .filter((e) => e.reference.startsWith(c.number))
        .reverse()
        .map((e) => e.changes?.[0]);
      // Each logged change starts where the one before ended, and the last ends where the
      // customer is now: no change is hidden or invented by a stale read.
      let state = 'true';
      for (const change of log) {
        expect(change).toMatchObject({ field: 'isActive', before: state });
        state = change?.after ?? '';
      }
      const now = await t.prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
      expect(state).toBe(String(now.isActive));
    });

    it('the audit table refuses any change or removal, even from the application', async () => {
      const row = await t.prisma.auditEvent.findFirstOrThrow({ where: { entity: 'RATE' } });
      await expect(
        t.prisma.auditEvent.update({ where: { id: row.id }, data: { reference: 'x' } }),
      ).rejects.toThrow(/cannot be changed or deleted/);
      await expect(t.prisma.auditEvent.delete({ where: { id: row.id } })).rejects.toThrow(
        /cannot be changed or deleted/,
      );
      await expect(t.prisma.$executeRawUnsafe('TRUNCATE "audit_events"')).rejects.toThrow(
        /cannot be changed or deleted/,
      );
    });
  });

  describe('rates', () => {
    it('Sales drafts, the Branch Manager approves, the approved rate is frozen', async () => {
      const draft = (await post('/rates', cookies.salesDxb, rateBody(dxb)).expect(201))
        .body as RateCardDto;
      expect(draft.status).toBe('DRAFT');
      expect(draft.price).toBe('1250.5');
      await post(`/rates/${draft.id}/approve`, cookies.salesDxb).expect(403);
      await patch(`/rates/${draft.id}`, cookies.salesDxb, { price: '1300' }).expect(200);
      const approved = (await post(`/rates/${draft.id}/approve`, cookies.managerDxb).expect(200))
        .body as RateCardDto;
      expect(approved.status).toBe('APPROVED');
      expect(approved.price).toBe('1300');
      await patch(`/rates/${draft.id}`, cookies.salesDxb, { price: '1' }).expect(409);
      await post(`/rates/${draft.id}/approve`, cookies.managerDxb).expect(409);
    });

    it('only roles with rates:cancel cancel a rate', async () => {
      const rate = await approvedRate();
      await post(`/rates/${rate.id}/cancel`, cookies.salesDxb).expect(403);
      await post(`/rates/${rate.id}/cancel`, cookies.managerDxb).expect(403);
      const res = await post(`/rates/${rate.id}/cancel`, cookies.admin).expect(200);
      expect((res.body as RateCardDto).status).toBe('CANCELLED');
    });

    it('is branch-scoped and validates its references', async () => {
      await post('/rates', cookies.salesDxb, rateBody(jed)).expect(403);
      const draft = (await post('/rates', cookies.salesDxb, rateBody(dxb)).expect(201))
        .body as RateCardDto;
      await get(`/rates/${draft.id}`, cookies.salesJed).expect(404);
      await post(
        '/rates',
        cookies.salesDxb,
        rateBody(dxb, { destinationLocationId: jebelAli }),
      ).expect(400);
      await post('/rates', cookies.salesDxb, rateBody(dxb, { containerTypeCode: null })).expect(
        400,
      );
      await post('/rates', cookies.salesDxb, rateBody(dxb, { mode: 'ROAD' })).expect(400);
      await post('/rates', cookies.salesDxb, rateBody(dxb, { price: '-1' })).expect(400);
      await post('/rates', cookies.salesDxb, rateBody(dxb, { price: 12.5 })).expect(400);
      await post(
        '/rates',
        cookies.salesDxb,
        rateBody(dxb, { validFrom: '2026-02-01', validTo: '2026-01-01' }),
      ).expect(400);
    });
  });

  describe('quotations', () => {
    let customer: CustomerDto;

    beforeAll(async () => {
      customer = await createCustomer(cookies.salesDxb, dxb);
    });

    it('prices lines from approved rates with exact decimal totals and a minimum charge', async () => {
      const container = await approvedRate({ price: '1250.50' });
      const thc = await approvedRate({
        chargeTypeCode: 'THC',
        price: '45.333',
        minimumCharge: '150',
      });
      const res = await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [
          { rateCardId: container.id, quantity: '2', discount: '0.5' },
          { rateCardId: thc.id, quantity: '1.25' }, // 56.67 < 150 → 150
          { chargeTypeCode: 'DOCS', unit: 'PER_SHIPMENT', unitPrice: '35.10', quantity: '1' },
        ]),
      ).expect(201);
      const q = res.body as QuotationDto;
      expect(q.number).toMatch(/^NOL-QT-\d{4}-\d{6}$/);
      expect(q.status).toBe('DRAFT');
      expect(q.branchId).toBe(dxb);
      expect(q.lines.map((l) => l.lineTotal)).toEqual(['2500.5', '150', '35.1']);
      expect(q.subtotal).toBe('2686.1');
      expect(q.discountTotal).toBe('0.5');
      expect(q.total).toBe('2685.6');
      expect(q.lines[0]?.unitPrice).toBe('1250.5');
    });

    it('ignores client-sent totals and prices on rate lines', async () => {
      const rate = await approvedRate({ price: '100' });
      const res = await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1', unitPrice: '1' }]),
      ).expect(201);
      expect((res.body as QuotationDto).total).toBe('100');
      await post('/quotations', cookies.salesDxb, {
        ...quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }]),
        total: '1',
      }).expect(400);
    });

    it('refuses a rate for another route, mode, load or cargo type', async () => {
      const lines = (rateCardId: string) => [{ rateCardId, quantity: '1' }];
      const otherRoute = await approvedRate({ originLocationId: jeddah });
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, lines(otherRoute.id)),
      ).expect(400);
      const lcl = await approvedRate({ loadType: 'LCL' });
      await post('/quotations', cookies.salesDxb, quotationBody(customer.id, lines(lcl.id))).expect(
        400,
      );
      const road = await approvedRate({ mode: 'ROAD', loadType: null });
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, lines(road.id)),
      ).expect(400);
      const pallets = await approvedRate({
        cargoType: 'PALLET',
        containerTypeCode: null,
        unit: 'PER_PALLET',
      });
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, lines(pallets.id)),
      ).expect(400);
      // The same rate is accepted by a quotation that matches it.
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, lines(road.id), { mode: 'ROAD', loadType: null }),
      ).expect(201);
    });

    it('rejects amounts that would not fit the database columns', async () => {
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [
          {
            chargeTypeCode: 'OTHER',
            unit: 'PER_SHIPMENT',
            unitPrice: '99999999999999',
            quantity: '2',
          },
        ]),
      ).expect(400);
    });

    it('refuses draft, foreign-branch, wrong-currency rates and oversized discounts', async () => {
      const draft = (await post('/rates', cookies.salesDxb, rateBody(dxb)).expect(201))
        .body as RateCardDto;
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [{ rateCardId: draft.id, quantity: '1' }]),
      ).expect(400);

      const jedRateDraft = (
        await post('/rates', cookies.salesJed, rateBody(jed, { originLocationId: jeddah })).expect(
          201,
        )
      ).body as RateCardDto;
      await post(`/rates/${jedRateDraft.id}/approve`, cookies.admin).expect(200);
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [{ rateCardId: jedRateDraft.id, quantity: '1' }]),
      ).expect(400);

      const usd = await approvedRate();
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [{ rateCardId: usd.id, quantity: '1' }], { currency: 'AED' }),
      ).expect(400);
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [{ rateCardId: usd.id, quantity: '1', discount: '5000' }]),
      ).expect(400);
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [{ rateCardId: usd.id, quantity: '0' }]),
      ).expect(400);
    });

    it('follows draft → sent → approved, and refuses edits after draft', async () => {
      const rate = await approvedRate();
      const q = (
        await post(
          '/quotations',
          cookies.salesDxb,
          quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }]),
        ).expect(201)
      ).body as QuotationDto;
      await post(`/quotations/${q.id}/approve`, cookies.salesDxb).expect(409);
      const edited = (
        await patch(`/quotations/${q.id}`, cookies.salesDxb, {
          ...quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '3' }]),
          customerId: undefined,
        }).expect(200)
      ).body as QuotationDto;
      expect(edited.total).toBe('3751.5');
      await post(`/quotations/${q.id}/send`, cookies.salesDxb).expect(200);
      await patch(`/quotations/${q.id}`, cookies.salesDxb, {
        ...quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }]),
        customerId: undefined,
      }).expect(409);
      const approved = (await post(`/quotations/${q.id}/approve`, cookies.managerDxb).expect(200))
        .body as QuotationDto;
      expect(approved.status).toBe('APPROVED');
      expect(approved.decidedAt).not.toBeNull();
    });

    it('records a rejection with its reason', async () => {
      const rate = await approvedRate();
      const q = (
        await post(
          '/quotations',
          cookies.salesDxb,
          quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }]),
        ).expect(201)
      ).body as QuotationDto;
      await post(`/quotations/${q.id}/send`, cookies.salesDxb).expect(200);
      await post(`/quotations/${q.id}/reject`, cookies.salesDxb, {}).expect(400);
      const rejected = (
        await post(`/quotations/${q.id}/reject`, cookies.salesDxb, {
          reason: 'Too expensive',
        }).expect(200)
      ).body as QuotationDto;
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejectionReason).toBe('Too expensive');
    });

    it('expires a quotation approved after its validity date', async () => {
      const rate = await approvedRate();
      const q = (
        await post(
          '/quotations',
          cookies.salesDxb,
          quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }]),
        ).expect(201)
      ).body as QuotationDto;
      await post(`/quotations/${q.id}/send`, cookies.salesDxb).expect(200);
      await t.prisma.quotation.update({
        where: { id: q.id },
        data: { validUntil: new Date(`${PAST}T00:00:00Z`) },
      });
      await post(`/quotations/${q.id}/approve`, cookies.salesDxb).expect(409);
      const after = (await get(`/quotations/${q.id}`, cookies.salesDxb).expect(200))
        .body as QuotationDto;
      expect(after.status).toBe('EXPIRED');
      await post(
        '/quotations',
        cookies.salesDxb,
        quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }], {
          validUntil: PAST,
        }),
      ).expect(400);
    });

    it('is branch-scoped and follows the permission matrix', async () => {
      const rate = await approvedRate();
      const body = quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }]);
      await post('/quotations', cookies.salesJed, body).expect(404);
      await post('/quotations', cookies.opsDxb, body).expect(403);
      await post('/quotations', cookies.managerDxb, body).expect(403);
      const q = (await post('/quotations', cookies.salesDxb, body).expect(201))
        .body as QuotationDto;
      await get(`/quotations/${q.id}`, cookies.salesJed).expect(404);
      await get(`/quotations/${q.id}`, cookies.opsDxb).expect(200);
      await get('/quotations', cookies.driver).expect(403);
      await post(`/quotations/${q.id}/send`, cookies.salesDxb).expect(200);
      await post(`/quotations/${q.id}/approve`, cookies.opsDxb).expect(403);
      await post(`/quotations/${q.id}/approve`, cookies.salesJed).expect(404);
    });
  });

  describe('bookings', () => {
    let customer: CustomerDto;

    beforeAll(async () => {
      customer = await createCustomer(cookies.salesDxb, dxb);
      customer = (
        await post(`/customers/${customer.id}/parties`, cookies.salesDxb, {
          name: 'Shipper',
        }).expect(201)
      ).body as CustomerDto;
    });

    it('turns an approved quotation into one booking, never two', async () => {
      const q = await approvedQuotation(customer.id);
      const shipperId = customer.parties[0]?.id;
      const results = await Promise.all([
        post(`/bookings/from-quotation/${q.id}`, cookies.salesDxb, { shipperId }),
        post(`/bookings/from-quotation/${q.id}`, cookies.opsDxb, { shipperId }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const booking = results.find((r) => r.status === 201)?.body as BookingDto;
      expect(booking.number).toMatch(/^NOL-BK-\d{4}-\d{6}$/);
      expect(booking.quotationId).toBe(q.id);
      expect(booking.customerId).toBe(customer.id);
      expect(booking.originLocationId).toBe(jebelAli);
      expect(booking.services).toEqual(['MAIN_FREIGHT']);
      expect(booking.shipperId).toBe(shipperId);
      const quotation = (await get(`/quotations/${q.id}`, cookies.salesDxb).expect(200))
        .body as QuotationDto;
      expect(quotation.bookingId).toBe(booking.id);
    });

    it('refuses a quotation that is not approved', async () => {
      const rate = await approvedRate();
      const q = (
        await post(
          '/quotations',
          cookies.salesDxb,
          quotationBody(customer.id, [{ rateCardId: rate.id, quantity: '1' }]),
        ).expect(201)
      ).body as QuotationDto;
      await post(`/bookings/from-quotation/${q.id}`, cookies.salesDxb).expect(409);
    });

    function directBooking(overrides: object = {}) {
      return {
        customerId: customer.id,
        originLocationId: jeddah,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'PALLET',
        services: ['MAIN_FREIGHT', 'CUSTOMS', 'CUSTOMS'],
        items: [
          {
            cargoType: 'PALLET',
            quantity: 10,
            lengthCm: '120',
            widthCm: '100',
            heightCm: '150',
            weightKg: '4500.5',
          },
          { cargoType: 'CONTAINER', containerTypeCode: '20GP', quantity: 1, volumeCbm: '33.2' },
        ],
        ...overrides,
      };
    }

    it('creates a direct booking and computes CBM on the server', async () => {
      const b = (await post('/bookings', cookies.opsDxb, directBooking()).expect(201))
        .body as BookingDto;
      expect(b.status).toBe('DRAFT');
      expect(b.services).toEqual(['MAIN_FREIGHT', 'CUSTOMS']);
      expect(b.items.map((i) => i.volumeCbm)).toEqual(['18', '33.2']);
      expect(b.items[0]?.weightKg).toBe('4500.5');
    });

    it('validates parties, dimensions and container lines', async () => {
      const other = await createCustomer(cookies.salesDxb, dxb);
      const foreignParty = (
        await post(`/customers/${other.id}/parties`, cookies.salesDxb, {
          name: 'Not yours',
        }).expect(201)
      ).body as CustomerDto;
      await post(
        '/bookings',
        cookies.salesDxb,
        directBooking({ consigneeId: foreignParty.parties[0]?.id }),
      ).expect(400);
      await post(
        '/bookings',
        cookies.salesDxb,
        directBooking({ items: [{ cargoType: 'PALLET', quantity: 1, lengthCm: '100' }] }),
      ).expect(400);
      await post(
        '/bookings',
        cookies.salesDxb,
        directBooking({ items: [{ cargoType: 'CONTAINER', quantity: 1 }] }),
      ).expect(400);
      await post('/bookings', cookies.salesDxb, directBooking({ services: [] })).expect(400);
      await post('/bookings', cookies.salesDxb, directBooking({ mode: 'ROAD' })).expect(400);
    });

    it('rejects measurements that would overflow or be rounded by the database', async () => {
      const item = (fields: object) =>
        directBooking({ items: [{ cargoType: 'PALLET', quantity: 1, ...fields }] });
      const dims = { lengthCm: '100', widthCm: '100', heightCm: '100' };
      await post('/bookings', cookies.salesDxb, item({ ...dims, lengthCm: '100.123' })).expect(400);
      await post('/bookings', cookies.salesDxb, item({ ...dims, lengthCm: '123456789' })).expect(
        400,
      );
      await post('/bookings', cookies.salesDxb, item({ ...dims, lengthCm: '0' })).expect(400);
      await post('/bookings', cookies.salesDxb, item({ weightKg: '1.1234' })).expect(400);
      await post('/bookings', cookies.salesDxb, item({ volumeCbm: '1.12345' })).expect(400);
      await post('/bookings', cookies.salesDxb, item({ volumeCbm: '123456789' })).expect(400);
      // Valid per column, but the computed volume does not fit Decimal(12, 4).
      await post(
        '/bookings',
        cookies.salesDxb,
        item({ lengthCm: '99999999', widthCm: '99999999', heightCm: '99999999' }),
      ).expect(400);
      await post(
        '/bookings',
        cookies.salesDxb,
        item({ ...dims, weightKg: '999999999.999' }),
      ).expect(201);
    });

    it('requires services in the database: NULL and empty are refused', async () => {
      const b = (await post('/bookings', cookies.salesDxb, directBooking()).expect(201))
        .body as BookingDto;
      await expect(
        t.prisma.$executeRaw`UPDATE "bookings" SET "services" = NULL WHERE "id" = ${b.id}::uuid`,
      ).rejects.toThrow();
      await expect(
        t.prisma.$executeRaw`UPDATE "bookings" SET "services" = '{}' WHERE "id" = ${b.id}::uuid`,
      ).rejects.toThrow();
    });

    it('does not confirm a booking whose cargo lines a concurrent edit removes', async () => {
      const b = (await post('/bookings', cookies.salesDxb, directBooking()).expect(201))
        .body as BookingDto;
      // A draft edit in progress: it holds the booking row and has removed every cargo line, but
      // has not committed yet.
      let finishEdit: () => void = () => undefined;
      const editDone = new Promise<void>((resolve) => {
        finishEdit = resolve;
      });
      const edit = t.prisma.$transaction(
        async (tx) => {
          await tx.booking.updateMany({ where: { id: b.id, status: 'DRAFT' }, data: {} });
          await tx.$executeRaw`UPDATE "bookings" SET "updated_at" = now() WHERE "id" = ${b.id}::uuid`;
          await tx.bookingItem.deleteMany({ where: { bookingId: b.id } });
          await editDone;
        },
        { timeout: 20_000 },
      );
      const confirm = post(`/bookings/${b.id}/confirm`, cookies.managerDxb).then((r) => r);
      await waitForLockWaiter(t.prisma);
      finishEdit();
      await edit;
      const res = await confirm;
      expect(res.status).toBe(400);
      const after = (await get(`/bookings/${b.id}`, cookies.salesDxb).expect(200))
        .body as BookingDto;
      expect(after.status).toBe('DRAFT');
      expect(after.items).toHaveLength(0);
    });

    it('confirms with cargo only, cancels with a reason, and freezes after draft', async () => {
      const empty = (
        await post('/bookings', cookies.salesDxb, directBooking({ items: [] })).expect(201)
      ).body as BookingDto;
      await post(`/bookings/${empty.id}/confirm`, cookies.managerDxb).expect(400);

      const b = (await post('/bookings', cookies.salesDxb, directBooking()).expect(201))
        .body as BookingDto;
      await post(`/bookings/${b.id}/confirm`, cookies.financeDxb).expect(403);
      const confirmed = (await post(`/bookings/${b.id}/confirm`, cookies.managerDxb).expect(200))
        .body as BookingDto;
      expect(confirmed.status).toBe('CONFIRMED');
      expect(confirmed.confirmedAt).not.toBeNull();
      await patch(`/bookings/${b.id}`, cookies.salesDxb, {
        ...directBooking(),
        customerId: undefined,
      }).expect(409);
      await post(`/bookings/${b.id}/cancel`, cookies.salesDxb, {}).expect(400);
      await post(`/bookings/${b.id}/cancel`, cookies.managerDxb, { reason: 'x' }).expect(403);
      const cancelled = (
        await post(`/bookings/${b.id}/cancel`, cookies.salesDxb, {
          reason: 'Customer postponed',
        }).expect(200)
      ).body as BookingDto;
      expect(cancelled.status).toBe('CANCELLED');
      await post(`/bookings/${b.id}/cancel`, cookies.salesDxb, { reason: 'again' }).expect(409);
    });

    it('is branch-scoped and follows the permission matrix', async () => {
      await post('/bookings', cookies.salesJed, directBooking()).expect(404);
      await post('/bookings', cookies.financeDxb, directBooking()).expect(403);
      const b = (await post('/bookings', cookies.salesDxb, directBooking()).expect(201))
        .body as BookingDto;
      await get(`/bookings/${b.id}`, cookies.salesJed).expect(404);
      await get(`/bookings/${b.id}`, cookies.financeDxb).expect(200);
      await get('/bookings', cookies.driver).expect(403);
      const list = (await get('/bookings?pageSize=100', cookies.salesJed).expect(200))
        .body as Page<BookingDto>;
      expect(list.items.every((x) => x.branchId === jed)).toBe(true);
    });
  });

  it('gives concurrent creations distinct numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post('/customers', cookies.salesDxb, customerBody(dxb))),
    );
    const numbers = results.map((r) => (r.body as CustomerDto).number);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(numbers).size).toBe(8);
  });
});
