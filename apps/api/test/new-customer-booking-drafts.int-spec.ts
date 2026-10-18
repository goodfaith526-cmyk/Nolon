import type {
  AgentClientCreatedDto,
  BookingDto,
  CustomerDraftDto,
  EntryDraftSummaryDto,
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
  expectGateRefusal,
  registerClient,
  requests,
  tokenFor,
} from './agent-drafts-helpers.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';
import type { Prisma } from '../src/generated/prisma/client.js';

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
const agentCookies = {
  salesAgent: '',
  salesAgent2: '',
  movedAgent: '',
  opsAgent: '',
  financeAgent: '',
};
const tokens = { sales: '', sales2: '', moved: '', ops: '', finance: '' };
let movedAgentId = '';

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

async function created(
  body: object = request(),
  token = tokens.sales,
): Promise<NewCustomerBookingDraftSummaryDto> {
  return (await createDraft(body, token).expect(201)).body as NewCustomerBookingDraftSummaryDto;
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
    salesAgent2: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    // Loses DXB in a test.
    movedAgent: await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], AGENT_PREFIX),
    // Operations may create bookings but not customers; Finance neither.
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    financeAgent: await createUser(t.prisma, ['FINANCE'], ['DXB'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'New customer booking draft platform');
  movedAgentId = assistantUsers.movedAgent.id;
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.sales2 = await tokenFor(t, agentCookies.salesAgent2, client);
  tokens.moved = await tokenFor(t, agentCookies.movedAgent, client);
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
      [
        'createdAt',
        'customerDraftId',
        'expiresAt',
        'id',
        'lineCount',
        'missingFields',
        'status',
        'version',
      ].sort(),
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
    // A draft may be saved without lines (filled in on review), never with a malformed one.
    await createDraft(request({}, { items: [{ quantity: 1.5 }] })).expect(400);
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

// The approval gate (no-required-fields plan, 3.3), on both parts: the customer draft's details
// and the booking's values, before the customer's own status or any live check; nothing booked.
describe('bookings for a new customer: the approval gate', () => {
  it('refuses a booking without services and a customer with a bad phone; then books once', async () => {
    const summary = await created();
    const stored = await t.prisma.newCustomerBookingDraft.findUniqueOrThrow({
      where: { id: summary.id },
    });
    const customer = await t.prisma.customerDraft.findUniqueOrThrow({
      where: { id: summary.customerDraftId },
    });
    const booking = stored.request as Prisma.InputJsonObject;
    await t.prisma.newCustomerBookingDraft.update({
      where: { id: summary.id },
      data: { request: { ...booking, services: [] } },
    });
    await t.prisma.customerDraft.update({
      where: { id: customer.id },
      data: { phone: '0912345678' },
    });
    // The gate comes before "approve the new customer first".
    expectGateRefusal(await approve(summary.id), ['booking.services'], ['customer.phone']);
    await approve(summary.id, cookies.salesJed).expect(404);
    await approve(summary.id, cookies.financeDxb).expect(403);
    await approve(summary.id, cookies.salesDxb, { version: 2 }).expect(409);

    await t.prisma.customerDraft.update({
      where: { id: customer.id },
      data: { phone: customer.phone },
    });
    await approveCustomer(summary.customerDraftId).expect(200);
    expectGateRefusal(await approve(summary.id), ['booking.services']);
    const { customerId } = (await read(summary.id)).customer;
    if (customerId === null) throw new Error('The customer was not created');
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(0);
    expect(
      await t.prisma.newCustomerBookingDraft.findUniqueOrThrow({ where: { id: summary.id } }),
    ).toMatchObject({ state: 'DRAFT', version: 1, bookingId: null });

    await t.prisma.newCustomerBookingDraft.update({
      where: { id: summary.id },
      data: { request: booking },
    });
    await approve(summary.id).expect(200);
    await approve(summary.id).expect(200);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(1);
  });
});

describe("bookings for a new customer: replacing a pair at the person's request", () => {
  const readCustomer = async (id: string) =>
    (await r.get(`/customer-drafts/${id}`, cookies.salesDxb).expect(200)).body as CustomerDraftDto;

  const counts = () =>
    Promise.all([t.prisma.newCustomerBookingDraft.count(), t.prisma.customerDraft.count()]);

  async function expectStillOpen(old: NewCustomerBookingDraftSummaryDto): Promise<void> {
    const rows = await Promise.all([
      t.prisma.newCustomerBookingDraft.findUniqueOrThrow({ where: { id: old.id } }),
      t.prisma.customerDraft.findUniqueOrThrow({ where: { id: old.customerDraftId } }),
    ]);
    for (const row of rows) expect(row).toMatchObject({ state: 'DRAFT', version: 1 });
  }

  it('closes both old drafts and links both new ones; the old pair can no longer be approved', async () => {
    const old = await created();
    const body = {
      ...request({}, { services: ['MAIN_FREIGHT', 'CUSTOMS'] }),
      replacesDraftId: old.id,
    };
    const fresh = await created(body);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.customerDraftId).not.toBe(old.customerDraftId);

    const closed = await read(old.id);
    expect(closed).toMatchObject({
      status: 'REJECTED',
      version: 2,
      replacedByDraftId: fresh.id,
      decidedFromAssistant: true,
      rejectReason: 'Replaced by a newer draft',
      actions: { canDecide: false },
    });
    expect(closed.customer.status).toBe('REJECTED');
    const closedCustomer = await readCustomer(old.customerDraftId);
    expect(closedCustomer).toMatchObject({
      status: 'REJECTED',
      replacedByDraftId: fresh.customerDraftId,
      decidedFromAssistant: true,
      rejectReason: 'Replaced by a newer draft',
    });

    const next = await read(fresh.id);
    expect(next).toMatchObject({ status: 'DRAFT', replacesDraftId: old.id });
    expect(next.request.services).toEqual(['MAIN_FREIGHT', 'CUSTOMS']);
    expect(await readCustomer(fresh.customerDraftId)).toMatchObject({
      status: 'DRAFT',
      replacesDraftId: old.customerDraftId,
      bookingDraftId: fresh.id,
    });

    await approve(old.id, cookies.salesDxb, { version: 2 }).expect(409);
    await approveCustomer(old.customerDraftId, { version: 2 }).expect(409);
    expect(await t.prisma.customer.count({ where: { phone: body.customer.phone } })).toBe(0);
  });

  it('a replay of the same replacement returns the same pair; another request under the key is refused', async () => {
    const old = await created();
    const body = { ...request(), replacesDraftId: old.id };
    const first = await created(body);
    const again = await created(body);
    expect(again).toEqual(first);
    expect(await draftsUnderKey(body.idempotencyKey)).toEqual([1, 1]);
    // The same request without the replacement, or replacing another draft, is another request.
    const { replacesDraftId, ...plain } = body;
    expect(replacesDraftId).toBe(old.id);
    await createDraft(plain).expect(409);
    const other = await created();
    await createDraft({ ...body, replacesDraftId: other.id }).expect(409);
    await expectStillOpen(other);
    expect(
      await t.prisma.newCustomerBookingDraft.count({ where: { replacesDraftId: old.id } }),
    ).toBe(1);
  });

  it("refuses another user's draft, an unknown id and a bad id, and writes nothing", async () => {
    const others = await created(request(), tokens.sales2);
    const before = await counts();
    await createDraft({ ...request(), replacesDraftId: others.id }).expect(404);
    // A customer draft id is not a booking draft of this kind.
    const mine = await created();
    await createDraft({ ...request(), replacesDraftId: mine.customerDraftId }).expect(404);
    await createDraft({
      ...request(),
      replacesDraftId: '00000000-0000-4000-8000-000000000000',
    }).expect(404);
    await createDraft({ ...request(), replacesDraftId: 'not-a-uuid' }).expect(400);
    expect(await counts()).toEqual([before[0] + 1, before[1] + 1]);
    await expectStillOpen(others);
    await expectStillOpen(mine);
  });

  it('refuses a draft in a branch the user no longer holds, and leaves the pair open', async () => {
    const old = (await createDraft(request(), tokens.moved).expect(201))
      .body as NewCustomerBookingDraftSummaryDto;
    await t.prisma.userBranch.deleteMany({ where: { userId: movedAgentId, branchId: dxb } });
    const before = await counts();
    await createDraft(
      { ...request({ branchId: jed }), replacesDraftId: old.id },
      tokens.moved,
    ).expect(404);
    expect(await counts()).toEqual(before);
    await expectStillOpen(old);
  });

  it('refuses a booking draft already decided, and writes nothing', async () => {
    const old = await created();
    await r
      .post(`${API}/${old.id}/reject`, cookies.salesDxb, { version: 1, reason: 'No' })
      .expect(200);
    const before = await counts();
    const res = await createDraft({ ...request(), replacesDraftId: old.id }).expect(409);
    expect((res.body as { message: string }).message).toMatch(/already decided/);
    expect(await counts()).toEqual(before);
    expect((await readCustomer(old.customerDraftId)).status).toBe('DRAFT');
  });

  it('refuses a pair whose customer is already approved, and writes nothing', async () => {
    const old = await created();
    await approveCustomer(old.customerDraftId).expect(200);
    const before = await counts();
    const res = await createDraft({ ...request(), replacesDraftId: old.id }).expect(409);
    expect((res.body as { message: string }).message).toMatch(
      /already approved: reject this booking for a new customer in NOLON/,
    );
    expect(await counts()).toEqual(before);
    expect(await read(old.id)).toMatchObject({ status: 'DRAFT', version: 1 });
  });

  it('refuses a pair whose customer draft was rejected, and writes nothing', async () => {
    const old = await created();
    await r
      .post(`/customer-drafts/${old.customerDraftId}/reject`, cookies.salesDxb, {
        version: 1,
        reason: 'Wrong phone',
      })
      .expect(200);
    const before = await counts();
    await createDraft({ ...request(), replacesDraftId: old.id }).expect(409);
    expect(await counts()).toEqual(before);
    expect(await read(old.id)).toMatchObject({ status: 'DRAFT', version: 1 });
  });

  it('refuses replacing the customer draft of an open pair alone; an unlinked one still is', async () => {
    const pair = await created();
    const customerBody = (replacesDraftId: string) => ({
      idempotencyKey: draftKey(),
      branchId: dxb,
      kind: 'INDIVIDUAL',
      name: 'Amna Osman',
      phone: uniquePhone(),
      replacesDraftId,
    });
    const before = await counts();
    const res = await r
      .agentPost('/customer-drafts', tokens.sales, customerBody(pair.customerDraftId))
      .expect(409);
    expect((res.body as { message: string }).message).toMatch(
      /replace the booking for a new customer instead/,
    );
    expect(await counts()).toEqual(before);
    await expectStillOpen(pair);

    const single = (
      await r
        .agentPost('/customer-drafts', tokens.sales, {
          idempotencyKey: draftKey(),
          branchId: dxb,
          kind: 'INDIVIDUAL',
          name: 'Tarig',
          phone: uniquePhone(),
        })
        .expect(201)
    ).body as EntryDraftSummaryDto;
    const replacement = (
      await r.agentPost('/customer-drafts', tokens.sales, customerBody(single.id)).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(await readCustomer(single.id)).toMatchObject({
      status: 'REJECTED',
      replacedByDraftId: replacement.id,
    });

    // Once the pair's booking draft is decided, its customer draft waits for nothing.
    await r
      .post(`${API}/${pair.id}/reject`, cookies.salesDxb, { version: 1, reason: 'No' })
      .expect(200);
    await r
      .agentPost('/customer-drafts', tokens.sales, customerBody(pair.customerDraftId))
      .expect(201);
  });
});

// Drafts saved with missing values (no-required-fields plan, 3.2 and 3.3): a booking for a new
// customer may name only its branch (security context). A person fills in the booking (PATCH) and
// the customer on its own customer draft, and approving is refused (422) while anything is
// missing, creating no customer and no booking.
describe('bookings for a new customer saved with missing values', () => {
  const CUSTOMER_MISSING = ['customer.kind', 'customer.name', 'customer.phone'];
  const BOOKING_MISSING = [
    'booking.originLocationId',
    'booking.destinationLocationId',
    'booking.mode',
    'booking.cargoType',
    'booking.services',
  ];

  it('saves an empty draft and a partly filled one, and reads them back', async () => {
    const empty = await created({ idempotencyKey: draftKey(), branchId: dxb });
    expect(empty.missingFields).toEqual([...CUSTOMER_MISSING, ...BOOKING_MISSING]);
    expect(await read(empty.id)).toMatchObject({
      missingFields: [...CUSTOMER_MISSING, ...BOOKING_MISSING],
      check: null,
      actions: { canEdit: true },
      customer: { draftId: empty.customerDraftId, name: null, phone: null },
      request: { mode: null, services: [], items: [] },
    });
    const list = (await r.get(`${API}?status=DRAFT`, cookies.salesDxb).expect(200))
      .body as NewCustomerBookingDraftListItemDto[];
    expect(list.find((d) => d.id === empty.id)).toMatchObject({
      missingFields: [...CUSTOMER_MISSING, ...BOOKING_MISSING],
    });
    await r.get(`${API}/${empty.id}`, cookies.salesJed).expect(404);
    await r.get(`/customer-drafts/${empty.customerDraftId}`, cookies.salesJed).expect(404);

    const partial = await created({
      idempotencyKey: draftKey(),
      branchId: dxb,
      customer: { name: 'Partly Filled' },
      booking: { mode: 'SEA', items: [{ weightKg: '100' }] },
    });
    expect(partial.missingFields).toEqual([
      'customer.kind',
      'customer.phone',
      'booking.originLocationId',
      'booking.destinationLocationId',
      'booking.cargoType',
      'booking.services',
      'booking.items[0].cargoType',
      'booking.items[0].quantity',
    ]);
  });

  it('refuses a draft without a branch, of another branch, or with a malformed value', async () => {
    const before = await t.prisma.newCustomerBookingDraft.count();
    // A new customer has no branch yet: the draft always names its own (a malformed request).
    await createDraft({ idempotencyKey: draftKey(), customer: { name: 'No branch' } }).expect(400);
    await createDraft({ idempotencyKey: draftKey(), branchId: jed }).expect(403);
    await createDraft({
      idempotencyKey: draftKey(),
      branchId: dxb,
      customer: { phone: '0912' },
    }).expect(400);
    await createDraft({
      idempotencyKey: draftKey(),
      branchId: dxb,
      booking: { mode: 'TELEPORT' },
    }).expect(400);
    expect(await t.prisma.newCustomerBookingDraft.count()).toBe(before);
  });

  it('refuses the approval while values are missing, then approves once both are filled in', async () => {
    const summary = await created({ idempotencyKey: draftKey(), branchId: dxb });
    const { id } = summary;
    expectGateRefusal(await approve(id, cookies.salesDxb, { version: 1, confirmed: [] }), [
      ...CUSTOMER_MISSING,
      ...BOOKING_MISSING,
    ]);
    expect(
      await t.prisma.newCustomerBookingDraft.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ state: 'DRAFT', version: 1, bookingId: null });

    const edit = (cookie: string, body: object) => r.patch(`${API}/${id}`, cookie, body);
    await edit(cookies.salesJed, { version: 1, mode: 'SEA' }).expect(404);
    await edit(cookies.financeDxb, { version: 1, mode: 'SEA' }).expect(403);
    await r.agentPatch(`${API}/${id}`, tokens.sales, { version: 1, mode: 'SEA' }).expect(403);
    await edit(cookies.salesDxb, { version: 2, mode: 'SEA' }).expect(409);
    await edit(cookies.salesDxb, { version: 1, mode: 'TELEPORT' }).expect(400);
    // The customer is completed on its own customer draft.
    await edit(cookies.salesDxb, { version: 1, customer: { name: 'x' } }).expect(400);

    const booked = (
      await edit(cookies.salesDxb, {
        version: 1,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 1 }],
      }).expect(200)
    ).body as NewCustomerBookingDraftDto;
    expect(booked).toMatchObject({ version: 2, missingFields: CUSTOMER_MISSING });
    expectGateRefusal(
      await approve(id, cookies.salesDxb, { version: 2, confirmed: [] }),
      CUSTOMER_MISSING,
    );

    const phone = uniquePhone();
    await r
      .patch(`/customer-drafts/${summary.customerDraftId}`, cookies.salesDxb, {
        version: 1,
        kind: 'INDIVIDUAL',
        name: 'Filled In Later',
        phone,
      })
      .expect(200);
    await approveCustomer(summary.customerDraftId, { version: 2, confirmed: [] }).expect(200);
    const ready = await read(id);
    expect(ready).toMatchObject({ missingFields: [], check: { ok: true } });
    const approved = (
      await approve(id, cookies.salesDxb, { version: 2, confirmed: [] }).expect(200)
    ).body as NewCustomerBookingDraftDto;
    expect(approved.status).toBe('APPROVED');
    await approve(id, cookies.salesDxb, { version: 2, confirmed: [] }).expect(200);
    expect(
      await t.prisma.booking.count({ where: { customerId: ready.customer.customerId ?? '' } }),
    ).toBe(1);
  });
});
