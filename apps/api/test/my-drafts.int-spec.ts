import type {
  AgentClientCreatedDto,
  CustomerDto,
  DraftCapabilitiesDto,
  EntryDraftSummaryDto,
  MyDraftItemDto,
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

// "My drafts" (GET /assistant-drafts/mine): the drafts the assistant made for this user, of every
// kind, with what an approval made. Only kinds the user may view now, in branches they hold now,
// and through the assistant only its own drafts.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let otherClient: AgentClientCreatedDto;
let dxbCustomer: CustomerDto;
let jedCustomer: CustomerDto;
let jebelAli: string;
let portSudan: string;
let jed: string;
let agentUser: { id: string; email: string };

const cookies = { admin: '', salesDxb: '', salesJed: '', agent: '', other: '' };
const tokens = { agent: '', agentOther: '', other: '' };

const tomorrowPlus = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function quotationRequest(customerId: string) {
  return {
    idempotencyKey: draftKey(),
    customerId,
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
        unitPrice: '100',
        quantity: '1',
        description: 'Ocean freight',
      },
    ],
  };
}

const proposeQuotation = async (customerId: string, token = tokens.agent) =>
  (await r.agentPost('/quotation-drafts', token, quotationRequest(customerId)).expect(201))
    .body as EntryDraftSummaryDto;

const mine = async (token: string, query = '') =>
  (await r.agentGet(`/assistant-drafts/mine${query}`, token).expect(200)).body as MyDraftItemDto[];

