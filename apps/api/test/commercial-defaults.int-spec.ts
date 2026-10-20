import { randomInt } from 'node:crypto';
import type {
  BookingDto,
  BookingFromQuotationPreviewDto,
  BookingPartySuggestionDto,
  CustomerDto,
  CustomerPartyAddedDto,
  QuotationDefaultsDto,
  QuotationDto,
  RateCardDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../src/common/dates.js';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

const FAR_FUTURE = '2099-12-31';
// Each rate starts on a day of its own in the past: a branch holds one draft or approved rate
// per offer, start date included.
let rateDay = randomInt(0, 6000);
const nextRateDay = () =>
  new Date(Date.UTC(2000, 0, 1) + rateDay++ * 86_400_000).toISOString().slice(0, 10);

/**
 * Functional review, group B: the values a new quotation and a new booking start from (the
 * quotation's currency and validity, the booking's parties, a booking prefilled from its
 * quotation). Suggestions only: what the person sends is what is saved.
 */
describe('commercial defaults (functional review B1, B3, B4, B5)', () => {
  let t: TestApp;
  let dxb: string;
  let jed: string;
  let jebelAli: string;
  let portSudan: string;
  const cookies = { sales: '', salesJed: '', pricing: '', finance: '', ops: '' };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  async function customer(overrides: object = {}, branch = dxb): Promise<CustomerDto> {
    const res = await post('/customers', cookies.sales, {
      branchId: branch,
      kind: 'COMPANY',
      name: 'Defaults Trading',
      phone: uniquePhone(),
      ...overrides,
    }).expect(201);
    return res.body as CustomerDto;
  }

  async function party(customerId: string, name: string): Promise<string> {
    const res = await post(`/customers/${customerId}/parties`, cookies.sales, { name }).expect(201);
    return (res.body as CustomerPartyAddedDto).addedPartyId;
  }

  async function approvedRate(overrides: object): Promise<RateCardDto> {
    const draft = (
      await post('/rates', cookies.pricing, {
        branchId: dxb,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        containerTypeCode: '40HC',
        unit: 'PER_CONTAINER',
        price: '1000',
        currency: 'USD',
        validFrom: nextRateDay(),
        validTo: FAR_FUTURE,
        ...overrides,
      }).expect(201)
    ).body as RateCardDto;
    return (await post(`/rates/${draft.id}/approve`, cookies.pricing).expect(200))
      .body as RateCardDto;
  }

  async function approvedQuotation(customerId: string, lines: object[]): Promise<QuotationDto> {
    const q = (
      await post('/quotations', cookies.sales, {
        customerId,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        cargoDescription: 'Tyres',
        currency: 'USD',
        validUntil: FAR_FUTURE,
        lines,
      }).expect(201)
    ).body as QuotationDto;
    await post(`/quotations/${q.id}/send`, cookies.sales).expect(200);
    return (await post(`/quotations/${q.id}/approve`, cookies.sales).expect(200))
      .body as QuotationDto;
  }

  async function booking(customerId: string, parties: object, status?: 'CANCELLED') {
    const created = (
      await post('/bookings', cookies.sales, {
        customerId,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        services: [],
        items: [],
        ...parties,
      }).expect(201)
    ).body as BookingDto;
    if (status === 'CANCELLED') {
      await post(`/bookings/${created.id}/cancel`, cookies.sales, { reason: 'test' }).expect(200);
    }
    return created;
  }

  beforeAll(async () => {
    // The validity days are configuration: 14 here, so the default is not taken for granted.
    t = await createTestApp({ QUOTATION_VALIDITY_DAYS: 14 });
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jebelAli = await loc('AEJEA');
    portSudan = await loc('SDPZU');
    const users = {
      sales: await createUser(t.prisma, ['SALES'], ['DXB']),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
      pricing: await createUser(t.prisma, ['SALES_MARKETING_MANAGER'], ['DXB']),
      finance: await createUser(t.prisma, ['FINANCE'], ['DXB']),
      ops: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('GET /quotations/defaults', () => {
    const dubaiToday = () => todayIn('Asia/Dubai');

    it("offers the customer's preferred currency and the branch's today plus the set days", async () => {
      const c = await customer({ preferredCurrency: 'USD' });
      const res = await get(`/quotations/defaults?customerId=${c.id}`, cookies.sales).expect(200);
      const today = dubaiToday();
      expect(res.body).toEqual({
        customerId: c.id,
        currency: 'USD',
        currencySource: 'CUSTOMER',
        today,
        validUntil: addDays(today, 14),
        validityDays: 14,
      } satisfies QuotationDefaultsDto);
    });

    it("falls back to the branch's currency without a preferred one", async () => {
      const c = await customer();
      const res = await get(`/quotations/defaults?customerId=${c.id}`, cookies.sales).expect(200);
      expect(res.body).toMatchObject({ currency: 'AED', currencySource: 'BRANCH' });
    });

    it("falls back to the branch's currency when the preferred one is inactive", async () => {
      const c = await customer({ preferredCurrency: 'EUR' });
      await t.prisma.currency.update({ where: { code: 'EUR' }, data: { isActive: false } });
      try {
        const res = await get(`/quotations/defaults?customerId=${c.id}`, cookies.sales).expect(200);
        expect(res.body).toMatchObject({ currency: 'AED', currencySource: 'BRANCH' });
      } finally {
        await t.prisma.currency.update({ where: { code: 'EUR' }, data: { isActive: true } });
      }
    });

    it("uses the customer's own branch for the currency and the day", async () => {
      // A Jeddah salesperson's customer: SAR, Riyadh's today.
      const res = await post('/customers', cookies.salesJed, {
        branchId: jed,
        kind: 'COMPANY',
        name: 'Jeddah Defaults',
        phone: uniquePhone(),
      }).expect(201);
      const c = res.body as CustomerDto;
      const d = (await get(`/quotations/defaults?customerId=${c.id}`, cookies.salesJed).expect(200))
        .body as QuotationDefaultsDto;
      expect(d.currency).toBe('SAR');
      expect(d.today).toBe(todayIn('Asia/Riyadh'));
    });

    it("refuses another branch's customer, a user who cannot create quotations, and no customer", async () => {
      const c = await customer({ preferredCurrency: 'USD' });
      await get(`/quotations/defaults?customerId=${c.id}`, cookies.salesJed).expect(404);
      await get(`/quotations/defaults?customerId=${c.id}`, cookies.finance).expect(403);
      await get('/quotations/defaults', cookies.sales).expect(400);
      await get('/quotations/defaults?customerId=nope', cookies.sales).expect(400);
    });

    it('keeps the currency and validity the person sends', async () => {
      const c = await customer({ preferredCurrency: 'USD' });
      const res = await post('/quotations', cookies.sales, {
        customerId: c.id,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        currency: 'EUR',
        validUntil: FAR_FUTURE,
        lines: [
          { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', unitPrice: '10', quantity: '1' },
        ],
      }).expect(201);
      expect(res.body).toMatchObject({ currency: 'EUR', validUntil: FAR_FUTURE });
    });
  });

  describe('GET /bookings/party-suggestion', () => {
    const suggestion = async (customerId: string, cookie = cookies.sales) =>
      (await get(`/bookings/party-suggestion?customerId=${customerId}`, cookie).expect(200))
        .body as BookingPartySuggestionDto;

    it('suggests nothing for a customer without parties', async () => {
      const c = await customer();
      expect(await suggestion(c.id)).toEqual({
        customerId: c.id,
        source: null,
        bookingId: null,
        bookingNumber: null,
        shipperId: null,
        consigneeId: null,
        notifyPartyId: null,
      });
    });

    it("suggests the customer's only party as consignee", async () => {
      const c = await customer();
      const only = await party(c.id, 'Only consignee');
      expect(await suggestion(c.id)).toMatchObject({
        source: 'ONLY_PARTY',
        bookingId: null,
        shipperId: null,
        consigneeId: only,
        notifyPartyId: null,
      });
    });

    it('suggests nothing from two parties and no booking', async () => {
      const c = await customer();
      await party(c.id, 'One');
      await party(c.id, 'Two');
      expect((await suggestion(c.id)).source).toBeNull();
    });

    it("suggests the parties of the customer's latest booking naming any, not a cancelled one", async () => {
      const c = await customer();
      const shipper = await party(c.id, 'Shipper');
      const consignee = await party(c.id, 'Consignee');
      const other = await party(c.id, 'Other');
      const last = await booking(c.id, { shipperId: shipper, consigneeId: consignee });
      // Later bookings: one cancelled, one naming no party. Neither is a source.
      await booking(c.id, { shipperId: other, consigneeId: other }, 'CANCELLED');
      await booking(c.id, {});
      expect(await suggestion(c.id)).toEqual({
        customerId: c.id,
        source: 'LAST_BOOKING',
        bookingId: last.id,
        bookingNumber: last.number,
        shipperId: shipper,
        consigneeId: consignee,
        notifyPartyId: null,
      });
      // Another customer's booking is never the source.
      const second = await customer();
      expect((await suggestion(second.id)).source).toBeNull();
    });

    it("refuses another branch's customer and a user who cannot create bookings", async () => {
      const c = await customer();
      await party(c.id, 'Only');
      await get(`/bookings/party-suggestion?customerId=${c.id}`, cookies.salesJed).expect(404);
      await get(`/bookings/party-suggestion?customerId=${c.id}`, cookies.finance).expect(403);
      await get('/bookings/party-suggestion', cookies.sales).expect(400);
    });
  });

  describe('GET /bookings/from-quotation/:id (preview)', () => {
    it('prefills the containers priced per container, never other charges, and creates nothing', async () => {
      const c = await customer({ preferredCurrency: 'USD' });
      const consignee = await party(c.id, 'Only consignee');
      const freight40 = await approvedRate({ containerTypeCode: '40HC' });
      const thc40 = await approvedRate({ containerTypeCode: '40HC', chargeTypeCode: 'THC' });
      const freight20 = await approvedRate({ containerTypeCode: '20GP' });
      const freight40gp = await approvedRate({ containerTypeCode: '40GP' });
      const q = await approvedQuotation(c.id, [
        // Freight and handling on the same two 40HC: two containers, not four.
        { rateCardId: freight40.id, quantity: '2' },
        { rateCardId: thc40.id, quantity: '2' },
        { rateCardId: freight20.id, quantity: '1' },
        // Not a whole number of containers: left for the person.
        { rateCardId: freight40gp.id, quantity: '1.5' },
        // Manual lines: no container type, or not per container.
        { chargeTypeCode: 'FREIGHT', unit: 'PER_CONTAINER', unitPrice: '5', quantity: '3' },
        { chargeTypeCode: 'DOCS', unit: 'PER_SHIPMENT', unitPrice: '50', quantity: '1' },
      ]);

      const res = await get(`/bookings/from-quotation/${q.id}`, cookies.sales).expect(200);
      const preview = res.body as BookingFromQuotationPreviewDto;
      expect(preview).toMatchObject({
        quotationId: q.id,
        quotationNumber: q.number,
        branchId: dxb,
        customerId: c.id,
        customerName: c.name,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        cargoDescription: 'Tyres',
        parties: { source: 'ONLY_PARTY', consigneeId: consignee },
      });
      expect(preview.items).toEqual([
        { cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 2 },
        { cargoType: 'CONTAINER', containerTypeCode: '20GP', quantity: 1 },
      ]);
      expect(await t.prisma.booking.count({ where: { quotationId: q.id } })).toBe(0);

      // Saved as reviewed, in one step: the booking holds what was sent.
      const saved = (
        await post(`/bookings/from-quotation/${q.id}`, cookies.sales, {
          items: preview.items,
          consigneeId: preview.parties.consigneeId,
        }).expect(201)
      ).body as BookingDto;
      expect(saved.quotationId).toBe(q.id);
      expect(saved.consigneeId).toBe(consignee);
      expect(saved.items.map((i) => [i.containerTypeCode, i.quantity])).toEqual([
        ['40HC', 2],
        ['20GP', 1],
      ]);
      // A quotation makes one booking: no second preview.
      await get(`/bookings/from-quotation/${q.id}`, cookies.sales).expect(409);
    });

    it('prefills no lines for a quotation that is not for containers', async () => {
      const c = await customer();
      const pallet = await approvedRate({
        loadType: 'LCL',
        cargoType: 'PALLET',
        containerTypeCode: null,
        unit: 'PER_PALLET',
      });
      const q = (
        await post('/quotations', cookies.sales, {
          customerId: c.id,
          originLocationId: jebelAli,
          destinationLocationId: portSudan,
          mode: 'SEA',
          loadType: 'LCL',
          cargoType: 'PALLET',
          currency: 'USD',
          validUntil: FAR_FUTURE,
          lines: [{ rateCardId: pallet.id, quantity: '4' }],
        }).expect(201)
      ).body as QuotationDto;
      await post(`/quotations/${q.id}/send`, cookies.sales).expect(200);
      await post(`/quotations/${q.id}/approve`, cookies.sales).expect(200);
      const preview = (await get(`/bookings/from-quotation/${q.id}`, cookies.sales).expect(200))
        .body as BookingFromQuotationPreviewDto;
      expect(preview.items).toEqual([]);
      expect(preview.cargoType).toBe('PALLET');
    });

    it("refuses a quotation not approved, another branch's, and a user who cannot create bookings", async () => {
      const c = await customer();
      const draft = (
        await post('/quotations', cookies.sales, {
          customerId: c.id,
          originLocationId: jebelAli,
          destinationLocationId: portSudan,
          mode: 'SEA',
          loadType: 'FCL',
          cargoType: 'CONTAINER',
          currency: 'USD',
          validUntil: FAR_FUTURE,
          lines: [
            { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', unitPrice: '10', quantity: '1' },
          ],
        }).expect(201)
      ).body as QuotationDto;
      await get(`/bookings/from-quotation/${draft.id}`, cookies.sales).expect(409);
      await get(`/bookings/from-quotation/${draft.id}`, cookies.salesJed).expect(404);
      await get(`/bookings/from-quotation/${draft.id}`, cookies.finance).expect(403);
      // Operations creates bookings: allowed to read it, and refused only for its status.
      await get(`/bookings/from-quotation/${draft.id}`, cookies.ops).expect(409);
    });
  });
});
