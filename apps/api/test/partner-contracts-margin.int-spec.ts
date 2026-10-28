import type {
  ExpectedMarginDto,
  PartnerContractDto,
  PartnerDto,
  RateCardCostDto,
  RateCardDto,
} from '@nolon/shared';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requests } from './agent-drafts-helpers.js';
import {
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData } from './test-data.js';

// Business model PR-4 (docs/plans/02-business-model-batch-1.md 3.4, 4.1, 6.1): partners'
// commission contracts (settings only), a rate card's reference costs, and its expected margin.
// Branch-scoped, closed to Sales, Operations and Outlet Staff, and never a journal entry.

const FAR_FUTURE = '2099-12-31';
let rateDay = randomInt(0, 6000);
const nextRateDay = () =>
  new Date(Date.UTC(2000, 0, 1) + rateDay++ * 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

describe('partner contracts, rate card costs and the expected margin', () => {
  let t: TestApp;
  let r: ReturnType<typeof requests>;
  let jed: string;
  let dxb: string;
  let jeddahPort: string;
  let portSudan: string;
  // A currency of this test only: no exchange rate until the test adds one.
  const testCurrency = `Q${String.fromCharCode(65 + randomInt(26))}${String.fromCharCode(65 + randomInt(26))}`;
  const cookies = {
    admin: '',
    pricingJed: '',
    pricingDxb: '',
    managerJed: '',
    financeJed: '',
    salesJed: '',
    staff: '',
  };
  const outlets = {} as Record<'carton' | 'general' | 'none' | 'dxb', PartnerDto>;

  const partner = async (branch: string, cookie: string, kind = 'SALES_OUTLET') =>
    (
      await r
        .post('/partners', cookie, {
          kind,
          branchId: branch,
          name: `ZZ contract partner ${randomInt(1e9)}`,
          countryCode: 'SA',
          currency: 'SAR',
        })
        .expect(201)
    ).body as PartnerDto;

  const percent = (value: string, extra: object = {}) => ({
    basis: 'PERCENT_OF_PRICE',
    value,
    validFrom: '2020-01-01',
    ...extra,
  });

  const contract = async (outlet: PartnerDto, body: object, approve = true) => {
    const made = (
      await r.post(`/partners/${outlet.id}/contracts`, cookies.pricingJed, body).expect(201)
    ).body as PartnerContractDto;
    if (!approve) return made;
    return (await r.post(`/partner-contracts/${made.id}/approve`, cookies.pricingJed).expect(200))
      .body as PartnerContractDto;
  };

  const card = async (branch = jed, cookie = cookies.pricingJed, extra: object = {}) =>
    (
      await r
        .post('/rates', cookie, {
          branchId: branch,
          originLocationId: jeddahPort,
          destinationLocationId: portSudan,
          mode: 'SEA',
          loadType: 'LCL',
          cargoType: 'GENERAL',
          priceCategoryCode: 'CARTON',
          unit: 'PER_PIECE',
          price: '100',
          minimumCharge: '500',
          currency: 'USD',
          validFrom: nextRateDay(),
          validTo: FAR_FUTURE,
          ...extra,
        })
        .expect(201)
    ).body as RateCardDto;

  const margin = async (rate: RateCardDto, query = '') =>
    (await r.get(`/rates/${rate.id}/expected-margin${query}`, cookies.pricingJed).expect(200))
      .body as ExpectedMarginDto;
  const line = (m: ExpectedMarginDto, component: string) =>
    m.lines.find((l) => l.component === component);

  beforeAll(async () => {
    t = await createTestApp();
    r = requests(t);
    jed = await branchId(t.prisma, 'JED');
    dxb = await branchId(t.prisma, 'DXB');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    const as = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      signIn(t, (await createUser(t.prisma, roles, branches)).email);
    cookies.admin = await as(['ADMINISTRATOR'], []);
    cookies.pricingJed = await as(['SALES_MARKETING_MANAGER'], ['JED']);
    cookies.pricingDxb = await as(['SALES_MARKETING_MANAGER'], ['DXB']);
    cookies.managerJed = await as(['BRANCH_MANAGER'], ['JED']);
    cookies.financeJed = await as(['FINANCE'], ['JED']);
    cookies.salesJed = await as(['SALES'], ['JED']);
    outlets.carton = await partner(jed, cookies.managerJed);
    outlets.general = await partner(jed, cookies.managerJed);
    outlets.none = await partner(jed, cookies.managerJed);
    outlets.dxb = await partner(dxb, cookies.admin);
    const staff = await createUser(t.prisma, ['OUTLET_STAFF'], ['JED']);
    await t.prisma.userPartner.create({ data: { userId: staff.id, partnerId: outlets.carton.id } });
    cookies.staff = await signIn(t, staff.email);
    await t.prisma.currency.create({
      data: { code: testCurrency, nameEn: 'ZZ test', nameAr: 'ZZ test', decimalPlaces: 2 },
    });
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await t.prisma.fxRate.deleteMany({ where: { currency: testCurrency } });
    await t.prisma.currency.deleteMany({ where: { code: testCurrency } });
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('contracts', () => {
    it('are kept by the pricing manager of the partner’s branch, read by its managers', async () => {
      const made = await contract(outlets.none, percent('5'), false);
      expect(made).toMatchObject({ status: 'DRAFT', value: '5', unit: null, currency: null });
      const listed = (
        await r.get(`/partners/${outlets.none.id}/contracts`, cookies.managerJed).expect(200)
      ).body as PartnerContractDto[];
      expect(listed.map((c) => c.id)).toContain(made.id);
      expect(listed[0]?.actions).toEqual({ canEdit: false, canApprove: false, canCancel: false });
      await r.get(`/partners/${outlets.none.id}/contracts`, cookies.financeJed).expect(200);
      await r
        .post(`/partners/${outlets.none.id}/contracts`, cookies.managerJed, percent('5'))
        .expect(403);
      for (const cookie of [cookies.salesJed, cookies.staff]) {
        await r.get(`/partners/${outlets.none.id}/contracts`, cookie).expect(403);
        await r.post(`/partners/${outlets.none.id}/contracts`, cookie, percent('5')).expect(403);
      }
      // Another branch's pricing manager does not learn the partner exists.
      await r.get(`/partners/${outlets.none.id}/contracts`, cookies.pricingDxb).expect(404);
      await r.post(`/partner-contracts/${made.id}/approve`, cookies.pricingDxb).expect(404);
      await r.post(`/partner-contracts/${made.id}/cancel`, cookies.pricingJed).expect(200);
    });

    it('refuse a percentage over 100 or with a unit, and a fixed amount without one', async () => {
      const url = `/partners/${outlets.none.id}/contracts`;
      await r.post(url, cookies.pricingJed, percent('100.0001')).expect(400);
      await r.post(url, cookies.pricingJed, percent('5', { unit: 'PER_PIECE' })).expect(400);
      const fixed = { basis: 'FIXED_PER_UNIT', value: '2', validFrom: '2020-01-01' };
      await r.post(url, cookies.pricingJed, { ...fixed, unit: 'PER_PIECE' }).expect(400);
      await r.post(url, cookies.pricingJed, { ...fixed, currency: 'USD' }).expect(400);
      await r.post(url, cookies.pricingJed, percent('5', { validTo: '2019-12-31' })).expect(400);
      await r
        .post(url, cookies.pricingJed, percent('5', { priceCategoryCode: 'NOPE' }))
        .expect(400);
      const ok = (
        await r
          .post(url, cookies.pricingJed, { ...fixed, unit: 'PER_PIECE', currency: 'USD' })
          .expect(201)
      ).body as PartnerContractDto;
      expect(ok).toMatchObject({ unit: 'PER_PIECE', currency: 'USD', value: '2' });
      await r.post(`/partner-contracts/${ok.id}/cancel`, cookies.pricingJed).expect(200);
    });

    it('keep one approved contract per category and day, and an approved one is not edited', async () => {
      const outlet = await partner(jed, cookies.managerJed);
      const entries = await t.prisma.journalEntry.count();
      const bills = await t.prisma.supplierBill.count();
      const first = await contract(outlet, percent('5', { validTo: '2030-12-31' }));
      expect(first.status).toBe('APPROVED');
      await r.patch(`/partner-contracts/${first.id}`, cookies.pricingJed, percent('6')).expect(409);
      const overlap = await contract(outlet, percent('6', { validFrom: '2030-06-01' }), false);
      const refused = await r
        .post(`/partner-contracts/${overlap.id}/approve`, cookies.pricingJed)
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'CONTRACT_OVERLAP' });
      // Another category, or days the first does not cover, are fine.
      await contract(outlet, percent('8', { priceCategoryCode: 'CARTON' }));
      await contract(outlet, percent('7', { validFrom: '2031-01-01' }));
      // Cancelling the first frees its days.
      await r.post(`/partner-contracts/${first.id}/cancel`, cookies.pricingJed).expect(200);
      await r
        .patch(
          `/partner-contracts/${overlap.id}`,
          cookies.pricingJed,
          percent('6', {
            validFrom: '2030-06-01',
            validTo: '2030-12-31',
          }),
        )
        .expect(200);
      await r.post(`/partner-contracts/${overlap.id}/approve`, cookies.pricingJed).expect(200);
      // Settings only: nothing posted or billed.
      expect(await t.prisma.journalEntry.count()).toBe(entries);
      expect(await t.prisma.supplierBill.count()).toBe(bills);
    });

    it('cannot be approved for a partner no longer active', async () => {
      const outlet = await partner(jed, cookies.managerJed);
      const draft = await contract(outlet, percent('5'), false);
      await r.patch(`/partners/${outlet.id}`, cookies.managerJed, { isActive: false }).expect(200);
      const res = await r
        .post(`/partner-contracts/${draft.id}/approve`, cookies.pricingJed)
        .expect(409);
      expect(res.body).toMatchObject({ code: 'CONTRACT_PARTNER_INACTIVE' });
    });
  });

  describe('rate card costs', () => {
    it('are entered by the pricing manager and read by managers, not by Sales or outlets', async () => {
      const rate = await card();
      const url = `/rates/${rate.id}/costs`;
      const costs = (
        await r
          .put(`${url}/ORIGIN_HANDLING`, cookies.pricingJed, {
            status: 'ENTERED',
            amount: '10',
            currency: 'USD',
            unit: 'PER_PIECE',
          })
          .expect(200)
      ).body as RateCardCostDto[];
      expect(costs).toMatchObject([
        { component: 'ORIGIN_HANDLING', status: 'ENTERED', amount: '10', currency: 'USD' },
      ]);
      await r.get(url, cookies.managerJed).expect(200);
      await r.get(url, cookies.financeJed).expect(200);
      await r.put(`${url}/OTHER`, cookies.managerJed, { status: 'NOT_APPLICABLE' }).expect(403);
      for (const cookie of [cookies.salesJed, cookies.staff]) {
        await r.get(url, cookie).expect(403);
        await r.get(`/rates/${rate.id}/expected-margin`, cookie).expect(403);
      }
      // The card itself stays readable by Sales, without its costs.
      expect(
        (await r.get(`/rates/${rate.id}`, cookies.salesJed).expect(200)).body,
      ).not.toHaveProperty('costs');
      await r.get(url, cookies.pricingDxb).expect(404);
      await r.put(`${url}/OTHER`, cookies.pricingDxb, { status: 'NOT_APPLICABLE' }).expect(404);
      await r
        .put(`${url}/OTHER`, cookies.pricingJed, { status: 'NOT_APPLICABLE', amount: '1' })
        .expect(400);
      await r
        .put(`${url}/OUTLET_COMMISSION`, cookies.pricingJed, { status: 'NOT_APPLICABLE' })
        .expect(400);
      await r
        .put(`${url}/SEA_FREIGHT`, cookies.pricingJed, {
          status: 'ENTERED',
          amount: '1000',
          currency: 'USD',
          unit: 'PER_CONTAINER',
          unitsPerCostUnit: '0',
        })
        .expect(400);
      const logged = await t.prisma.auditEvent.findFirst({
        where: { entityId: rate.id },
        orderBy: { occurredAt: 'desc' },
      });
      expect(JSON.stringify(logged?.changes)).toContain('cost.ORIGIN_HANDLING.amount');
    });

    it('are kept as they were on a cancelled card', async () => {
      const rate = await card();
      await r.post(`/rates/${rate.id}/cancel`, cookies.pricingJed).expect(200);
      await r
        .put(`/rates/${rate.id}/costs/OTHER`, cookies.pricingJed, { status: 'NOT_APPLICABLE' })
        .expect(409);
    });
  });

  describe('expected margin', () => {
    beforeAll(async () => {
      await contract(outlets.carton, percent('10', { priceCategoryCode: 'CARTON' }));
      await contract(outlets.carton, percent('5'));
      await contract(outlets.general, percent('5'));
    });

    const enter = (rate: RateCardDto, component: string, body: object) =>
      r.put(`/rates/${rate.id}/costs/${component}`, cookies.pricingJed, body).expect(200);
    const usd = (amount: string, unit = 'PER_PIECE', extra: object = {}) => ({
      status: 'ENTERED',
      amount,
      currency: 'USD',
      unit,
      ...extra,
    });

    it('is incomplete, naming each missing component, never a guessed number', async () => {
      const rate = await card();
      const m = await margin(rate);
      expect(m).toMatchObject({
        currency: 'USD',
        quantity: null,
        price: '100',
        expectedMargin: null,
        incomplete: true,
        missing: ['OUTLET_COMMISSION', 'ORIGIN_HANDLING', 'SEA_FREIGHT', 'DISTRIBUTION', 'OTHER'],
      });
      expect(line(m, 'OUTLET_COMMISSION')?.gap).toBe('OUTLET_NOT_CHOSEN');
      expect(line(m, 'SEA_FREIGHT')?.gap).toBe('NOT_ENTERED');
    });

    it('brings every cost to the card’s unit and takes the outlet’s own contract', async () => {
      const rate = await card();
      await enter(rate, 'ORIGIN_HANDLING', usd('10'));
      await enter(rate, 'SEA_FREIGHT', usd('1000', 'PER_CONTAINER'));
      await enter(rate, 'DISTRIBUTION', { status: 'NOT_APPLICABLE' });
      await enter(rate, 'OTHER', usd('0'));
      const unconverted = await margin(rate, `?outletId=${outlets.carton.id}`);
      expect(unconverted).toMatchObject({ expectedMargin: null, missing: ['SEA_FREIGHT'] });
      expect(line(unconverted, 'SEA_FREIGHT')?.gap).toBe('UNIT_NOT_CONVERTIBLE');

      await enter(rate, 'SEA_FREIGHT', usd('1000', 'PER_CONTAINER', { unitsPerCostUnit: '400' }));
      // The CARTON contract (10%) beats the outlet's contract for every category (5%).
      const carton = await margin(rate, `?outletId=${outlets.carton.id}`);
      expect(carton).toMatchObject({ expectedMargin: '77.5', incomplete: false, missing: [] });
      expect(line(carton, 'SEA_FREIGHT')?.amount).toBe('2.5');
      expect(line(carton, 'OUTLET_COMMISSION')?.amount).toBe('10');
      expect(line(carton, 'DISTRIBUTION')).toMatchObject({ amount: '0', notApplicable: true });
      expect((await margin(rate, `?outletId=${outlets.general.id}`)).expectedMargin).toBe('82.5');
      const none = await margin(rate, `?outletId=${outlets.none.id}`);
      expect(none.expectedMargin).toBeNull();
      expect(line(none, 'OUTLET_COMMISSION')?.gap).toBe('NO_CONTRACT');

      // Three pieces under the 500 minimum: the line is 500, the commission 10% of it.
      const three = await margin(rate, `?outletId=${outlets.carton.id}&quantity=3`);
      expect(three).toMatchObject({ quantity: '3', price: '500', expectedMargin: '412.5' });

      const refused = await r
        .get(`/rates/${rate.id}/expected-margin?outletId=${outlets.dxb.id}`, cookies.pricingJed)
        .expect(400);
      expect(refused.body).toMatchObject({ code: 'OUTLET_NOT_USABLE' });
    });

    it('needs an exchange rate for a cost in another currency', async () => {
      const rate = await card();
      for (const component of ['SEA_FREIGHT', 'DISTRIBUTION', 'OTHER']) {
        await enter(rate, component, { status: 'NOT_APPLICABLE' });
      }
      await enter(rate, 'ORIGIN_HANDLING', {
        status: 'ENTERED',
        amount: '20',
        currency: testCurrency,
        unit: 'PER_PIECE',
      });
      const query = `?outletId=${outlets.general.id}`;
      const missing = await margin(rate, query);
      expect(missing.expectedMargin).toBeNull();
      expect(line(missing, 'ORIGIN_HANDLING')?.gap).toBe('NO_FX_RATE');
      const admin = await t.prisma.user.findFirstOrThrow({
        where: { email: { startsWith: 'it-' }, roles: { some: { role: 'ADMINISTRATOR' } } },
      });
      await t.prisma.fxRate.create({
        data: {
          currency: testCurrency,
          rateDate: new Date(today()),
          rate: 4,
          createdById: admin.id,
        },
      });
      // 20 units at 4 per USD = 5 USD; 100 - 5 (commission 5%) - 5 = 90.
      const converted = await margin(rate, query);
      expect(line(converted, 'ORIGIN_HANDLING')?.amount).toBe('5');
      expect(converted.expectedMargin).toBe('90');
    });
  });
});
