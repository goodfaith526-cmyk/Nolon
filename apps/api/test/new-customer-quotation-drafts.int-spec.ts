import { randomUUID } from 'node:crypto';
import type {
  AgentClientCreatedDto,
  CustomerDto,
  DraftPreCheckDto,
  MyDraftItemDto,
  NewCustomerQuotationDraftDto,
  NewCustomerQuotationDraftListItemDto,
  NewCustomerQuotationDraftSummaryDto,
  QuotationDto,
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

// Quotations for a new customer, proposed by the staff assistant in one request with the customer
// (entry drafts). The assistant's users (agent-it-) create drafts; it- users approve them, which
// creates the customer and the quotation together, so both are removed by the usual cleanup. The
// rates are on a route of this run's own two locations (ZZ, removed by the cleanup), so no other
// suite's rate can price a line.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let jed: string;
let from: string;
let to: string;
let ratesBy: string;

const cookies = { admin: '', salesDxb: '', salesJed: '', managerDxb: '', financeDxb: '' };
const tokens = { sales: '', sales2: '', manager: '', ops: '', moved: '' };
let movedAgentId = '';

const API = '/new-customer-quotation-drafts';
const FREIGHT_PRICE = '250.125';

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const message = (res: { body: unknown }) => (res.body as { message?: string }).message ?? '';

/** A freight line priced by NOLON (no rate card, no price) and a typed line. */
function request(extra: object = {}, quotation: object = {}) {
  return {
    idempotencyKey: draftKey(),
    branchId: dxb,
    customer: { kind: 'INDIVIDUAL', name: 'Amna Osman', phone: uniquePhone(), city: 'Omdurman' },
    quotation: {
      originLocationId: from,
      destinationLocationId: to,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      currency: 'USD',
      validUntil: day(10),
      lines: [
        { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: '2' },
        { chargeTypeCode: 'DOCS', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '15.50' },
      ],
      ...quotation,
    },
    ...extra,
  };
}

const createDraft = (body: object, token = tokens.sales) => r.agentPost(API, token, body);

async function created(
  body: object = request(),
  token = tokens.sales,
): Promise<NewCustomerQuotationDraftSummaryDto> {
  return (await createDraft(body, token).expect(201)).body as NewCustomerQuotationDraftSummaryDto;
}

const read = async (id: string, cookie = cookies.salesDxb) =>
  (await r.get(`${API}/${id}`, cookie).expect(200)).body as NewCustomerQuotationDraftDto;

/**
 * Approves as a person who reviewed it would: the pricing shown (read by a DXB salesperson) and
 * every value ticked; expects `status`.
 */
async function approveAsReviewed(id: string, status: number, cookie = cookies.salesDxb) {
  const draft = await read(id);
  return r
    .post(`${API}/${id}/approve`, cookie, {
      version: draft.version,
      pricingKey: draft.pricing?.key ?? '0'.repeat(64),
      confirmed: draft.evidence.map((e) => e.field),
    })
    .expect(status);
}

const draftsUnderKey = (key: string) =>
  t.prisma.newCustomerQuotationDraft.count({ where: { idempotencyKey: key } });

const customersWithPhone = (phone: string) => t.prisma.customer.count({ where: { phone } });

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  jed = await branchId(t.prisma, 'JED');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
    // May add customers and view quotations, not create them.
    managerDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
    financeDxb: await createUser(t.prisma, ['FINANCE'], ['DXB']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  ratesBy = people.salesDxb.id;
  const assistantUsers = {
    sales: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    sales2: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    manager: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB'], AGENT_PREFIX),
    // Operations may create neither quotations nor customers.
    ops: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    // Loses DXB in a test.
    moved: await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], AGENT_PREFIX),
  };
  client = await registerClient(t, cookies.admin, 'New customer quotation draft platform');
  movedAgentId = assistantUsers.moved.id;
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    tokens[key] = await tokenFor(t, await signIn(t, assistantUsers[key].email), client);
  }

  const tag = randomUUID().slice(0, 6).toUpperCase();
  const location = async (suffix: string) =>
    (
      await t.prisma.location.create({
        data: {
          code: `ZZ${tag}${suffix}`,
          kind: 'CITY',
          nameEn: `New customer quotation ${tag}${suffix}`,
          nameAr: 'مدينة اختبار عرض السعر',
          countryCode: 'SD',
        },
      })
    ).id;
  from = await location('A');
  to = await location('B');
  await rate(FREIGHT_PRICE, day(-30));
});