const ids = (items: MyDraftItemDto[]) => items.map((i) => i.id);

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  const dxb = await branchId(t.prisma, 'DXB');
  jed = await branchId(t.prisma, 'JED');
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
  client = await registerClient(t, cookies.admin, 'My drafts platform');
  otherClient = await registerClient(t, cookies.admin, 'My drafts other platform');
  agentUser = await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], AGENT_PREFIX);
  const other = await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], AGENT_PREFIX);
  cookies.agent = await signIn(t, agentUser.email);
  cookies.other = await signIn(t, other.email);
  tokens.agent = await tokenFor(t, cookies.agent, client);
  tokens.agentOther = await tokenFor(t, cookies.agent, otherClient);
  tokens.other = await tokenFor(t, cookies.other, client);
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
  dxbCustomer = await newCustomer(dxb, cookies.salesDxb, 'My Drafts DXB Trading');
  jedCustomer = await newCustomer(jed, cookies.salesJed, 'My Drafts JED Trading');
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('my drafts', () => {
  it("lists the user's own drafts, newest first, and never the values they hold", async () => {
    const first = await proposeQuotation(dxbCustomer.id);
    const second = await proposeQuotation(jedCustomer.id);
    const items = await mine(tokens.agent);
    expect(ids(items).slice(0, 2)).toEqual([second.id, first.id]);
    expect(items[1]).toEqual({
      kind: 'quotation',
      id: first.id,
      status: 'DRAFT',
      subject: dxbCustomer.name,
      branchId: dxbCustomer.branchId,
      branchCode: 'DXB',
      createdAt: first.createdAt,
      expiresAt: first.expiresAt,
      decidedAt: null,
      decidedByName: null,
      rejectReason: null,
      reviewPath: `/drafts/quotations/${first.id}`,
      result: null,
    });
    // On the screen, the same user sees them too.
    const onScreen = (await r.get('/assistant-drafts/mine', cookies.agent).expect(200))
      .body as MyDraftItemDto[];
    expect(ids(onScreen)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it("shows the record an approval made, and a rejection's reason", async () => {
    const approved = await proposeQuotation(dxbCustomer.id);
    const draft = (await r.get(`/quotation-drafts/${approved.id}`, cookies.salesDxb).expect(200))
      .body as QuotationDraftDto;
    await r
      .post(`/quotation-drafts/${approved.id}/approve`, cookies.salesDxb, {
        version: draft.version,
        pricingKey: draft.pricing?.key,
      })
      .expect(200);
    const rejected = await proposeQuotation(dxbCustomer.id);
    await r
      .post(`/quotation-drafts/${rejected.id}/reject`, cookies.salesDxb, {
        version: 1,
        reason: 'Wrong route',
      })
      .expect(200);
    const items = await mine(tokens.agent);
    const quotation = await t.prisma.quotationDraft.findUniqueOrThrow({
      where: { id: approved.id },
      select: { quotation: { select: { id: true, number: true } } },
    });
    expect(items.find((i) => i.id === approved.id)).toMatchObject({
      status: 'APPROVED',
      result: {
        type: 'quotation',
        id: quotation.quotation?.id,
        number: quotation.quotation?.number,
        path: `/quotations/${quotation.quotation?.id}`,
      },
    });
    expect(items.find((i) => i.id === rejected.id)).toMatchObject({
      status: 'REJECTED',
      rejectReason: 'Wrong route',
      result: null,
    });
    expect(ids(await mine(tokens.agent, '?status=APPROVED'))).toContain(approved.id);
    expect(ids(await mine(tokens.agent, '?status=APPROVED'))).not.toContain(rejected.id);
  });

  it("never lists another user's drafts, or another assistant's", async () => {
    const own = await proposeQuotation(dxbCustomer.id);
    const theirs = await proposeQuotation(dxbCustomer.id, tokens.other);
    expect(ids(await mine(tokens.agent))).not.toContain(theirs.id);
    expect(ids(await mine(tokens.other))).not.toContain(own.id);
    // The same user through another assistant client: that assistant made none of them.
    expect(ids(await mine(tokens.agentOther))).not.toContain(own.id);
  });

  it('hides drafts in a branch the user no longer holds', async () => {
    const inJed = await proposeQuotation(jedCustomer.id);
    expect(ids(await mine(tokens.agent))).toContain(inJed.id);
    await t.prisma.userBranch.deleteMany({ where: { userId: agentUser.id, branchId: jed } });
    try {
      expect(ids(await mine(tokens.agent))).not.toContain(inJed.id);
    } finally {
      await t.prisma.userBranch.create({ data: { userId: agentUser.id, branchId: jed } });
    }
  });

  it('hides kinds the user may no longer view', async () => {
    const draft = await proposeQuotation(dxbCustomer.id);
    await t.prisma.userRole.deleteMany({ where: { userId: agentUser.id } });
    await t.prisma.userRole.create({ data: { userId: agentUser.id, role: 'WAREHOUSE' } });
    try {
      expect(ids(await mine(tokens.agent))).not.toContain(draft.id);
    } finally {
      await t.prisma.userRole.deleteMany({ where: { userId: agentUser.id } });
      await t.prisma.userRole.create({ data: { userId: agentUser.id, role: 'SALES' } });
    }
    expect(ids(await mine(tokens.agent))).toContain(draft.id);
  });

  it('takes a limit and a start time, and refuses anything else', async () => {
    await proposeQuotation(dxbCustomer.id);
    const latest = await proposeQuotation(dxbCustomer.id);
    expect(ids(await mine(tokens.agent, '?limit=1'))).toEqual([latest.id]);
    const since = encodeURIComponent(latest.createdAt);
    expect(ids(await mine(tokens.agent, `?since=${since}`))).toEqual([latest.id]);
    // The next page starts before the last item shown.
    const before = encodeURIComponent(latest.createdAt);
    expect(ids(await mine(tokens.agent, `?limit=1&before=${before}`))).not.toContain(latest.id);
    expect(await mine(tokens.agent, '?kind=booking')).toEqual([]);
    expect(ids(await mine(tokens.agent, '?kind=quotation'))).toContain(latest.id);
    await r.agentGet('/assistant-drafts/mine?kind=journal', tokens.agent).expect(400);
    await r.agentGet('/assistant-drafts/mine?limit=51', tokens.agent).expect(400);
    await r.agentGet('/assistant-drafts/mine?userId=x', tokens.agent).expect(400);
  });

  it('pages through drafts that share a creation time without skipping any', async () => {
    // Drafts made in one transaction (a new customer and its booking) share a createdAt.
    const a = await proposeQuotation(dxbCustomer.id);
    const b = await proposeQuotation(dxbCustomer.id);
    const tied = new Date(Date.now() + 86_400_000);
    await t.prisma.quotationDraft.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { createdAt: tied },
    });
    const at = encodeURIComponent(tied.toISOString());
    const [first] = await mine(tokens.agent, '?limit=1');
    expect([a.id, b.id]).toContain(first?.id);
    const second = await mine(tokens.agent, `?limit=1&before=${at}&beforeId=${first?.id}`);
    expect(ids(second)).toEqual([first?.id === a.id ? b.id : a.id]);
    const third = await mine(tokens.agent, `?limit=50&before=${at}&beforeId=${second[0]?.id}`);
    expect(ids(third)).not.toContain(a.id);
    expect(ids(third)).not.toContain(b.id);
    await r.agentGet(`/assistant-drafts/mine?beforeId=${a.id}`, tokens.agent).expect(400);
  });
});

describe('draft capabilities', () => {
  it('say what this NOLON offers and which kinds this user may create, to the assistant and on screen', async () => {
    const caps = (await r.agentGet('/assistant-drafts/capabilities', tokens.agent).expect(200))
      .body as DraftCapabilitiesDto;
    expect(caps.api).toBe(1);
    expect(caps.features).toEqual({
      preCheck: true,
      myDrafts: true,
      settle: true,
      settleAck: true,
    });
    const quotation = caps.kinds.find((k) => k.kind === 'quotation');
    expect(quotation).toEqual({
      kind: 'quotation',
      path: '/quotation-drafts',
      preCheck: true,
      review: '/drafts/quotations/:id',
      canCreate: true,
      approval: 'both',
    });
    // Sales may not create a trip draft.
    expect(caps.kinds.find((k) => k.kind === 'trip')?.canCreate).toBe(false);
    await r.get('/assistant-drafts/capabilities', cookies.agent).expect(200);
  });
});
