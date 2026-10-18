import type {
  AgentClientCreatedDto,
  CustomerDraftDto,
  CustomerDraftListItemDto,
  CustomerDto,
  EntryDraftSummaryDto,
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
  revokedBeforeTransaction,
  tokenFor,
} from './agent-drafts-helpers.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

// New customers proposed by the staff assistant (entry drafts). The assistant's users (agent-it-)
// create drafts; it- users approve them, so the customers they create are removed by the usual
// cleanup.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let jed: string;
let movedAgentId: string;

const cookies = { admin: '', salesDxb: '', salesJed: '', opsDxb: '' };
const agentCookies = { salesAgent: '', opsAgent: '', salesAgent2: '', movedAgent: '' };
const tokens = { sales: '', ops: '', sales2: '', moved: '' };

function customerRequest(extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    branchId: dxb,
    kind: 'INDIVIDUAL',
    name: 'Tarig Ismail',
    phone: uniquePhone(),
    city: 'Suakin',
    ...extra,
  };
}

const createDraft = (body: object, token = tokens.sales) =>
  r.agentPost('/customer-drafts', token, body);

async function customerDraft(body: object = customerRequest()): Promise<CustomerDraftDto> {
  const created = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/customer-drafts/${created.id}`, cookies.salesDxb).expect(200))
    .body as CustomerDraftDto;
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  jed = await branchId(t.prisma, 'JED');
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
    salesAgent2: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    movedAgent: await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], AGENT_PREFIX),
  };
  movedAgentId = assistantUsers.movedAgent.id;
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Customer draft platform');
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
  tokens.sales2 = await tokenFor(t, agentCookies.salesAgent2, client);
  tokens.moved = await tokenFor(t, agentCookies.movedAgent, client);
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('customer drafts: the assistant proposes', () => {
  it('creates a draft, gets back ids and counts only, and creates no customer yet', async () => {
    const body = customerRequest();
    const res = await createDraft(body).expect(201);
    const summary = res.body as EntryDraftSummaryDto;
    expect(Object.keys(summary).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'missingFields', 'status', 'version'].sort(),
    );
    expect(summary).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(await t.prisma.customer.count({ where: { phone: body.phone } })).toBe(0);
  });

  it('returns the same draft for a repeat, and refuses the key with another request', async () => {
    const body = customerRequest();
    const first = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const again = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(again.id).toBe(first.id);
    await createDraft({ ...body, name: 'Someone else' }).expect(409);
    const found = (
      await r.agentGet(`/customer-drafts/by-key/${body.idempotencyKey}`, tokens.sales).expect(200)
    ).body as EntryDraftSummaryDto;
    expect(found.id).toBe(first.id);
  });

  it('refuses another branch, a missing permission, a taken phone and unknown fields', async () => {
    await createDraft(customerRequest({ branchId: jed })).expect(403);
    await createDraft(customerRequest(), tokens.ops).expect(403);
    const existing = (
      await r
        .post('/customers', cookies.salesDxb, {
          branchId: dxb,
          kind: 'COMPANY',
          name: 'Taken Phone Trading',
          phone: uniquePhone(),
        })
        .expect(201)
    ).body as CustomerDto;
    await createDraft(customerRequest({ phone: existing.phone })).expect(409);
    await createDraft(customerRequest({ creditLimit: '1000' })).expect(400);
    await createDraft(customerRequest({ phone: '0912345678' })).expect(400);
  });

  it('cannot read, approve or reject drafts, nor create a customer itself', async () => {
    const draft = await customerDraft();
    await r.agentGet('/customer-drafts', tokens.sales).expect(403);
    await r.agentGet(`/customer-drafts/${draft.id}`, tokens.sales).expect(403);
    await r
      .agentPost(`/customer-drafts/${draft.id}/approve`, tokens.sales, { version: 1 })
      .expect(403);
    await r
      .agentPost(`/customer-drafts/${draft.id}/reject`, tokens.sales, { version: 1, reason: 'x' })
      .expect(403);
    await r
      .agentPost('/customers', tokens.sales, {
        branchId: dxb,
        kind: 'INDIVIDUAL',
        name: 'Direct',
        phone: uniquePhone(),
      })
      .expect(403);
    // A person's session cannot propose one either.
    await r.post('/customer-drafts', cookies.salesDxb, customerRequest()).expect(403);
  });
});

describe('customer drafts: a person reviews', () => {
  it('shows drafts of their branches only', async () => {
    const draft = await customerDraft();
    const list = (await r.get('/customer-drafts', cookies.salesDxb).expect(200))
      .body as CustomerDraftListItemDto[];
    expect(list.find((d) => d.id === draft.id)).toMatchObject({
      subject: 'Tarig Ismail',
      branchCode: 'DXB',
      status: 'DRAFT',
    });
    const other = (await r.get('/customer-drafts', cookies.salesJed).expect(200))
      .body as CustomerDraftListItemDto[];
    expect(other.some((d) => d.id === draft.id)).toBe(false);
    await r.get(`/customer-drafts/${draft.id}`, cookies.salesJed).expect(404);
    expect(draft.check).toEqual({ ok: true, total: null, currency: null });
    expect(draft.actions).toEqual({ canEdit: true, canDecide: true });
    const view = (await r.get(`/customer-drafts/${draft.id}`, cookies.opsDxb).expect(200))
      .body as CustomerDraftDto;
    expect(view.actions.canDecide).toBe(false);
  });

  it('approves into an ordinary customer of the branch, once', async () => {
    const body = customerRequest();
    const draft = await customerDraft(body);
    const approved = (
      await r
        .post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
        .expect(200)
    ).body as CustomerDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2, decidedFromAssistant: false });
    expect(approved.customerNumber).toMatch(/^CS\d{5,}$/);
    const customer = (
      await r.get(`/customers/${approved.customerId}`, cookies.salesDxb).expect(200)
    ).body as CustomerDto;
    expect(customer).toMatchObject({
      branchId: dxb,
      name: 'Tarig Ismail',
      phone: body.phone,
      city: 'Suakin',
    });
    // Approving again returns it as it is.
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(200);
    expect(await t.prisma.customer.count({ where: { phone: body.phone } })).toBe(1);
    // A retry of the original request returns the draft, though its customer now has the phone.
    const replay = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(replay).toMatchObject({ id: draft.id, status: 'APPROVED' });
  });

  it('refuses approval to another branch or a user who cannot create customers', async () => {
    const draft = await customerDraft();
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.salesJed, { version: 1 })
      .expect(404);
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(403);
    const still = (await r.get(`/customer-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDraftDto;
    expect(still.status).toBe('DRAFT');
  });

  it('refuses a phone taken since the draft, under the lock, and leaves the draft open', async () => {
    const body = customerRequest();
    const draft = await customerDraft(body);
    await r
      .post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'INDIVIDUAL',
        name: 'Got there first',
        phone: body.phone,
      })
      .expect(201);
    const reread = (await r.get(`/customer-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDraftDto;
    expect(reread.check).toMatchObject({ ok: false });
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(409);
    const still = (await r.get(`/customer-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDraftDto;
    expect(still).toMatchObject({ status: 'DRAFT', version: 1 });
    // A retry of the original request still returns the draft; a new key with the phone is refused.
    const replay = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(replay.id).toBe(draft.id);
    await createDraft({ ...body, idempotencyKey: draftKey() }).expect(409);
  });

  it('two concurrent approvals create one customer', async () => {
    const body = customerRequest();
    const draft = await customerDraft(body);
    const results = await Promise.all([
      r.post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }),
      r.post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }),
    ]);
    expect(results.map((x) => x.status)).toEqual([200, 200]);
    expect(await t.prisma.customer.count({ where: { phone: body.phone } })).toBe(1);
  });

  it('rejects with a reason; expired drafts cannot be decided; decided drafts never change', async () => {
    const draft = await customerDraft();
    const rejected = (
      await r
        .post(`/customer-drafts/${draft.id}/reject`, cookies.salesDxb, {
          version: 1,
          reason: 'Already a customer under another name',
        })
        .expect(200)
    ).body as CustomerDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', check: null });
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 2 })
      .expect(409);
    await expect(
      t.prisma.customerDraft.update({ where: { id: draft.id }, data: { name: 'Changed' } }),
    ).rejects.toThrow(/decided/);

    const old = await customerDraft();
    await t.prisma.customerDraft.update({
      where: { id: old.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await r
      .post(`/customer-drafts/${old.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(409);
    const expired = (await r.get(`/customer-drafts/${old.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDraftDto;
    expect(expired.status).toBe('EXPIRED');
  });

  it('the database refuses a decision that does not match its state', async () => {
    const draft = await customerDraft();
    await expect(
      t.prisma.customerDraft.update({ where: { id: draft.id }, data: { state: 'APPROVED' } }),
    ).rejects.toThrow(/customer_drafts_decision_check/);
  });
});

describe("replacing a draft at the person's request", () => {
  it('closes the old draft and links both ways; the old one can no longer be approved', async () => {
    const old = await customerDraft();
    const body = { ...customerRequest({ city: 'Port Sudan' }), replacesDraftId: old.id };
    const created = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const again = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(again.id).toBe(created.id);
    const fresh = (await r.get(`/customer-drafts/${created.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDraftDto;
    expect(fresh).toMatchObject({ status: 'DRAFT', replacesDraftId: old.id });
    const closed = (await r.get(`/customer-drafts/${old.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDraftDto;
    expect(closed).toMatchObject({
      status: 'REJECTED',
      replacedByDraftId: created.id,
      decidedFromAssistant: true,
      rejectReason: 'Replaced by a newer draft',
    });
    await r
      .post(`/customer-drafts/${old.id}/approve`, cookies.salesDxb, { version: 2 })
      .expect(409);
  });

  it("refuses another user's draft, a decided draft, a draft of another kind and a bad id", async () => {
    const count = () => t.prisma.customerDraft.count();
    const others = await customerDraft(customerRequest());
    const othersByKey = (await createDraft(customerRequest(), tokens.sales2).expect(201))
      .body as EntryDraftSummaryDto;
    let before = await count();
    await createDraft({ ...customerRequest(), replacesDraftId: othersByKey.id }).expect(404);
    expect(await count()).toBe(before);

    await r
      .post(`/customer-drafts/${others.id}/reject`, cookies.salesDxb, { version: 1, reason: 'No' })
      .expect(200);
    before = await count();
    await createDraft({ ...customerRequest(), replacesDraftId: others.id }).expect(409);
    expect(await count()).toBe(before);

    const quotationDraftId = '00000000-0000-4000-8000-000000000000';
    await createDraft({ ...customerRequest(), replacesDraftId: quotationDraftId }).expect(404);
    await createDraft({ ...customerRequest(), replacesDraftId: 'not-a-uuid' }).expect(400);
  });

  it('refuses a draft in a branch the user no longer holds, and leaves it open', async () => {
    const created = (await createDraft(customerRequest(), tokens.moved).expect(201))
      .body as EntryDraftSummaryDto;
    await t.prisma.userBranch.deleteMany({ where: { userId: movedAgentId, branchId: dxb } });
    const before = await t.prisma.customerDraft.count();
    await createDraft(
      { ...customerRequest({ branchId: jed }), replacesDraftId: created.id },
      tokens.moved,
    ).expect(404);
    expect(await t.prisma.customerDraft.count()).toBe(before);
    const old = (await r.get(`/customer-drafts/${created.id}`, cookies.salesDxb).expect(200))
      .body as CustomerDraftDto;
    expect(old).toMatchObject({ status: 'DRAFT', version: 1 });
  });

  /**
   * Holds the old draft's row lock in another transaction until `count` requests are queued
   * behind it, then lets them all go: they always reach the old draft together.
   */
  async function allWaitingOn(oldId: string, count: number, requests: () => Promise<unknown>[]) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "customer_drafts" WHERE "id" = ${oldId}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const pending = Promise.all(requests());
    for (let i = 0; i < 200; i += 1) {
      const rows = await t.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
      if ((rows[0]?.n ?? 0) >= count) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    return (await pending) as { status: number; body: unknown }[];
  }

  it('identical replacements at once make one draft; another key at once is refused', async () => {
    const old = await customerDraft();
    const body = { ...customerRequest({ city: 'Kassala' }), replacesDraftId: old.id };
    const same = await allWaitingOn(old.id, 2, () => [createDraft(body), createDraft(body)]);
    expect(same.map((x) => x.status)).toEqual([201, 201]);
    const ids = new Set(same.map((x) => (x.body as EntryDraftSummaryDto).id));
    expect(ids.size).toBe(1);

    const other = await customerDraft();
    const racing = await allWaitingOn(other.id, 2, () => [
      createDraft({ ...customerRequest(), replacesDraftId: other.id }),
      createDraft({ ...customerRequest(), replacesDraftId: other.id }),
    ]);
    expect(racing.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(await t.prisma.customerDraft.count({ where: { replacesDraftId: other.id } })).toBe(1);
  });
});

// The approval gate (no-required-fields plan, 3.3): a draft holding a malformed value is refused
// before any check against live data, and no customer is created; then it approves once.
describe('customer drafts: the approval gate', () => {
  it('refuses a draft holding a phone not in +E.164 form, creating no customer', async () => {
    const draft = await customerDraft();
    const phone = draft.request.phone ?? '';
    expect(phone).not.toBe('');
    await t.prisma.customerDraft.update({
      where: { id: draft.id },
      data: { phone: '0912345678' },
    });
    expectGateRefusal(
      await r.post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }),
      [],
      ['phone'],
    );
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.salesJed, { version: 1 })
      .expect(404);
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(403);
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 2 })
      .expect(409);
    expect(await t.prisma.customer.count({ where: { phone: '0912345678' } })).toBe(0);
    expect(
      await t.prisma.customerDraft.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({ state: 'DRAFT', version: 1, customerId: null });

    await t.prisma.customerDraft.update({
      where: { id: draft.id },
      data: { phone },
    });
    const approved = (
      await r
        .post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
        .expect(200)
    ).body as CustomerDraftDto;
    expect(approved.status).toBe('APPROVED');
    await r
      .post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(200);
    expect(await t.prisma.customer.count({ where: { phone } })).toBe(1);
  });
});

describe("customer drafts: the staff member's words", () => {
  it('keeps the words with the draft and approves only once each value is ticked', async () => {
    const evidence = [
      { field: 'name', quote: 'اسمه طارق اسماعيل' },
      { field: 'phone', quote: 'رقمه 0912' },
      { field: 'branchId', quote: 'فرع دبي' },
    ];
    const body = { ...customerRequest(), evidence };
    const draft = await customerDraft(body);
    expect(draft.evidence).toEqual(evidence);
    // Other words under the same key are another request.
    await createDraft({ ...body, evidence: evidence.slice(0, 2) }).expect(409);
    const approve = (confirmed?: string[]) =>
      r.post(`/customer-drafts/${draft.id}/approve`, cookies.salesDxb, {
        version: 1,
        ...(confirmed ? { confirmed } : {}),
      });
    await approve().expect(400);
    await approve(['name', 'phone']).expect(400);
    await approve(['name', 'phone', 'branchId', 'whatsapp']).expect(400);
    expect(await t.prisma.customer.count({ where: { phone: body.phone } })).toBe(0);
    await approve(['branchId', 'phone', 'name']).expect(200);
    expect(await t.prisma.customer.count({ where: { phone: body.phone } })).toBe(1);
  });

  it('refuses words for a field it does not bind, or the same field twice', async () => {
    const before = await t.prisma.customerDraft.count();
    await createDraft(customerRequest({ evidence: [{ field: 'notes', quote: 'x' }] })).expect(400);
    await createDraft(
      customerRequest({
        evidence: [
          { field: 'name', quote: 'a' },
          { field: 'name', quote: 'b' },
        ],
      }),
    ).expect(400);
    expect(await t.prisma.customerDraft.count()).toBe(before);
  });
});

// Drafts saved with missing values (no-required-fields plan, 3.2 and 3.3): a customer draft names
// only its branch (security context); the rest is filled in on review (PATCH), and approving is
// refused (422) while anything is missing, creating no customer.
describe('customer drafts saved with missing values', () => {
  const MISSING = ['kind', 'name', 'phone'];
  const read = async (id: string) =>
    (await r.get(`/customer-drafts/${id}`, cookies.salesDxb).expect(200)).body as CustomerDraftDto;

  it('saves an empty draft and a partly filled one, and reads them back with nulls', async () => {
    const empty = (await createDraft({ idempotencyKey: draftKey(), branchId: dxb }).expect(201))
      .body as EntryDraftSummaryDto;
    expect(empty.missingFields).toEqual(MISSING);
    const draft = await read(empty.id);
    expect(draft).toMatchObject({
      subject: '',
      missingFields: MISSING,
      check: null,
      actions: { canEdit: true, canDecide: true },
      request: { kind: null, name: null, phone: null },
    });
    const list = (await r.get('/customer-drafts?status=DRAFT', cookies.salesDxb).expect(200))
      .body as CustomerDraftListItemDto[];
    expect(list.find((d) => d.id === empty.id)).toMatchObject({ phone: null, subject: '' });
    const mine = (await r.agentGet('/assistant-drafts/mine', tokens.sales).expect(200)).body as {
      id: string;
      subject: string;
    }[];
    expect(mine.find((d) => d.id === empty.id)).toMatchObject({ subject: '' });

    const partial = (
      await createDraft({
        idempotencyKey: draftKey(),
        branchId: dxb,
        name: 'Partly Filled',
      }).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(partial.missingFields).toEqual(['kind', 'phone']);
  });

  it('still checks every value given and the branch', async () => {
    const before = await t.prisma.customerDraft.count();
    await createDraft({ idempotencyKey: draftKey() }).expect(400);
    await createDraft({ idempotencyKey: draftKey(), branchId: dxb, phone: '0912' }).expect(400);
    await createDraft({ idempotencyKey: draftKey(), branchId: dxb, kind: 'ROBOT' }).expect(400);
    await createDraft({ idempotencyKey: draftKey(), branchId: jed }).expect(403);
    expect(await t.prisma.customerDraft.count()).toBe(before);
  });

  it('refuses the approval while values are missing, then approves once filled in', async () => {
    const { id } = (await createDraft({ idempotencyKey: draftKey(), branchId: dxb }).expect(201))
      .body as EntryDraftSummaryDto;
    const customers = await t.prisma.customer.count();
    expectGateRefusal(
      await r.post(`/customer-drafts/${id}/approve`, cookies.salesDxb, { version: 1 }),
      MISSING,
    );
    expect(await t.prisma.customer.count()).toBe(customers);

    const edit = (cookie: string, body: object) => r.patch(`/customer-drafts/${id}`, cookie, body);
    await edit(cookies.salesJed, { version: 1, name: 'x' }).expect(404);
    await edit(cookies.opsDxb, { version: 1, name: 'x' }).expect(403);
    await r
      .agentPatch(`/customer-drafts/${id}`, tokens.sales, { version: 1, name: 'x' })
      .expect(403);
    await edit(cookies.salesDxb, { version: 2, name: 'x' }).expect(409);
    await edit(cookies.salesDxb, { version: 1, phone: '0912' }).expect(400);
    await edit(cookies.salesDxb, { version: 1, branchId: jed }).expect(400);
    const taken = (
      await r
        .post('/customers', cookies.salesDxb, {
          branchId: dxb,
          kind: 'COMPANY',
          name: 'Phone Holder',
          phone: uniquePhone(),
        })
        .expect(201)
    ).body as CustomerDto;
    await edit(cookies.salesDxb, { version: 1, phone: taken.phone }).expect(409);
    expect((await read(id)).version).toBe(1);

    const phone = uniquePhone();
    const filled = (
      await edit(cookies.salesDxb, {
        version: 1,
        kind: 'INDIVIDUAL',
        name: 'Filled In Later',
        phone,
      }).expect(200)
    ).body as CustomerDraftDto;
    expect(filled).toMatchObject({ version: 2, missingFields: [], subject: 'Filled In Later' });
    await r.post(`/customer-drafts/${id}/approve`, cookies.salesDxb, { version: 1 }).expect(409);
    const approved = (
      await r.post(`/customer-drafts/${id}/approve`, cookies.salesDxb, { version: 2 }).expect(200)
    ).body as CustomerDraftDto;
    expect(approved.status).toBe('APPROVED');
    const again = (
      await r.post(`/customer-drafts/${id}/approve`, cookies.salesDxb, { version: 2 }).expect(200)
    ).body as CustomerDraftDto;
    expect(again.customerId).toBe(approved.customerId);
    expect(await t.prisma.customer.count({ where: { phone } })).toBe(1);
    await edit(cookies.salesDxb, { version: 3, notes: 'x' }).expect(409);
  });
});

// The branch is checked again inside the write's transaction, as stored then (Codex P88-1): a
// membership revoked after the request loaded the user's branches, before the write, refuses the
// save and the edit (403), writing nothing.
describe('customer drafts when the branch is revoked before the write', () => {
  it('refuses the save and the edit, and still answers a replay', async () => {
    const agent = await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX);
    const token = await tokenFor(t, await signIn(t, agent.email), client);
    const person = await createUser(t.prisma, ['SALES'], ['DXB']);
    const cookie = await signIn(t, person.email);

    const key = draftKey();
    const save = await revokedBeforeTransaction(
      t,
      '/customer-drafts.service',
      { userId: agent.id, branchId: dxb },
      () => createDraft({ idempotencyKey: key, branchId: dxb, name: 'Revoked Branch' }, token),
    );
    expect(save.revoked).toBe(true);
    expect(save.result.status).toBe(403);
    expect(await t.prisma.customerDraft.count({ where: { idempotencyKey: key } })).toBe(0);

    // A request already saved is answered as it was, before any check on live data.
    const body = { idempotencyKey: draftKey(), branchId: dxb, name: 'Saved Before' };
    const saved = (await createDraft(body, token).expect(201)).body as EntryDraftSummaryDto;
    const replay = await revokedBeforeTransaction(
      t,
      '/customer-drafts.service',
      { userId: agent.id, branchId: dxb },
      () => createDraft(body, token),
    );
    expect(replay.result.status).toBe(201);
    expect((replay.result.body as EntryDraftSummaryDto).id).toBe(saved.id);

    const edit = await revokedBeforeTransaction(
      t,
      '/customer-drafts.service',
      { userId: person.id, branchId: dxb },
      () => r.patch(`/customer-drafts/${saved.id}`, cookie, { version: 1, name: 'Changed' }),
    );
    expect(edit.revoked).toBe(true);
    expect(edit.result.status).toBe(403);
    expect(
      await t.prisma.customerDraft.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toMatchObject({ version: 1, name: 'Saved Before' });
    // With the branch held again, the same edit goes through.
    await r
      .patch(`/customer-drafts/${saved.id}`, cookie, { version: 1, name: 'Changed' })
      .expect(200);
  });
});
