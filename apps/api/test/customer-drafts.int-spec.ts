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
  registerClient,
  requests,
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

const cookies = { admin: '', salesDxb: '', salesJed: '', opsDxb: '' };
const agentCookies = { salesAgent: '', opsAgent: '' };
const tokens = { sales: '', ops: '' };

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
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Customer draft platform');
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
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
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'status', 'version'].sort(),
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
    expect(draft.actions).toEqual({ canEdit: false, canDecide: true });
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
    expect(approved.customerNumber).toMatch(/^NOL-CUS-/);
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
