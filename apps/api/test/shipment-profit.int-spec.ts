import { randomUUID } from 'node:crypto';
import type {
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  PartnerDto,
  ShipmentProfitViewDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requests } from './agent-drafts-helpers.js';
import {
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

// GET /reports/shipment-profitability/shipments/:id (business model plan 6.2): the shipment's
// finance tab, the expected margin from the rate cards it is priced from beside the actual one
// from the books. The route, charge type and rate card are this run's own, so no other suite's
// rates match. Shipments and invoices are never deleted, so the people keep the ledger prefix.

let t: TestApp;
let r: ReturnType<typeof requests>;
let pts: string;
let from: string;
let to: string;
let freight: string;
let rateId: string;
let customer: CustomerDto;
const cookies = { admin: '', salesPts: '', financePts: '', managerJed: '' };

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function shipment(salesOutletId?: string): Promise<string> {
  const booking = (
    await r
      .post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '10' }],
        ...(salesOutletId ? { salesOutletId } : {}),
      })
      .expect(201)
  ).body as BookingDto;
  const confirmed = (await r.post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
    .body as BookingDto;
  if (!confirmed.shipmentId) throw new Error('No shipment');
  return confirmed.shipmentId;
}

const view = async (id: string, cookie = cookies.financePts) =>
  (await r.get(`/reports/shipment-profitability/shipments/${id}`, cookie).expect(200))
    .body as ShipmentProfitViewDto;

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  pts = await branchId(t.prisma, 'PTS');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
    salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
    managerJed: await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const tag = `SP${randomUUID().slice(0, 6).toUpperCase()}`;
  const location = async (suffix: string) =>
    (
      await t.prisma.location.create({
        data: {
          code: `${tag}${suffix}`,
          kind: 'CITY',
          nameEn: `Profit test ${tag}${suffix}`,
          nameAr: 'مدينة اختبار الربحية',
          countryCode: 'SD',
        },
      })
    ).id;
  from = await location('A');
  to = await location('B');
  freight = `${tag}F`;
  await t.prisma.chargeType.create({
    data: { code: freight, nameEn: 'Profit freight', nameAr: 'نولون', service: 'MAIN_FREIGHT' },
  });
  // The freight card: 300 USD a shipment, its reference costs 50 for origin handling and 70 for
  // distribution, the rest not applicable.
  rateId = (
    await t.prisma.rateCard.create({
      data: {
        branchId: pts,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        chargeTypeCode: freight,
        unit: 'PER_SHIPMENT',
        price: '300',
        minimumCharge: '0',
        currency: 'USD',
        validFrom: new Date(`${day(-30)}T00:00:00Z`),
        status: 'APPROVED',
        createdById: people.admin.id,
        approvedById: people.admin.id,
        approvedAt: new Date(),
      },
    })
  ).id;
  const entered = (amount: string) => ({
    status: 'ENTERED',
    amount,
    currency: 'USD',
    unit: 'PER_SHIPMENT',
  });
  await r.put(`/rates/${rateId}/costs/ORIGIN_HANDLING`, cookies.admin, entered('50')).expect(200);
  await r.put(`/rates/${rateId}/costs/DISTRIBUTION`, cookies.admin, entered('70')).expect(200);
  for (const component of ['SEA_FREIGHT', 'OTHER']) {
    await r
      .put(`/rates/${rateId}/costs/${component}`, cookies.admin, { status: 'NOT_APPLICABLE' })
      .expect(200);
  }
  customer = (
    await r
      .post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Shipment Profit ${tag}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      })
      .expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await t.close();
});

describe("a shipment's expected and actual profit (plan 6.2)", () => {
  it('shows the expected margin from its card and, once posted, the actual one apart', async () => {
    const id = await shipment();
    const before = await view(id);
    // Nothing posted yet; sold without an outlet, so no commission: 300 - 50 - 70.
    expect(before.actual).toBeNull();
    expect(before.expected).toMatchObject({
      source: 'RATE_CARDS',
      gaps: [],
      currency: 'USD',
      expectedMargin: '180',
    });
    expect(
      before.expected?.cards.map((c) => [c.chargeTypeCode, c.rateCardId, c.quantity, c.price]),
    ).toEqual([[freight, rateId, '1', '300']]);

    // The invoice from the same card posts 300 of revenue: the actual figure, with no cost yet.
    const draft = (
      await r
        .post('/customer-invoices', cookies.financePts, {
          shipmentId: id,
          acknowledgedInvoiceIds: [],
        })
        .expect(201)
    ).body as CustomerInvoiceDto;
    await r.post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200);
    const after = await view(id);
    expect(after.actual).toMatchObject({
      revenueUsd: '300',
      costUsd: '0',
      marginUsd: '300',
      missingCosts: ['MAIN_FREIGHT'],
    });
    expect(after.actual?.incompleteReasons).toContain('MISSING_COST');
    // The expected figure stays what the card gives: nothing moves from the books into it.
    expect(after.expected?.expectedMargin).toBe('180');
  });

  it("takes the outlet's commission for a shipment sold through one", async () => {
    const outlet = (
      await r
        .post('/partners', cookies.admin, {
          kind: 'SALES_OUTLET',
          branchId: pts,
          name: `Profit outlet ${randomUUID().slice(0, 6)}`,
          countryCode: 'SD',
          currency: 'USD',
        })
        .expect(201)
    ).body as PartnerDto;
    const id = await shipment(outlet.id);
    // No contract yet: the commission is unknown, so is the margin.
    const none = await view(id);
    expect(none.expected?.expectedMargin).toBeNull();
    expect(none.expected?.cards[0]?.missing).toEqual(['OUTLET_COMMISSION']);
    const contract = (
      await r
        .post(`/partners/${outlet.id}/contracts`, cookies.admin, {
          basis: 'PERCENT_OF_PRICE',
          value: '10',
          validFrom: '2020-01-01',
        })
        .expect(201)
    ).body as { id: string };
    await r.post(`/partner-contracts/${contract.id}/approve`, cookies.admin).expect(200);
    // 300 - 30 - 50 - 70.
    expect((await view(id)).expected?.expectedMargin).toBe('150');
  });

  it("is 404 for another branch's shipment and 403 without the permission", async () => {
    const id = await shipment();
    await r.get(`/reports/shipment-profitability/shipments/${id}`, cookies.managerJed).expect(404);
    await r.get(`/reports/shipment-profitability/shipments/${id}`, cookies.salesPts).expect(403);
    await r
      .get(`/reports/shipment-profitability/shipments/${randomUUID()}`, cookies.financePts)
      .expect(404);
  });
});
