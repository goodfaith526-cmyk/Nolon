import type {
  AgentClientCreatedDto,
  BookingDraftDto,
  BookingDraftListItemDto,
  BookingDto,
  CustomerDto,
  EntryDraftSummaryDto,
  QuotationDraftDto,
  QuotationDraftListItemDto,
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
import { deleteCommercialTestData, uniquePhone, waitForLockWaiter } from './test-data.js';

// Quotation and booking drafts proposed by the staff assistant (entry drafts). The assistant's
// users (agent-it-) create drafts; it- users approve them, so the quotations and bookings they
// create are removed by the usual cleanup.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let otherClient: AgentClientCreatedDto;
let customer: CustomerDto;
let jedCustomer: CustomerDto;
let jebelAli: string;
let portSudan: string;

const cookies = { admin: '', salesDxb: '', salesJed: '', opsDxb: '', branchMgrDxb: '' };
const agentCookies = { salesAgent: '', opsAgent: '', whAgent: '', salesJedAgent: '' };
const tokens = { sales: '', salesOther: '', ops: '', wh: '', salesJed: '' };

const tomorrowPlus = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function quotationRequest(extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
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
    idempotencyKey: draftKey(),
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

const createQuotationDraft = (body: object, token = tokens.sales) =>
  r.agentPost('/quotation-drafts', token, body);
const createBookingDraft = (body: object, token = tokens.ops) =>
  r.agentPost('/booking-drafts', token, body);

async function quotationDraft(body = quotationRequest()): Promise<QuotationDraftDto> {
  const created = (await createQuotationDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/quotation-drafts/${created.id}`, cookies.salesDxb).expect(200))
    .body as QuotationDraftDto;
}

async function bookingDraft(body: object = bookingRequest()): Promise<BookingDraftDto> {
  const created = (await createBookingDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/booking-drafts/${created.id}`, cookies.opsDxb).expect(200))
    .body as BookingDraftDto;
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
    opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
    branchMgrDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const assistantUsers = {
    salesAgent: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    whAgent: await createUser(t.prisma, ['WAREHOUSE'], ['DXB'], AGENT_PREFIX),
    salesJedAgent: await createUser(t.prisma, ['SALES'], ['JED'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Entry draft platform');
  otherClient = await registerClient(t, cookies.admin, 'Entry draft other platform');
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.salesOther = await tokenFor(t, agentCookies.salesAgent, otherClient);
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
  tokens.wh = await tokenFor(t, agentCookies.whAgent, client);
  tokens.salesJed = await tokenFor(t, agentCookies.salesJedAgent, client);

  const newCustomer = async (branch: string, cookie: string, name: string) => {
    const created = (
      await r
        .post('/customers', cookie, {
          branchId: branch,
          kind: 'COMPANY',
          name,
          phone: uniquePhone(),
        })
        .expect(201)
    ).body as CustomerDto;
    return (await r.get(`/customers/${created.id}`, cookie).expect(200)).body as CustomerDto;
  };
  customer = await newCustomer(dxb, cookies.salesDxb, 'Entry Draft Test Trading');
  jedCustomer = await newCustomer(jed, cookies.salesJed, 'Entry Draft JED Trading');
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('quotation drafts: the assistant proposes', () => {
  it('creates a draft and gets back ids and counts only, never the values it sent', async () => {
    const res = await createQuotationDraft(quotationRequest()).expect(201);
    const body = res.body as EntryDraftSummaryDto;
    expect(body).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'status', 'version'].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('Ocean freight');
    // Nothing reached the quotations yet.
    expect(await t.prisma.quotation.count({ where: { customerId: customer.id } })).toBe(0);
  });

  it('returns the same draft for a repeat, and refuses the key with another request', async () => {
    const body = quotationRequest();
    const first = (await createQuotationDraft(body).expect(201)).body as EntryDraftSummaryDto;
    // Same request in another canonical form: "1500.5" for "1500.50", key order changed.
    const again = {
      ...body,
      lines: [{ ...body.lines[0], unitPrice: '1500.5', discount: '1.50' }],
    };
    const second = (await createQuotationDraft(again).expect(201)).body as EntryDraftSummaryDto;
    expect(second.id).toBe(first.id);
    const changed = { ...body, lines: [{ ...body.lines[0], unitPrice: '1400' }] };
    const refused = await createQuotationDraft(changed).expect(409);
    expect(JSON.stringify(refused.body)).not.toContain(first.id);
    // The key is the client's and the user's: another client may use it.
    const other = (await createQuotationDraft(body, tokens.salesOther).expect(201))
      .body as EntryDraftSummaryDto;
    expect(other.id).not.toBe(first.id);
  });

  it('runs concurrent creates with one key into one draft', async () => {
    const body = quotationRequest();
    const results = await Promise.all([createQuotationDraft(body), createQuotationDraft(body)]);
    expect(results.map((res) => res.status)).toEqual([201, 201]);
    const ids = results.map((res) => (res.body as EntryDraftSummaryDto).id);
    expect(ids[0]).toBe(ids[1]);
  });

  it('recovers its draft by key; another user or client does not find it', async () => {
    const body = quotationRequest();
    const created = (await createQuotationDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const found = await r
      .agentGet(`/quotation-drafts/by-key/${body.idempotencyKey}`, tokens.sales)
      .expect(200);
    expect((found.body as EntryDraftSummaryDto).id).toBe(created.id);
    await r
      .agentGet(`/quotation-drafts/by-key/${body.idempotencyKey}`, tokens.salesOther)
      .expect(404);
    await r
      .agentGet(`/quotation-drafts/by-key/${body.idempotencyKey}`, tokens.salesJed)
      .expect(404);
  });

  it('refuses a customer of another branch, as NOLON would', async () => {
    await createQuotationDraft(quotationRequest(), tokens.salesJed).expect(404);
    await createQuotationDraft(quotationRequest({ customerId: jedCustomer.id })).expect(404);
  });

  it('refuses a user without quotations:create', async () => {
    await createQuotationDraft(quotationRequest(), tokens.ops).expect(403);
    await createQuotationDraft(quotationRequest(), tokens.wh).expect(403);
  });

  it('refuses a request NOLON would refuse, and writes nothing', async () => {
    const before = await t.prisma.quotationDraft.count();
    await createQuotationDraft(quotationRequest({ validUntil: '2020-01-01' })).expect(400);
    await createQuotationDraft(
      quotationRequest({ lines: [{ quantity: '1', unitPrice: '10' }] }),
    ).expect(400);
    await createQuotationDraft(
      quotationRequest({ lines: [{ ...quotationRequest().lines[0], discount: '999999' }] }),
    ).expect(400);
    await createQuotationDraft({ ...quotationRequest(), idempotencyKey: 'short' }).expect(400);
    await createQuotationDraft({ ...quotationRequest(), status: 'APPROVED' }).expect(400);
    expect(await t.prisma.quotationDraft.count()).toBe(before);
  });

  it('cannot read, approve or reject drafts', async () => {
    const draft = await quotationDraft();
    await r.agentGet('/quotation-drafts', tokens.sales).expect(403);
    await r.agentGet(`/quotation-drafts/${draft.id}`, tokens.sales).expect(403);
    await r
      .agentPost(`/quotation-drafts/${draft.id}/approve`, tokens.sales, { version: 1 })
      .expect(403);
    await r
      .agentPost(`/quotation-drafts/${draft.id}/reject`, tokens.sales, { version: 1, reason: 'x' })
      .expect(403);
    // Nor reach the ordinary quotation writes.
    const plain: Record<string, unknown> = quotationRequest();
    delete plain.idempotencyKey;
    await r.agentPost('/quotations', tokens.sales, plain).expect(403);
  });

  it('only the assistant creates drafts: a person with a session is refused', async () => {
    await r.post('/quotation-drafts', cookies.salesDxb, quotationRequest()).expect(403);
  });
});

describe('quotation drafts: a person reviews', () => {
  it('lists and shows drafts of their branches only, with what NOLON would price', async () => {
    const draft = await quotationDraft();
    expect(draft.request.lines[0]).toMatchObject({ unitPrice: '1500.5', quantity: '2' });
    // 2 x 1500.50 - 1.50 discount.
    expect(draft.check).toEqual({ ok: true, total: '2999.5', currency: 'USD' });
    expect(draft.actions).toEqual({ canEdit: false, canDecide: true });
    const list = (await r.get('/quotation-drafts?status=DRAFT', cookies.salesDxb).expect(200))
      .body as QuotationDraftListItemDto[];
    expect(list.map((d) => d.id)).toContain(draft.id);
    const jed = (await r.get('/quotation-drafts', cookies.salesJed).expect(200))
      .body as QuotationDraftListItemDto[];
    expect(jed.map((d) => d.id)).not.toContain(draft.id);
    await r.get(`/quotation-drafts/${draft.id}`, cookies.salesJed).expect(404);
    // A branch manager sees it but cannot create quotations, so cannot decide.
    const mgr = (await r.get(`/quotation-drafts/${draft.id}`, cookies.branchMgrDxb).expect(200))
      .body as QuotationDraftDto;
    expect(mgr.actions.canDecide).toBe(false);
  });

  it('approves into an ordinary DRAFT quotation, priced by NOLON, once', async () => {
    const draft = await quotationDraft();
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 2 })
      .expect(409);
    const approved = (
      await r
        .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
        .expect(200)
    ).body as QuotationDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2, check: null });
    expect(approved.quotationNumber).toMatch(/QT/);
    const quotation = (
      await r.get(`/quotations/${approved.quotationId}`, cookies.salesDxb).expect(200)
    ).body as QuotationDto;
    expect(quotation).toMatchObject({ status: 'DRAFT', total: '2999.5', customerId: customer.id });
    // Again: the same draft back, no second quotation.
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(200);
    expect(
      await t.prisma.quotation.count({
        where: { customerId: customer.id, id: approved.quotationId! },
      }),
    ).toBe(1);
    expect(
      await t.prisma.quotationDraft.count({ where: { quotationId: approved.quotationId } }),
    ).toBe(1);
    await r
      .post(`/quotation-drafts/${draft.id}/reject`, cookies.salesDxb, {
        version: 2,
        reason: 'late',
      })
      .expect(409);
  });

  it('refuses approval to a user of another branch or without quotations:create', async () => {
    const draft = await quotationDraft();
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesJed, { version: 1 })
      .expect(404);
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(403);
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.branchMgrDxb, { version: 1 })
      .expect(403);
    const still = (await r.get(`/quotation-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as QuotationDraftDto;
    expect(still.status).toBe('DRAFT');
  });

  it('two concurrent approvals create one quotation', async () => {
    const draft = await quotationDraft();
    const before = await t.prisma.quotation.count();
    const results = await Promise.all([
      r.post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }),
      r.post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 200]);
    expect(await t.prisma.quotation.count()).toBe(before + 1);
  });

  it('rejects with a reason; a rejected draft cannot be approved', async () => {
    const draft = await quotationDraft();
    await r
      .post(`/quotation-drafts/${draft.id}/reject`, cookies.salesDxb, { version: 1 })
      .expect(400);
    const rejected = (
      await r
        .post(`/quotation-drafts/${draft.id}/reject`, cookies.salesDxb, {
          version: 1,
          reason: 'Wrong customer',
        })
        .expect(200)
    ).body as QuotationDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Wrong customer' });
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 2 })
      .expect(409);
  });

  it('an expired draft reads as expired and cannot be decided', async () => {
    const draft = await quotationDraft();
    await t.prisma.quotationDraft.update({
      where: { id: draft.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = (await r.get(`/quotation-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as QuotationDraftDto;
    expect(expired).toMatchObject({ status: 'EXPIRED', check: null });
    expect(expired.actions.canDecide).toBe(false);
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(409);
    const listed = (await r.get('/quotation-drafts?status=EXPIRED', cookies.salesDxb).expect(200))
      .body as QuotationDraftListItemDto[];
    expect(listed.map((d) => d.id)).toContain(draft.id);
  });

  it('shows a draft NOLON would no longer accept, and refuses its approval', async () => {
    const draft = await quotationDraft();
    await t.prisma.quotationDraft.update({
      where: { id: draft.id },
      data: { validUntil: new Date('2020-01-01') },
    });
    const stale = (await r.get(`/quotation-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as QuotationDraftDto;
    expect(stale.check).toEqual({ ok: false, message: 'Valid-until is in the past' });
    await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(400);
  });
});

describe('quotation drafts: the database keeps decided drafts as they are', () => {
  it('refuses changes to a decided draft and its lines, and moving a line', async () => {
    const draft = await quotationDraft();
    await r
      .post(`/quotation-drafts/${draft.id}/reject`, cookies.salesDxb, { version: 1, reason: 'No' })
      .expect(200);
    await expect(
      t.prisma.quotationDraft.update({
        where: { id: draft.id },
        data: { rejectReason: 'Changed' },
      }),
    ).rejects.toThrow(/decided/);
    await expect(
      t.prisma.quotationDraftLine.updateMany({
        where: { draftId: draft.id },
        data: { unitPrice: '1' },
      }),
    ).rejects.toThrow(/decided/);
    await expect(
      t.prisma.quotationDraftLine.deleteMany({ where: { draftId: draft.id } }),
    ).rejects.toThrow(/decided/);
    const open = await quotationDraft();
    await expect(
      t.prisma.quotationDraftLine.updateMany({
        where: { draftId: open.id },
        data: { draftId: draft.id },
      }),
    ).rejects.toThrow(/another draft/);
  });

  it('refuses decision fields that disagree with the state', async () => {
    const draft = await quotationDraft();
    await expect(
      t.prisma.quotationDraft.update({ where: { id: draft.id }, data: { state: 'APPROVED' } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.quotationDraft.update({ where: { id: draft.id }, data: { rejectReason: 'x' } }),
    ).rejects.toThrow();
  });
});

describe('booking drafts', () => {
  it('proposes a booking for a customer; approval creates an unconfirmed DRAFT booking', async () => {
    const draft = await bookingDraft();
    expect(draft.request).toMatchObject({ customerId: customer.id, services: ['MAIN_FREIGHT'] });
    expect(draft.check).toEqual({ ok: true, total: null, currency: null });
    const approved = (
      await r
        .post(`/booking-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
        .expect(200)
    ).body as BookingDraftDto;
    expect(approved.status).toBe('APPROVED');
    const booking = (await r.get(`/bookings/${approved.bookingId}`, cookies.opsDxb).expect(200))
      .body as BookingDto;
    expect(booking).toMatchObject({ status: 'DRAFT', shipmentId: null });
    expect(booking.items[0]).toMatchObject({ quantity: 10, weightKg: '1000.5' });
    await r.post(`/booking-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 }).expect(200);
    expect(await t.prisma.booking.count({ where: { id: approved.bookingId! } })).toBe(1);
  });

  it('proposes a booking from an approved quotation; not from one that is not approved', async () => {
    const qDraft = await quotationDraft();
    const approvedQ = (
      await r
        .post(`/quotation-drafts/${qDraft.id}/approve`, cookies.salesDxb, { version: 1 })
        .expect(200)
    ).body as QuotationDraftDto;
    const quotationId = approvedQ.quotationId!;
    // The quotation is a DRAFT: a booking cannot be made from it yet.
    await createBookingDraft({ idempotencyKey: draftKey(), quotationId }).expect(409);
    await r.post(`/quotations/${quotationId}/send`, cookies.salesDxb).expect(200);
    await r.post(`/quotations/${quotationId}/approve`, cookies.branchMgrDxb).expect(200);
    const body = {
      idempotencyKey: draftKey(),
      quotationId,
      items: [{ cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 2 }],
    };
    const first = await bookingDraft(body);
    expect(first.request).toMatchObject({ quotationId, services: ['MAIN_FREIGHT'] });
    // A second draft for the same quotation can be proposed, but only one becomes a booking.
    const second = await bookingDraft({ ...body, idempotencyKey: draftKey() });
    const approved = (
      await r
        .post(`/booking-drafts/${first.id}/approve`, cookies.opsDxb, { version: 1 })
        .expect(200)
    ).body as BookingDraftDto;
    const booking = (await r.get(`/bookings/${approved.bookingId}`, cookies.opsDxb).expect(200))
      .body as BookingDto;
    expect(booking.quotationId).toBe(quotationId);
    await r
      .post(`/booking-drafts/${second.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(409);
    const still = (await r.get(`/booking-drafts/${second.id}`, cookies.opsDxb).expect(200))
      .body as BookingDraftDto;
    expect(still.status).toBe('DRAFT');
  });

  it('refuses route fields on a draft from a quotation, and an unknown field', async () => {
    await createBookingDraft({
      idempotencyKey: draftKey(),
      quotationId: customer.id,
      originLocationId: jebelAli,
    }).expect(400);
    await createBookingDraft({ ...bookingRequest(), confirm: true }).expect(400);
  });

  it('is branch-scoped and permission-checked like bookings', async () => {
    await createBookingDraft(bookingRequest({ customerId: jedCustomer.id })).expect(404);
    await createBookingDraft(bookingRequest(), tokens.wh).expect(403);
    const draft = await bookingDraft();
    await r.get(`/booking-drafts/${draft.id}`, cookies.salesJed).expect(404);
    const jedList = (await r.get('/booking-drafts', cookies.salesJed).expect(200))
      .body as BookingDraftListItemDto[];
    expect(jedList.map((d) => d.id)).not.toContain(draft.id);
    // A branch manager may view and approve bookings but not create them.
    await r
      .post(`/booking-drafts/${draft.id}/approve`, cookies.branchMgrDxb, { version: 1 })
      .expect(403);
  });

  it('keeps the key per request and refuses the assistant on decisions', async () => {
    const body = bookingRequest({ services: ['MAIN_FREIGHT', 'MAIN_FREIGHT'] });
    const first = (await createBookingDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const again = (await createBookingDraft({ ...body, services: ['MAIN_FREIGHT'] }).expect(201))
      .body as EntryDraftSummaryDto;
    expect(again.id).toBe(first.id);
    await createBookingDraft({ ...body, items: [] }).expect(409);
    await r
      .agentPost(`/booking-drafts/${first.id}/approve`, tokens.ops, { version: 1 })
      .expect(403);
  });

  it('the database keeps a decided booking draft and its items as they are', async () => {
    const draft = await bookingDraft();
    await r
      .post(`/booking-drafts/${draft.id}/reject`, cookies.opsDxb, {
        version: 1,
        reason: 'Duplicate',
      })
      .expect(200);
    await expect(
      t.prisma.bookingDraft.update({ where: { id: draft.id }, data: { specialInstructions: 'x' } }),
    ).rejects.toThrow(/decided/);
    await expect(
      t.prisma.bookingDraftItem.updateMany({ where: { draftId: draft.id }, data: { quantity: 1 } }),
    ).rejects.toThrow(/decided/);
  });
});

describe('approval waits for a concurrent rejection and then refuses', () => {
  it('serialises decisions on the draft row', async () => {
    const draft = await quotationDraft();
    // Hold the draft row lock as a rejection in progress would.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locker = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "quotation_drafts" WHERE "id" = ${draft.id}::uuid FOR UPDATE`;
      await tx.quotationDraft.update({
        where: { id: draft.id },
        data: {
          state: 'REJECTED',
          rejectReason: 'Rejected first',
          decidedById: (await tx.user.findFirstOrThrow({ where: { email: { startsWith: 'it-' } } }))
            .id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await held;
    });
    const approval = r.post(`/quotation-drafts/${draft.id}/approve`, cookies.salesDxb, {
      version: 1,
    });
    const pending = approval.then((res) => res);
    await waitForLockWaiter(t.prisma);
    release();
    await locker;
    const res = await pending;
    expect(res.status).toBe(409);
    expect(
      await t.prisma.quotation.count({
        where: { customerId: customer.id, createdAt: { gte: new Date(draft.createdAt) } },
      }),
    ).toBe(0);
  });
});
