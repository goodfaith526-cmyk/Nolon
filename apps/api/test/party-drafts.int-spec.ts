import type {
  AgentClientCreatedDto,
  BookingDto,
  CustomerDto,
  EntryDraftSummaryDto,
  PartyDraftDto,
  PartyDraftListItemDto,
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

// Party drafts (shipper, consignee, notify party of a customer) proposed by the staff assistant.
// The assistant's users (agent-it-) create drafts; it- users decide them.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let portSudan: string;
let khartoum: string;

const cookies = { admin: '', salesDxb: '', salesJed: '', opsDxb: '' };
const agentCookies = { salesAgent: '', opsAgent: '', salesJedAgent: '' };
const tokens = { sales: '', ops: '', salesJed: '' };

async function newCustomer(): Promise<CustomerDto> {
  return (
    await r
      .post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Party Draft Test Trading',
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;
}

function partyRequest(customerId: string, extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    customerId,
    name: 'Omer Hassan',
    companyName: 'Hassan Import',
    phone: '+249912000111',
    email: 'Omer@Example.com',
    countryCode: 'SD',
    city: 'Khartoum',
    address: 'Bahri, block 4',
    ...extra,
  };
}

const createDraft = (body: object, token = tokens.sales) =>
  r.agentPost('/party-drafts', token, body);

async function partyDraft(body: object): Promise<PartyDraftDto> {
  const created = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/party-drafts/${created.id}`, cookies.salesDxb).expect(200))
    .body as PartyDraftDto;
}

const partiesOf = (customerId: string) => t.prisma.party.count({ where: { customerId } });

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  portSudan = await loc('SDPZU');
  khartoum = await loc('SDKRT');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
    opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const assistantUsers = {
    salesAgent: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    salesJedAgent: await createUser(t.prisma, ['SALES'], ['JED'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Party draft platform');
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
  tokens.salesJed = await tokenFor(t, agentCookies.salesJedAgent, client);
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('party drafts: the assistant proposes', () => {
  it('creates a draft and adds no party yet', async () => {
    const customer = await newCustomer();
    const created = (await createDraft(partyRequest(customer.id)).expect(201))
      .body as EntryDraftSummaryDto;
    expect(created).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(await partiesOf(customer.id)).toBe(0);
  });

  it('returns the same draft for a repeat, and refuses the key with another request', async () => {
    const customer = await newCustomer();
    const body = partyRequest(customer.id);
    const a = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const b = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(b.id).toBe(a.id);
    const found = (await r.agentGet(`/party-drafts/by-key/${body.idempotencyKey}`, tokens.sales))
      .body as EntryDraftSummaryDto;
    expect(found.id).toBe(a.id);
    await createDraft({ ...body, city: 'Omdurman' }).expect(409);
    expect(await t.prisma.partyDraft.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it('refuses another branch, a missing permission and bad fields', async () => {
    const customer = await newCustomer();
    const before = await t.prisma.partyDraft.count();
    await createDraft(partyRequest(customer.id), tokens.salesJed).expect(404);
    // Operations sees customers but cannot change them.
    await createDraft(partyRequest(customer.id), tokens.ops).expect(403);
    await createDraft(partyRequest(customer.id, { phone: '0912000111' })).expect(400);
    await createDraft(partyRequest(customer.id, { name: '' })).expect(400);
    await createDraft(partyRequest(customer.id, { role: 'SHIPPER' })).expect(400);
    expect(await t.prisma.partyDraft.count()).toBe(before);
  });

  it('cannot read or decide drafts, nor add a party itself; a person cannot create one', async () => {
    const customer = await newCustomer();
    const draft = await partyDraft(partyRequest(customer.id));
    await r.agentGet('/party-drafts', tokens.sales).expect(403);
    await r.agentGet(`/party-drafts/${draft.id}`, tokens.sales).expect(403);
    await r
      .agentPost(`/party-drafts/${draft.id}/approve`, tokens.sales, { version: 1 })
      .expect(403);
    await r
      .agentPost(`/party-drafts/${draft.id}/reject`, tokens.sales, { version: 1, reason: 'No' })
      .expect(403);
    await r
      .agentPost(`/customers/${customer.id}/parties`, tokens.sales, { name: 'Omer Hassan' })
      .expect(403);
    await r.post('/party-drafts', cookies.salesDxb, partyRequest(customer.id)).expect(403);
    expect(await partiesOf(customer.id)).toBe(0);
  });
});

describe('party drafts: a person reviews', () => {
  it('shows drafts of their branches only; who cannot change customers cannot decide', async () => {
    const customer = await newCustomer();
    const draft = await partyDraft(partyRequest(customer.id));
    expect(draft).toMatchObject({
      status: 'DRAFT',
      customerId: customer.id,
      customerNumber: customer.number,
      request: { name: 'Omer Hassan', phone: '+249912000111', email: 'omer@example.com' },
      check: { ok: true },
      actions: { canDecide: true },
      partyId: null,
    });
    const list = (await r.get('/party-drafts?status=DRAFT', cookies.salesDxb).expect(200))
      .body as PartyDraftListItemDto[];
    expect(list.some((d) => d.id === draft.id)).toBe(true);
    const jed = (await r.get('/party-drafts', cookies.salesJed).expect(200))
      .body as PartyDraftListItemDto[];
    expect(jed.some((d) => d.id === draft.id)).toBe(false);
    await r.get(`/party-drafts/${draft.id}`, cookies.salesJed).expect(404);
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesJed, { version: 1 }).expect(404);
    const ops = (await r.get(`/party-drafts/${draft.id}`, cookies.opsDxb).expect(200))
      .body as PartyDraftDto;
    expect(ops.actions.canDecide).toBe(false);
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 }).expect(403);
    expect(await partiesOf(customer.id)).toBe(0);
  });

  it('approves into an ordinary party of the customer, once, that a booking can name', async () => {
    const customer = await newCustomer();
    const draft = await partyDraft(partyRequest(customer.id));
    const approved = (
      await r
        .post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
        .expect(200)
    ).body as PartyDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null });
    expect(approved.partyId).not.toBeNull();
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }).expect(200);
    const parties = await t.prisma.party.findMany({ where: { customerId: customer.id } });
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({
      id: approved.partyId,
      name: 'Omer Hassan',
      countryCode: 'SD',
      address: 'Bahri, block 4',
    });
    // The change is in the customer's audit log, in the approver's name.
    expect(
      await t.prisma.auditEvent.count({
        where: { entityId: customer.id, action: 'UPDATED' },
      }),
    ).toBe(1);
    const booking = (
      await r
        .post('/bookings', cookies.opsDxb, {
          customerId: customer.id,
          originLocationId: portSudan,
          destinationLocationId: khartoum,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          services: ['MAIN_FREIGHT'],
          consigneeId: approved.partyId,
          items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
        })
        .expect(201)
    ).body as BookingDto;
    expect(booking.consigneeId).toBe(approved.partyId);
  });

  it('rejects with a reason; the database keeps decided drafts as they are', async () => {
    const customer = await newCustomer();
    const draft = await partyDraft(partyRequest(customer.id));
    const rejected = (
      await r
        .post(`/party-drafts/${draft.id}/reject`, cookies.salesDxb, {
          version: 1,
          reason: 'Wrong consignee',
        })
        .expect(200)
    ).body as PartyDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Wrong consignee' });
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 2 }).expect(409);
    expect(await partiesOf(customer.id)).toBe(0);
    await expect(
      t.prisma.partyDraft.update({ where: { id: draft.id }, data: { city: 'Changed' } }),
    ).rejects.toThrow(/decided/);
  });

  it('the database refuses an approval without the party it added', async () => {
    const customer = await newCustomer();
    const draft = await partyDraft(partyRequest(customer.id));
    const user = await t.prisma.user.findFirstOrThrow();
    await expect(
      t.prisma.partyDraft.update({
        where: { id: draft.id },
        data: {
          state: 'APPROVED',
          decidedAt: new Date(),
          decidedById: user.id,
          decidedVia: 'SESSION',
        },
      }),
    ).rejects.toThrow(/decision_check/);
  });
});

// The approval gate (no-required-fields plan, 3.3): a draft missing its name or holding a
// malformed phone is refused before any check against live data, and no party is added.
describe('party drafts: the approval gate', () => {
  it('refuses a draft with a blank name and a bad phone, adding no party; then approves', async () => {
    const customer = await newCustomer();
    const draft = await partyDraft(partyRequest(customer.id));
    await t.prisma.partyDraft.update({
      where: { id: draft.id },
      data: { name: '   ', phone: '0912000111' },
    });
    expectGateRefusal(
      await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }),
      ['name'],
      ['phone'],
    );
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesJed, { version: 1 }).expect(404);
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 }).expect(403);
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 2 }).expect(409);
    expect(await partiesOf(customer.id)).toBe(0);
    expect(await t.prisma.partyDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
      state: 'DRAFT',
      version: 1,
      partyId: null,
    });

    await t.prisma.partyDraft.update({
      where: { id: draft.id },
      data: { name: 'Omer Hassan', phone: '+249912000111' },
    });
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }).expect(200);
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }).expect(200);
    expect(await partiesOf(customer.id)).toBe(1);
  });
});

describe('party drafts: replacing a draft', () => {
  it('a new draft replaces the one the person asked to change; not from another branch', async () => {
    const customer = await newCustomer();
    const old = await partyDraft(partyRequest(customer.id));
    const created = (
      await createDraft({
        ...partyRequest(customer.id, { city: 'Omdurman' }),
        replacesDraftId: old.id,
      }).expect(201)
    ).body as EntryDraftSummaryDto;
    const replaced = (await r.get(`/party-drafts/${old.id}`, cookies.salesDxb).expect(200))
      .body as PartyDraftDto;
    expect(replaced.status).toBe('REJECTED');
    const newer = (await r.get(`/party-drafts/${created.id}`, cookies.salesDxb).expect(200))
      .body as PartyDraftDto;
    expect(newer).toMatchObject({ replacesDraftId: old.id, request: { city: 'Omdurman' } });
    const other = await partyDraft(partyRequest(customer.id));
    await createDraft(
      { ...partyRequest(customer.id), replacesDraftId: other.id },
      tokens.salesJed,
    ).expect(404);
  });

  /** Waits until `count` requests wait on a lock, or fails after about 5 seconds. */
  async function waiters(count: number): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const rows = await t.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE NOT granted AND locktype IN ('transactionid', 'tuple', 'relation')`;
      if ((rows[0]?.n ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Expected ${count} lock waiters`);
  }

  it('replacing a draft while it is approved: one wins, the other gets 409, no deadlock', async () => {
    const customer = await newCustomer();
    const draft = await partyDraft(partyRequest(customer.id));
    // Hold the customer so the approval queues first and the replacement after it.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${customer.id}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    try {
      await isLocked;
      const approving = r
        .post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
        .then((x) => x);
      await waiters(1);
      const replacing = createDraft({
        ...partyRequest(customer.id, { city: 'Omdurman' }),
        replacesDraftId: draft.id,
      }).then((x) => x);
      await waiters(2);
      release();
      await holder;
      const [approved, replaced] = await Promise.all([approving, replacing]);
      expect([approved.status, replaced.status]).toEqual([200, 409]);
    } finally {
      release();
      await holder;
    }
    expect(await partiesOf(customer.id)).toBe(1);
    expect(await t.prisma.partyDraft.count({ where: { replacesDraftId: draft.id } })).toBe(0);
  });
});

describe("party drafts: replay and the staff member's words", () => {
  it('a replay after the approval returns the saved draft, not a new party', async () => {
    const customer = await newCustomer();
    const body = partyRequest(customer.id);
    const draft = await partyDraft(body);
    await r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }).expect(200);
    const replay = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(replay).toMatchObject({ id: draft.id, status: 'APPROVED' });
    await createDraft({ ...body, name: 'Someone Else' }).expect(409);
    expect(await partiesOf(customer.id)).toBe(1);
  });

  it('keeps the words with the draft and approves only once each value is ticked', async () => {
    const customer = await newCustomer();
    const evidence = [
      { field: 'name', quote: 'المستلم عمر حسن' },
      { field: 'phone', quote: 'رقمه 0912000111' },
      { field: 'customerId', quote: 'لعميلنا شركة التجارة' },
    ];
    const body = partyRequest(customer.id, { evidence });
    const draft = await partyDraft(body);
    expect(draft.evidence).toEqual(evidence);
    // Other words under the same key are another request.
    await createDraft({ ...body, evidence: evidence.slice(0, 2) }).expect(409);
    const approve = (confirmed?: string[]) =>
      r.post(`/party-drafts/${draft.id}/approve`, cookies.salesDxb, {
        version: 1,
        ...(confirmed ? { confirmed } : {}),
      });
    await approve().expect(400);
    await approve(['name', 'phone']).expect(400);
    expect(await partiesOf(customer.id)).toBe(0);
    await approve(['customerId', 'phone', 'name']).expect(200);
    expect(await partiesOf(customer.id)).toBe(1);
  });

  it('refuses words for a field it does not bind, or the same field twice', async () => {
    const customer = await newCustomer();
    const before = await t.prisma.partyDraft.count();
    await createDraft(
      partyRequest(customer.id, { evidence: [{ field: 'address', quote: 'x' }] }),
    ).expect(400);
    await createDraft(
      partyRequest(customer.id, {
        evidence: [
          { field: 'name', quote: 'a' },
          { field: 'name', quote: 'b' },
        ],
      }),
    ).expect(400);
    expect(await t.prisma.partyDraft.count()).toBe(before);
  });
});