/** An approved FREIGHT rate of DXB on this run's route; the latest started is the one used. */
async function rate(price: string, validFrom: string): Promise<string> {
  const created = await t.prisma.rateCard.create({
    data: {
      branchId: dxb,
      originLocationId: from,
      destinationLocationId: to,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      chargeTypeCode: 'FREIGHT',
      unit: 'PER_SHIPMENT',
      price,
      minimumCharge: '0',
      currency: 'USD',
      validFrom: new Date(`${validFrom}T00:00:00Z`),
      validTo: null,
      status: 'APPROVED',
      createdById: ratesBy,
      approvedById: ratesBy,
      approvedAt: new Date(),
    },
  });
  return created.id;
}

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('quotations for a new customer: the assistant proposes', () => {
  it('creates one draft holding the customer and the quotation, and nothing else', async () => {
    const evidence = [
      { field: 'name', quote: 'العميلة آمنة عثمان' },
      { field: 'phone', quote: 'رقمها' },
      { field: 'destinationLocationId', quote: 'لبورتسودان' },
      { field: 'lines[0].quantity', quote: 'شحنتين' },
    ];
    const body = request({ evidence });
    const summary = await created(body);
    expect(Object.keys(summary).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'status', 'version'].sort(),
    );
    expect(summary).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 2 });
    const draft = await read(summary.id);
    expect(draft).toMatchObject({
      branchId: dxb,
      branchCode: 'DXB',
      subject: 'Amna Osman',
      customerId: null,
      quotationId: null,
      actions: { canDecide: true },
      check: { ok: true, total: '515.75', currency: 'USD' },
      priceSources: [
        { source: 'RATE_CARD', rateCardId: expect.any(String) as string },
        { source: 'TYPED', rateCardId: null },
      ],
    });
    expect(draft.customer).toMatchObject({
      kind: 'INDIVIDUAL',
      name: 'Amna Osman',
      phone: body.customer.phone,
      city: 'Omdurman',
      email: null,
    });
    // The system-priced line is stored without a price; NOLON prices it on every read.
    expect(draft.request.lines[0]).not.toHaveProperty('unitPrice');
    expect(draft.request.lines[1]).toMatchObject({ unitPrice: '15.5' });
    expect(draft.pricing?.lines[0]).toMatchObject({ unitPrice: '250.125', lineTotal: '500.25' });
    expect(draft.evidence.map((e) => e.field)).toEqual(evidence.map((e) => e.field));
    expect(await customersWithPhone(body.customer.phone)).toBe(0);
    expect(
      await t.prisma.customerDraft.count({ where: { idempotencyKey: body.idempotencyKey } }),
    ).toBe(0);
  });

  it('stores the quantities and prices as decimals, never numbers', async () => {
    const summary = await created();
    const lines = await t.prisma.newCustomerQuotationDraftLine.findMany({
      where: { draftId: summary.id },
      orderBy: { lineNo: 'asc' },
    });
    expect(lines.map((l) => [l.quantity.toString(), l.unitPrice?.toString() ?? null])).toEqual([
      ['2', null],
      ['1', '15.5'],
    ]);
  });

  it('the pre-check gives the system price a draft would get, named by its path', async () => {
    const res = await r.agentPost(`${API}/check`, tokens.sales, request()).expect(200);
    const result = res.body as DraftPreCheckDto;
    if (!result.ok) throw new Error(JSON.stringify(result.refusals));
    expect(result.total).toBe('515.75');
    expect(result.computed).toEqual([
      {
        field: 'quotation.lines.0.unitPrice',
        value: '250.125',
        source: 'RATE_CARD',
        rateCardId: expect.any(String) as string,
      },
    ]);
    expect(
      await t.prisma.newCustomerQuotationDraft.count({ where: { createdById: ratesBy } }),
    ).toBe(0);
  });

  it('refuses a system price with no matching rate at the field, creating nothing', async () => {
    const noRate = request(
      {},
      {
        lines: [{ chargeTypeCode: 'STORAGE', unit: 'PER_SHIPMENT', quantity: '1' }],
      },
    );
    const res = await createDraft(noRate).expect(400);
    expect(res.body).toMatchObject({
      code: 'RATE_NO_MATCH',
      fields: ['quotation.lines.0.unitPrice'],
    });
    expect(await draftsUnderKey(noRate.idempotencyKey)).toBe(0);
    const check = (await r.agentPost(`${API}/check`, tokens.sales, noRate).expect(200))
      .body as DraftPreCheckDto;
    expect(check).toMatchObject({
      ok: false,
      refusals: [{ field: 'quotation.lines.0.unitPrice', code: 'RATE_NO_MATCH' }],
    });
  });

  it('creates nothing when the quotation or the customer is refused', async () => {
    const sameRoute = request({}, { destinationLocationId: from });
    await createDraft(sameRoute).expect(400);
    expect(await draftsUnderKey(sameRoute.idempotencyKey)).toBe(0);

    const past = request({}, { validUntil: day(-1) });
    const refused = await createDraft(past).expect(400);
    expect(refused.body).toMatchObject({ fields: ['quotation.validUntil'] });
    expect(await draftsUnderKey(past.idempotencyKey)).toBe(0);
  });

  it('refuses a customer already in the branch (its phone), creating nothing', async () => {
    const taken = request();
    await r
      .post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'INDIVIDUAL',
        name: 'Already here',
        phone: taken.customer.phone,
      })
      .expect(201);
    await createDraft(taken).expect(409);
    expect(await draftsUnderKey(taken.idempotencyKey)).toBe(0);
    const check = (await r.agentPost(`${API}/check`, tokens.sales, taken).expect(200))
      .body as DraftPreCheckDto;
    expect(check).toMatchObject({ ok: false, refusals: [{ field: 'customer.phone' }] });
  });

  it('refuses bad fields: a customer id, no lines, a number for a quantity, words for a missing line', async () => {
    const before = await t.prisma.newCustomerQuotationDraft.count();
    await createDraft(request({}, { customerId: from })).expect(400);
    await createDraft(request({}, { lines: [] })).expect(400);
    await createDraft(
      request({}, { lines: [{ chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: 2 }] }),
    ).expect(400);
    await createDraft(request({ evidence: [{ field: 'lines[2].quantity', quote: '2' }] })).expect(
      400,
    );
    await createDraft(request({ evidence: [{ field: 'lines[0].unit', quote: 'x' }] })).expect(400);
    await createDraft(request({ customerId: from })).expect(400);
    expect(await t.prisma.newCustomerQuotationDraft.count()).toBe(before);
  });

  it('returns the same draft for a repeat; the same key for another request is refused', async () => {
    const body = request();
    const first = await created(body);
    const again = await created({
      ...body,
      quotation: {
        ...body.quotation,
        lines: [
          { ...body.quotation.lines[0], quantity: '2.000' },
          { ...body.quotation.lines[1], unitPrice: '15.5' },
        ],
      },
    });
    expect(again).toEqual(first);
    await createDraft({ ...body, customer: { ...body.customer, name: 'Other' } }).expect(409);
    await createDraft({
      ...body,
      quotation: { ...body.quotation, validUntil: day(11) },
    }).expect(409);
    await createDraft({ ...body, evidence: [{ field: 'name', quote: 'Amna' }] }).expect(409);
    expect(await draftsUnderKey(body.idempotencyKey)).toBe(1);
    const found = (
      await r.agentGet(`${API}/by-key/${body.idempotencyKey}`, tokens.sales).expect(200)
    ).body as NewCustomerQuotationDraftSummaryDto;
    expect(found).toEqual(first);
    // Another user of the same assistant finds nothing under the key.
    await r.agentGet(`${API}/by-key/${body.idempotencyKey}`, tokens.sales2).expect(404);
  });

  it('settles a key it created under as CREATED, with its draft', async () => {
    const body = request();
    const summary = await created(body);
    const settled = await r
      .agentPost('/assistant-drafts/settle', tokens.sales, {
        kind: 'new_customer_quotation',
        idempotencyKey: body.idempotencyKey,
      })
      .expect(200);
    expect(settled.body).toEqual({ state: 'CREATED', draftId: summary.id });
  });

  // The key ledger's constraint (draft_key_settlements_draft_table_check, an existing migration)
  // does not list this table yet, so a NOT_CREATED answer cannot be recorded for it. Turn this on
  // once the ledger lists new_customer_quotation_drafts.
  it('refuses a create under a key settled as not created', async () => {
    const body = request();
    const settled = await r
      .agentPost('/assistant-drafts/settle', tokens.sales, {
        kind: 'new_customer_quotation',
        idempotencyKey: body.idempotencyKey,
      })
      .expect(200);
    expect(settled.body).toEqual({ state: 'NOT_CREATED' });
    const refused = await createDraft(body).expect(409);
    expect(refused.body).toMatchObject({ code: 'KEY_SETTLED' });
    expect(await draftsUnderKey(body.idempotencyKey)).toBe(0);
  });

  it('refuses another branch and a user who cannot create both a quotation and a customer', async () => {
    const other = request({ branchId: jed });
    await createDraft(other).expect(403);
    const manager = request();
    await createDraft(manager, tokens.manager).expect(403);
    const ops = request();
    await createDraft(ops, tokens.ops).expect(403);
    for (const body of [other, manager, ops]) {
      expect(await draftsUnderKey(body.idempotencyKey)).toBe(0);
    }
    await r.agentPost(`${API}/check`, tokens.manager, request()).expect(403);
    // A person proposes nothing here: they add the customer and the quotation themselves.
    await r.post(API, cookies.salesDxb, request()).expect(403);
  });

  it('cannot read, approve or reject the drafts: approval is a person’s, on the review screen', async () => {
    const summary = await created();
    const draft = await read(summary.id);
    await r.agentGet(API, tokens.sales).expect(403);
    await r.agentGet(`${API}/${summary.id}`, tokens.sales).expect(403);
    // No chat card and no decision from the chat: those routes do not exist for this kind.
    await r.agentGet(`${API}/${summary.id}/assistant`, tokens.sales).expect(404);
    await r
      .agentPost(`${API}/${summary.id}/approve`, tokens.sales, {
        version: 1,
        pricingKey: draft.pricing?.key,
        confirmed: [],
      })
      .expect(403);
    await r
      .agentPost(`${API}/${summary.id}/assistant-approve`, tokens.sales, {
        version: 1,
        contentHash: '0'.repeat(64),
      })
      .expect(404);
    await r
      .agentPost(`${API}/${summary.id}/reject`, tokens.sales, { version: 1, reason: 'no' })
      .expect(403);
    expect((await read(summary.id)).status).toBe('DRAFT');
  });
});

