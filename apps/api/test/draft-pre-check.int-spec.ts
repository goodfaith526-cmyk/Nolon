import type {
  AgentClientCreatedDto,
  CustomerDto,
  DraftPreCheckDto,
  EntryDraftSummaryDto,
  QuotationDraftDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import {
  AGENT_PREFIX,
  draftKey,
  registerClient,
  requests,
  tokenFor,
} from './agent-drafts-helpers.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

// Pre-checks (POST /<kind>-drafts/check): what a create with these values would get from NOLON
// now, for this user, with nothing written. A refusal comes back as data naming its field and
// code; a missing route permission stays a 403.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let customer: CustomerDto;
let jedCustomer: CustomerDto;
let jebelAli: string;
let portSudan: string;

const cookies = { admin: '', salesDxb: '', salesJed: '' };
const tokens = { sales: '', ops: '', wh: '', finance: '', admin: '' };

const tomorrowPlus = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function quotationRequest(extra: object = {}) {
  return {
    customerId: customer.id,
    originLocationId: jebelAli,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    cargoDescription: 'Spare parts',
    currency: 'USD',
    validUntil: tomorrowPlus(10),
    terms: null,
    lines: [
      {
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_SHIPMENT',
        unitPrice: '1500.50',
        quantity: '2',
        discount: '1.5',
        description: 'Ocean freight',
      },
    ],
    ...extra,
  };
}

function bookingRequest(extra: object = {}) {
  return {
    customerId: customer.id,
    originLocationId: jebelAli,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'GENERAL',
    services: ['MAIN_FREIGHT'],
    items: [{ cargoType: 'GENERAL', quantity: 10, weightKg: '1000.5' }],
    ...extra,
  };
}

const check = async (path: string, token: string, body: object) =>
  (await r.agentPost(`${path}/check`, token, body).expect(200)).body as DraftPreCheckDto;

function refused(result: DraftPreCheckDto) {
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  const dxb = await branchId(t.prisma, 'DXB');
  const jed = await branchId(t.prisma, 'JED');
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  jebelAli = await loc('AEJEA');
  portSudan = await loc('SDPZU');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Pre-check platform');
  const agents = {
    sales: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    ops: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    wh: await createUser(t.prisma, ['WAREHOUSE'], ['DXB'], AGENT_PREFIX),
    finance: await createUser(t.prisma, ['FINANCE'], ['DXB'], AGENT_PREFIX),
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], ['DXB'], AGENT_PREFIX),
  };
  for (const key of Object.keys(agents) as (keyof typeof agents)[]) {
    tokens[key] = await tokenFor(t, await signIn(t, agents[key].email), client);
  }
  const newCustomer = async (branch: string, cookie: string, name: string) =>
    (
      await r
        .post('/customers', cookie, {
          branchId: branch,
          kind: 'COMPANY',
          name,
          phone: uniquePhone(),
        })
        .expect(201)
    ).body as CustomerDto;
  customer = await newCustomer(dxb, cookies.salesDxb, 'Pre-check Test Trading');
  jedCustomer = await newCustomer(jed, cookies.salesJed, 'Pre-check JED Trading');
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('a pre-check', () => {
  it('passes good values with a fingerprint of them, and writes nothing', async () => {
    const before = await t.prisma.bookingDraft.count();
    const first = await check('/booking-drafts', tokens.ops, bookingRequest());
    expect(first).toMatchObject({ ok: true, total: null, currency: null, priceSources: null });
    expect(first.valuesHash).toMatch(/^[0-9a-f]{64}$/);
    // The same values give the same fingerprint, whatever key came with them; others do not.
    const again = await check('/booking-drafts', tokens.ops, {
      ...bookingRequest(),
      idempotencyKey: draftKey(),
    });
    expect(again.valuesHash).toBe(first.valuesHash);
    const other = await check('/booking-drafts', tokens.ops, bookingRequest({ cargoType: 'FOOD' }));
    expect(other.valuesHash).not.toBe(first.valuesHash);
    expect(await t.prisma.bookingDraft.count()).toBe(before);
  });

  it('names the field and the code of a broken rule', async () => {
    const result = refused(
      await check(
        '/booking-drafts',
        tokens.ops,
        bookingRequest({ destinationLocationId: jebelAli }),
      ),
    );
    expect(result.valuesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.refusals.length).toBeGreaterThan(0);
    for (const refusal of result.refusals) {
      expect(refusal).toMatchObject({ code: 'SAME_ROUTE', message: expect.any(String) as string });
      expect(['originLocationId', 'destinationLocationId']).toContain(refusal.field);
    }
  });

  it('names each malformed field, with no fingerprint', async () => {
    const result = refused(
      await check(
        '/booking-drafts',
        tokens.ops,
        bookingRequest({ items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '12٬5' }] }),
      ),
    );
    expect(result.valuesHash).toBeNull();
    expect(result.refusals).toEqual([
      expect.objectContaining({ field: 'items.0.weightKg', code: 'INVALID' }),
    ]);
  });

  it("refuses a customer outside the user's branches as a refusal, not a create", async () => {
    const before = await t.prisma.bookingDraft.count();
    const result = refused(
      await check('/booking-drafts', tokens.ops, bookingRequest({ customerId: jedCustomer.id })),
    );
    expect(result.refusals.length).toBeGreaterThan(0);
    expect(await t.prisma.bookingDraft.count()).toBe(before);
  });

  it("needs the create's permission, through the assistant and on the screen", async () => {
    await r.agentPost('/booking-drafts/check', tokens.wh, bookingRequest()).expect(403);
    await r.agentPost('/quotation-drafts/check', tokens.finance, quotationRequest()).expect(403);
    await r.agentPost('/quotation-drafts/check', tokens.ops, quotationRequest()).expect(403);
    await r.post('/quotation-drafts/check', cookies.salesDxb, quotationRequest()).expect(200);
  });

  it('gives the total and price sources a draft with the same values shows', async () => {
    const result = await check('/quotation-drafts', tokens.sales, quotationRequest());
    if (!result.ok) throw new Error(JSON.stringify(result.refusals));
    expect(result.priceSources).toEqual([{ source: 'TYPED', rateCardId: null }]);
    expect(result.currency).toBe('USD');
    const created = (
      await r
        .agentPost('/quotation-drafts', tokens.sales, {
          ...quotationRequest(),
          idempotencyKey: draftKey(),
        })
        .expect(201)
    ).body as EntryDraftSummaryDto;
    const draft = (await r.get(`/quotation-drafts/${created.id}`, cookies.salesDxb).expect(200))
      .body as QuotationDraftDto;
    expect(draft.check).toMatchObject({ ok: true, total: result.total });
  });

  it("refuses a new customer's phone already taken in the branch, as the create would", async () => {
    const booking: Partial<ReturnType<typeof bookingRequest>> = bookingRequest();
    delete booking.customerId;
    const body = {
      idempotencyKey: draftKey(),
      branchId: customer.branchId,
      customer: { kind: 'INDIVIDUAL', name: 'Amna Osman', phone: customer.phone },
      booking,
    };
    const result = refused(await check('/new-customer-booking-drafts', tokens.sales, body));
    expect(result.refusals).toMatchObject([{ field: 'customer.phone' }]);
    // The create refuses the same values, and the check wrote nothing.
    await r.agentPost('/new-customer-booking-drafts', tokens.sales, body).expect(409);
    const free = { ...body, customer: { ...body.customer, phone: uniquePhone() } };
    expect((await check('/new-customer-booking-drafts', tokens.sales, free)).ok).toBe(true);
  });

  it('is open to the assistant on every draft kind it may create', async () => {
    const paths = [
      '/booking-drafts',
      '/new-customer-booking-drafts',
      '/quotation-drafts',
      '/new-customer-quotation-drafts',
      '/invoice-drafts',
      '/receipt-drafts',
      '/trip-drafts',
      '/release-drafts',
      '/shipment-status-drafts',
      '/party-drafts',
      '/customer-drafts',
      '/rate-card-drafts',
    ];
    for (const path of paths) {
      const result = refused(await check(path, tokens.admin, {}));
      // An empty body: the schema's refusals (no values to hash), or for a kind with no required
      // business value, the branch such a draft needs when it names no customer or shipment.
      const codes = result.refusals.map((x) => x.code);
      if (result.valuesHash === null) {
        expect(
          codes.every((c) => c === 'INVALID'),
          path,
        ).toBe(true);
      } else {
        expect(result.refusals, path).toMatchObject([
          { field: 'branchId', code: 'BRANCH_REQUIRED' },
        ]);
      }
    }
  });
});
