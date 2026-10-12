import type {
  AgentClientCreatedDto,
  BookingDto,
  CustomerDraftDto,
  NewCustomerBookingDraftDto,
  NewCustomerBookingDraftListItemDto,
  NewCustomerBookingDraftSummaryDto,
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

// Bookings for a new customer, proposed by the staff assistant in one request with the customer
// (entry drafts). The assistant's users (agent-it-) create drafts; it- users approve them, so the
// customers and bookings they create are removed by the usual cleanup.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let jed: string;
let jebelAli: string;
let portSudan: string;

const cookies = { admin: '', salesDxb: '', salesJed: '', opsDxb: '', financeDxb: '' };
const agentCookies = { salesAgent: '', opsAgent: '', financeAgent: '' };
const tokens = { sales: '', ops: '', finance: '' };

const API = '/new-customer-booking-drafts';

function request(extra: object = {}, booking: object = {}) {
  return {
    idempotencyKey: draftKey(),
    branchId: dxb,
    customer: { kind: 'INDIVIDUAL', name: 'Amna Osman', phone: uniquePhone(), city: 'Omdurman' },
    booking: {
      originLocationId: jebelAli,
      destinationLocationId: portSudan,
      mode: 'SEA',
      loadType: 'FCL',
      cargoType: 'CONTAINER',
      services: ['MAIN_FREIGHT'],
      items: [
        { cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 2, weightKg: '18000.50' },
      ],
      ...booking,
    },
    ...extra,
  };
}

const createDraft = (body: object, token = tokens.sales) => r.agentPost(API, token, body);

async function created(body: object = request()): Promise<NewCustomerBookingDraftSummaryDto> {
  return (await createDraft(body).expect(201)).body as NewCustomerBookingDraftSummaryDto;
}

const read = async (id: string, cookie = cookies.salesDxb) =>
  (await r.get(`${API}/${id}`, cookie).expect(200)).body as NewCustomerBookingDraftDto;

const approve = (id: string, cookie = cookies.salesDxb, body: object = { version: 1 }) =>
  r.post(`${API}/${id}/approve`, cookie, body);

const approveCustomer = (id: string, body: object = { version: 1 }) =>
  r.post(`/customer-drafts/${id}/approve`, cookies.salesDxb, body);

const draftsUnderKey = (key: string) =>
  Promise.all([
    t.prisma.newCustomerBookingDraft.count({ where: { idempotencyKey: key } }),
    t.prisma.customerDraft.count({ where: { idempotencyKey: key } }),
  ]);

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  jed = await branchId(t.prisma, 'JED');
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  jebelAli = await loc('AEJEA');
  portSudan = await loc('SDPZU');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
    opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
    financeDxb: await createUser(t.prisma, ['FINANCE'], ['DXB']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const assistantUsers = {
    salesAgent: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    // Operations may create bookings but not customers; Finance neither.
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    financeAgent: await createUser(t.prisma, ['FINANCE'], ['DXB'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'New customer booking draft platform');
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
  tokens.finance = await tokenFor(t, agentCookies.financeAgent, client);
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('bookings for a new customer: the assistant proposes', () => {
  it('creates the customer draft and the linked booking draft together, and nothing else', async () => {
    const evidence = [
      { field: 'name', quote: 'العميلة آمنة عثمان' },
      { field: 'phone', quote: 'رقمها' },
      { field: 'destinationLocationId', quote: 'لبورتسودان' },
      { field: 'items[0].quantity', quote: 'حاويتين' },
      { field: 'items[0].weightKg', quote: '18 طن ونص' },
    ];
    const body = request({ evidence });
    const summary = await created(body);
    expect(Object.keys(summary).sort()).toEqual(
      ['createdAt', 'customerDraftId', 'expiresAt', 'id', 'lineCount', 'status', 'version'].sort(),
    );
    expect(summary).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    const draft = await read(summary.id);
    expect(draft.evidence.map((e) => e.field)).toEqual([
      'destinationLocationId',
      'items[0].quantity',
      'items[0].weightKg',
    ]);
    expect(draft.request.items[0]).toMatchObject({ quantity: 2, weightKg: '18000.5' });
    expect(draft.customer).toMatchObject({
      draftId: summary.customerDraftId,
      status: 'DRAFT',
      name: 'Amna Osman',
      phone: body.customer.phone,
      customerId: null,
    });
    expect(draft.check).toMatchObject({ ok: true });
    const customerDraft = (
      await r.get(`/customer-drafts/${summary.customerDraftId}`, cookies.salesDxb).expect(200)
    ).body as CustomerDraftDto;
    expect(customerDraft.evidence.map((e) => e.field)).toEqual(['name', 'phone']);
    expect(customerDraft.bookingDraftId).toBe(summary.id);
    expect(customerDraft.request).toMatchObject({ name: 'Amna Osman', city: 'Omdurman' });
    expect(await t.prisma.customer.count({ where: { phone: body.customer.phone } })).toBe(0);
  });

  it('stores the measurements as decimal strings, never numbers', async () => {
    const summary = await created();
    const row = await t.prisma.newCustomerBookingDraft.findUniqueOrThrow({
      where: { id: summary.id },
    });
    const [rawType] = await t.prisma.$queryRaw<{ t: string }[]>`
      SELECT jsonb_typeof("request"->'items'->0->'weightKg') AS "t"
      FROM "new_customer_booking_drafts" WHERE "id" = ${row.id}::uuid`;
    expect(rawType?.t).toBe('string');
  });

  it('creates neither draft when the booking part or the customer part is refused', async () => {
    const badContainer = request(
      {},
      {
        items: [{ cargoType: 'CONTAINER', containerTypeCode: 'ZZ99', quantity: 1 }],
      },
    );
    await createDraft(badContainer).expect(400);
    expect(await draftsUnderKey(badContainer.idempotencyKey)).toEqual([0, 0]);

    const airFcl = request({}, { mode: 'AIR' });
    await createDraft(airFcl).expect(400);
    expect(await draftsUnderKey(airFcl.idempotencyKey)).toEqual([0, 0]);

    const sameRoute = request({}, { destinationLocationId: jebelAli });
    await createDraft(sameRoute).expect(400);
    expect(await draftsUnderKey(sameRoute.idempotencyKey)).toEqual([0, 0]);

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
    expect(await draftsUnderKey(taken.idempotencyKey)).toEqual([0, 0]);
  });

  it('refuses bad fields: parties, no lines, a number for a weight, words for a missing line', async () => {
    const before = await t.prisma.newCustomerBookingDraft.count();
    await createDraft(request({}, { shipperId: jebelAli })).expect(400);
    await createDraft(request({}, { items: [] })).expect(400);
    await createDraft(
      request({}, { items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: 12.5 }] }),
    ).expect(400);
    await createDraft(
      request({}, { items: [{ cargoType: 'GENERAL', quantity: 1, lengthCm: '10' }] }),
    ).expect(400);
    await createDraft(request({ evidence: [{ field: 'items[1].quantity', quote: '2' }] })).expect(
      400,
    );
    await createDraft(
      request({ evidence: [{ field: 'items[0].description', quote: 'x' }] }),
    ).expect(400);
    await createDraft(request({ customerId: jebelAli })).expect(400);
    expect(await t.prisma.newCustomerBookingDraft.count()).toBe(before);
  });

  it('returns the same drafts for a repeat; the same key for another request is refused', async () => {
    const body = request();
    const first = await created(body);
    const again = await created({
      ...body,
      booking: {
        ...body.booking,
        items: [{ ...body.booking.items[0], weightKg: '18000.500' }],
      },
    });
    expect(again).toEqual(first);
    await createDraft({ ...body, customer: { ...body.customer, name: 'Other' } }).expect(409);
    await createDraft({ ...body, evidence: [{ field: 'name', quote: 'Amna' }] }).expect(409);
    expect(await draftsUnderKey(body.idempotencyKey)).toEqual([1, 1]);
    const found = (
      await r.agentGet(`${API}/by-key/${body.idempotencyKey}`, tokens.sales).expect(200)
    ).body as NewCustomerBookingDraftSummaryDto;
    expect(found).toEqual(first);
  });

  it('refuses a key a customer draft of the assistant already holds, creating nothing', async () => {
    const body = request();
    await r
      .agentPost('/customer-drafts', tokens.sales, {
        idempotencyKey: body.idempotencyKey,
        branchId: dxb,
        kind: 'INDIVIDUAL',
        name: 'Someone else',
        phone: uniquePhone(),
      })
      .expect(201);
    await createDraft(body).expect(409);
    expect(await draftsUnderKey(body.idempotencyKey)).toEqual([0, 1]);
  });

  it('refuses another branch and a user who cannot create both a booking and a customer', async () => {
    const other = request({ branchId: jed });
    await createDraft(other).expect(403);
    const noCustomers = request();
    await createDraft(noCustomers, tokens.ops).expect(403);
    const noBookings = request();
    await createDraft(noBookings, tokens.finance).expect(403);
    for (const body of [other, noCustomers, noBookings]) {
      expect(await draftsUnderKey(body.idempotencyKey)).toEqual([0, 0]);
    }
    // A person proposes nothing here: they add the customer and the booking themselves.
    await r.post(API, cookies.salesDxb, request()).expect(403);
  });

  it('cannot read, approve or reject the drafts', async () => {
    const summary = await created();
    await r.agentGet(API, tokens.sales).expect(403);
    await r.agentGet(`${API}/${summary.id}`, tokens.sales).expect(403);
    await r.agentPost(`${API}/${summary.id}/approve`, tokens.sales, { version: 1 }).expect(403);
    await r
      .agentPost(`${API}/${summary.id}/reject`, tokens.sales, { version: 1, reason: 'no' })
      .expect(403);
    await r
      .agentPost(`/customer-drafts/${summary.customerDraftId}/approve`, tokens.sales, {
        version: 1,
      })
      .expect(403);
  });
});

describe('bookings for a new customer: a person reviews', () => {
  it('shows drafts of their branches only; who cannot create bookings cannot decide', async () => {
    const summary = await created();
    const list = (await r.get(API, cookies.salesDxb).expect(200))
      .body as NewCustomerBookingDraftListItemDto[];
    expect(list.find((d) => d.id === summary.id)).toMatchObject({
      subject: 'Amna Osman',
      lineCount: 1,
      branchCode: 'DXB',
      customer: { draftId: summary.customerDraftId, status: 'DRAFT' },
      actions: { canDecide: true },
    });
    const jedList = (await r.get(API, cookies.salesJed).expect(200))
      .body as NewCustomerBookingDraftListItemDto[];
    expect(jedList.some((d) => d.id === summary.id)).toBe(false);
    await r.get(`${API}/${summary.id}`, cookies.salesJed).expect(404);
    await approve(summary.id, cookies.salesJed).expect(404);
    await r
      .post(`${API}/${summary.id}/reject`, cookies.salesJed, { version: 1, reason: 'x' })
      .expect(404);
    const financeView = await read(summary.id, cookies.financeDxb);
    expect(financeView.actions.canDecide).toBe(false);
    await approve(summary.id, cookies.financeDxb).expect(403);
  });

  it('refuses the booking until the customer is approved, then books for that customer', async () => {
    const evidence = [
      { field: 'name', quote: 'آمنة' },
      { field: 'items[0].weightKg', quote: '18 طن ونص' },
      { field: 'originLocationId', quote: 'من جبل علي' },
    ];
    const summary = await created(request({ evidence }));
    const confirmed = ['items[0].weightKg', 'originLocationId'];
    const early = await approve(summary.id, cookies.salesDxb, { version: 1, confirmed }).expect(
      409,
    );
    expect((early.body as { message: string }).message).toMatch(/Approve the new customer first/);
    expect((await read(summary.id)).status).toBe('DRAFT');
    expect(await t.prisma.booking.count({ where: { newCustomerDraft: { id: summary.id } } })).toBe(
      0,
    );

    await approveCustomer(summary.customerDraftId, { version: 1, confirmed: ['name'] }).expect(200);
    const ready = await read(summary.id);
    expect(ready.customer.status).toBe('APPROVED');
    expect(ready.customer.customerId).not.toBeNull();
    expect(ready.check).toMatchObject({ ok: true });

    // Each of the booking's values ticked first.
    await approve(summary.id).expect(400);
    await approve(summary.id, cookies.salesDxb, {
      version: 1,
      confirmed: ['originLocationId'],
    }).expect(400);
    const approved = (
      await approve(summary.id, cookies.salesDxb, { version: 1, confirmed }).expect(200)
    ).body as NewCustomerBookingDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null });
    expect(approved.bookingId).not.toBeNull();
    const booking = (await r.get(`/bookings/${approved.bookingId}`, cookies.salesDxb).expect(200))
      .body as BookingDto;
    expect(booking).toMatchObject({
      status: 'DRAFT',
      branchId: dxb,
      customerId: ready.customer.customerId,
      customerName: 'Amna Osman',
      originLocationId: jebelAli,
      destinationLocationId: portSudan,
      shipperId: null,
      shipmentId: null,
    });
    expect(booking.items[0]).toMatchObject({
      quantity: 2,
      containerTypeCode: '40HC',
      weightKg: '18000.5',
    });
    // Approving again returns it as it is; a replay of the request returns the saved drafts.
    await approve(summary.id, cookies.salesDxb, { version: 1, confirmed }).expect(200);
    expect(await t.prisma.booking.count({ where: { customerId: booking.customerId } })).toBe(1);
  });

  it('two concurrent approvals create one booking', async () => {
    const summary = await created();
    await approveCustomer(summary.customerDraftId).expect(200);
    const results = await Promise.all([approve(summary.id), approve(summary.id)]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 200]);
    const customer = (await read(summary.id)).customer;
    expect(await t.prisma.booking.count({ where: { customerId: customer.customerId ?? '' } })).toBe(
      1,
    );
  });

  it('a replay after both approvals returns the saved drafts, not a refusal', async () => {
    const body = request();
    const summary = await created(body);
    await approveCustomer(summary.customerDraftId).expect(200);
    await approve(summary.id).expect(200);
    const replay = await created(body);
    expect(replay).toMatchObject({ id: summary.id, status: 'APPROVED' });
    // A new request for the same phone is the duplicate it is now.
    await createDraft({ ...body, idempotencyKey: draftKey() }).expect(409);
  });

  it('refuses the booking for good once the customer is rejected', async () => {
    const summary = await created();
    await r
      .post(`/customer-drafts/${summary.customerDraftId}/reject`, cookies.salesDxb, {
        version: 1,
        reason: 'Wrong phone',
      })
      .expect(200);
    const draft = await read(summary.id);
    expect(draft.customer.status).toBe('REJECTED');
    expect(draft.actions.canDecide).toBe(true);
    const res = await approve(summary.id).expect(409);
    expect((res.body as { message: string }).message).toMatch(/rejected/);
    // It can still be rejected, and a decided draft never changes.
    await r
      .post(`${API}/${summary.id}/reject`, cookies.salesDxb, {
        version: 1,
        reason: 'Customer rejected',
      })
      .expect(200);
    await approve(summary.id, cookies.salesDxb, { version: 2 }).expect(409);
    await expect(
      t.prisma.newCustomerBookingDraft.update({
        where: { id: summary.id },
        data: { rejectReason: 'x' },
      }),
    ).rejects.toThrow(/decided and cannot change/);
  });

  it('the database refuses an approval without the booking it created', async () => {
    const summary = await created();
    const decider = await t.prisma.user.findFirstOrThrow({
      where: { email: { startsWith: 'it-' } },
    });
    await expect(
      t.prisma.newCustomerBookingDraft.update({
        where: { id: summary.id },
        data: {
          state: 'APPROVED',
          decidedAt: new Date(),
          decidedById: decider.id,
          decidedVia: 'SESSION',
        },
      }),
    ).rejects.toThrow(/new_customer_booking_drafts_decision_check/);
  });
});