describe('quotations for a new customer: a person reviews', () => {
  it('shows drafts of their branches only; who cannot create both cannot decide', async () => {
    const summary = await created();
    const list = (await r.get(API, cookies.salesDxb).expect(200))
      .body as NewCustomerQuotationDraftListItemDto[];
    expect(list.find((d) => d.id === summary.id)).toMatchObject({
      subject: 'Amna Osman',
      lineCount: 2,
      branchCode: 'DXB',
      actions: { canDecide: true },
    });
    const jedList = (await r.get(API, cookies.salesJed).expect(200))
      .body as NewCustomerQuotationDraftListItemDto[];
    expect(jedList.some((d) => d.id === summary.id)).toBe(false);
    await r.get(`${API}/${summary.id}`, cookies.salesJed).expect(404);
    await approveAsReviewed(summary.id, 404, cookies.salesJed);
    await r
      .post(`${API}/${summary.id}/reject`, cookies.salesJed, { version: 1, reason: 'x' })
      .expect(404);
    for (const cookie of [cookies.financeDxb, cookies.managerDxb]) {
      expect((await read(summary.id, cookie)).actions.canDecide).toBe(false);
      await approveAsReviewed(summary.id, 403, cookie);
    }
    expect((await read(summary.id)).status).toBe('DRAFT');
  });

  it('creates the customer and the quotation at the system price together, on approval', async () => {
    const evidence = [
      { field: 'name', quote: 'آمنة' },
      { field: 'lines[1].unitPrice', quote: '15 ونص' },
      { field: 'originLocationId', quote: 'من هنا' },
    ];
    const body = request({ evidence });
    const summary = await created(body);
    const draft = await read(summary.id);
    const pricingKey = draft.pricing?.key ?? '';
    const confirmed = evidence.map((e) => e.field);
    const approve = (extra: object) =>
      r.post(`${API}/${summary.id}/approve`, cookies.salesDxb, { version: 1, ...extra });

    // Each value ticked first, and the prices reviewed.
    await approve({ pricingKey }).expect(400);
    await approve({ pricingKey, confirmed: ['name'] }).expect(400);
    await approve({ confirmed }).expect(400);
    await approve({ pricingKey: 'f'.repeat(64), confirmed }).expect(409);
    expect(await customersWithPhone(body.customer.phone)).toBe(0);

    const approved = (await approve({ pricingKey, confirmed }).expect(200))
      .body as NewCustomerQuotationDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null, pricing: null });
    expect(approved.customerId).not.toBeNull();
    expect(approved.quotationId).not.toBeNull();
    const customer = (
      await r.get(`/customers/${approved.customerId}`, cookies.salesDxb).expect(200)
    ).body as CustomerDto;
    expect(customer).toMatchObject({
      branchId: dxb,
      name: 'Amna Osman',
      phone: body.customer.phone,
      city: 'Omdurman',
    });
    expect(approved.customerNumber).toBe(customer.number);
    const quotation = (
      await r.get(`/quotations/${approved.quotationId}`, cookies.salesDxb).expect(200)
    ).body as QuotationDto;
    expect(quotation).toMatchObject({
      status: 'DRAFT',
      branchId: dxb,
      customerId: customer.id,
      originLocationId: from,
      destinationLocationId: to,
      currency: 'USD',
      total: '515.75',
    });
    expect(quotation.lines[0]).toMatchObject({
      chargeTypeCode: 'FREIGHT',
      unitPrice: '250.125',
      rateCardId: draft.priceSources?.[0]?.rateCardId,
    });
    expect(approved.quotationNumber).toBe(quotation.number);

    // Approving again returns it as it is; a replay of the request returns the saved draft.
    await approve({ pricingKey, confirmed }).expect(200);
    expect(await customersWithPhone(body.customer.phone)).toBe(1);
    expect(await t.prisma.quotation.count({ where: { customerId: customer.id } })).toBe(1);
    const replay = await created(body);
    expect(replay).toMatchObject({ id: summary.id, status: 'APPROVED' });
    // A new request for the same phone is the duplicate it is now.
    await createDraft({ ...body, idempotencyKey: draftKey() }).expect(409);

    const items = (
      await r
        .agentGet('/assistant-drafts/mine?kind=new_customer_quotation', tokens.sales)
        .expect(200)
    ).body as MyDraftItemDto[];
    expect(items.find((i) => i.id === summary.id)).toMatchObject({
      kind: 'new_customer_quotation',
      status: 'APPROVED',
      branchCode: 'DXB',
      reviewPath: `/drafts/new-customer-quotations/${summary.id}`,
      result: {
        type: 'quotation',
        id: quotation.id,
        number: quotation.number,
        path: `/quotations/${quotation.id}`,
      },
    });
  });

  it('refuses the approval, creating nothing, when the phone was taken since', async () => {
    const body = request();
    const summary = await created(body);
    const draft = await read(summary.id);
    await r
      .post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'INDIVIDUAL',
        name: 'Came first',
        phone: body.customer.phone,
      })
      .expect(201);
    const reread = await read(summary.id);
    expect(reread.check).toMatchObject({ ok: false });
    expect(reread.pricing).toBeNull();
    const res = await r
      .post(`${API}/${summary.id}/approve`, cookies.salesDxb, {
        version: 1,
        pricingKey: draft.pricing?.key,
        confirmed: [],
      })
      .expect(409);
    expect(message(res)).toMatch(/phone/i);
    expect(await customersWithPhone(body.customer.phone)).toBe(1);
    expect(
      await t.prisma.quotation.count({ where: { customer: { phone: body.customer.phone } } }),
    ).toBe(0);
    expect(await read(summary.id)).toMatchObject({ status: 'DRAFT', version: 1 });
  });

  it('refuses the approval when the system price changed since the review', async () => {
    // A route of its own, so the new rate prices no other test's line.
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const make = async (suffix: string) =>
      (
        await t.prisma.location.create({
          data: {
            code: `ZZ${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Repriced ${tag}${suffix}`,
            nameAr: 'مدينة اختبار',
            countryCode: 'SD',
          },
        })
      ).id;
    const separate = { a: await make('C'), b: await make('D') };
    const savedFrom = from;
    const savedTo = to;
    from = separate.a;
    to = separate.b;
    try {
      await rate('100', day(-30));
      const body = request();
      const summary = await created(body);
      const draft = await read(summary.id);
      expect(draft.pricing?.lines[0]?.unitPrice).toBe('100');
      await rate('120', day(-1));
      const res = await r
        .post(`${API}/${summary.id}/approve`, cookies.salesDxb, {
          version: 1,
          pricingKey: draft.pricing?.key,
          confirmed: [],
        })
        .expect(409);
      expect(message(res)).toMatch(/reload/);
      expect(await customersWithPhone(body.customer.phone)).toBe(0);
      expect((await read(summary.id)).pricing?.lines[0]?.unitPrice).toBe('120');
      await approveAsReviewed(summary.id, 200);
    } finally {
      from = savedFrom;
      to = savedTo;
    }
  });

  it('two concurrent approvals create one customer and one quotation', async () => {
    const body = request();
    const summary = await created(body);
    const draft = await read(summary.id);
    const approve = () =>
      r.post(`${API}/${summary.id}/approve`, cookies.salesDxb, {
        version: 1,
        pricingKey: draft.pricing?.key,
        confirmed: [],
      });
    const results = await Promise.all([approve(), approve()]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 200]);
    expect(await customersWithPhone(body.customer.phone)).toBe(1);
    expect(
      await t.prisma.quotation.count({ where: { customer: { phone: body.customer.phone } } }),
    ).toBe(1);
  });

  it('rejects for good: a decided draft never changes', async () => {
    const summary = await created();
    const draft = await read(summary.id);
    await r
      .post(`${API}/${summary.id}/reject`, cookies.salesDxb, { version: 1, reason: 'Wrong phone' })
      .expect(200);
    expect(await read(summary.id)).toMatchObject({
      status: 'REJECTED',
      rejectReason: 'Wrong phone',
      actions: { canDecide: false },
    });
    await r
      .post(`${API}/${summary.id}/approve`, cookies.salesDxb, {
        version: 2,
        pricingKey: draft.pricing?.key,
        confirmed: [],
      })
      .expect(409);
    await expect(
      t.prisma.newCustomerQuotationDraft.update({
        where: { id: summary.id },
        data: { rejectReason: 'x' },
      }),
    ).rejects.toThrow(/decided and cannot change/);
  });

  it('the database refuses an approval without the customer and quotation it created', async () => {
    const summary = await created();
    await expect(
      t.prisma.newCustomerQuotationDraft.update({
        where: { id: summary.id },
        data: {
          state: 'APPROVED',
          decidedAt: new Date(),
          decidedById: ratesBy,
          decidedVia: 'SESSION',
        },
      }),
    ).rejects.toThrow(/new_customer_quotation_drafts_decision_check/);
  });
});

describe("quotations for a new customer: replacing a draft at the person's request", () => {
  it('closes the old draft and links the new one; the old one can no longer be approved', async () => {
    const old = await created();
    const oldDraft = await read(old.id);
    const body = { ...request({}, { terms: 'Cash' }), replacesDraftId: old.id };
    const fresh = await created(body);
    expect(await read(old.id)).toMatchObject({
      status: 'REJECTED',
      version: 2,
      replacedByDraftId: fresh.id,
      decidedFromAssistant: true,
      rejectReason: 'Replaced by a newer draft',
    });
    expect(await read(fresh.id)).toMatchObject({ status: 'DRAFT', replacesDraftId: old.id });
    await r
      .post(`${API}/${old.id}/approve`, cookies.salesDxb, {
        version: 2,
        pricingKey: oldDraft.pricing?.key,
        confirmed: [],
      })
      .expect(409);
    // A replay of the same replacement returns the same draft.
    expect(await created(body)).toEqual(fresh);
  });

  it("refuses another user's draft and a draft in a branch the user no longer holds", async () => {
    const others = await created(request(), tokens.sales2);
    await createDraft({ ...request(), replacesDraftId: others.id }).expect(404);
    expect((await read(others.id)).status).toBe('DRAFT');

    const moved = await created(request(), tokens.moved);
    await t.prisma.userBranch.deleteMany({ where: { userId: movedAgentId, branchId: dxb } });
    // Typed prices: JED has no rate on this route.
    const typed = [
      { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '9' },
    ];
    const body = { ...request({ branchId: jed }, { lines: typed }), replacesDraftId: moved.id };
    await createDraft(body, tokens.moved).expect(404);
    expect(await draftsUnderKey(body.idempotencyKey)).toBe(0);
    expect((await read(moved.id)).status).toBe('DRAFT');
  });
});
