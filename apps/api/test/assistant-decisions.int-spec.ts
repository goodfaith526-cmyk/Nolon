import type {
  AgentClientCreatedDto,
  AssistantApprovalGrantsDto,
  AssistantDraftDto,
  CustomerDto,
  EntryDraftSummaryDto,
  QuotationDraftDto,
  QuotationDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/auth-user.js';
import { referenceNames } from '../src/drafts/reference-names.js';
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

// A person approves or rejects, inside the assistant's chat, an entry draft the assistant made
// for them (erp-agents docs/chat-draft-approval.md). NOLON accepts it only for a draft this same
// assistant client created for this same user, with an administrator's grant for the kind, and
// for the content and version the chat card showed. Quotations stand for every kind: the six
// types share DraftsService.authorizeAssistant.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let otherClient: AgentClientCreatedDto;
let customer: CustomerDto;

const ids = { sales: '', salesPeer: '' };
const cookies = { admin: '', sales: '', salesDxb: '' };
const tokens = { sales: '', salesOther: '', salesPeer: '' };

const tomorrowPlus = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function quotationRequest() {
  return {
    idempotencyKey: draftKey(),
    customerId: customer.id,
    originLocationId: '',
    destinationLocationId: '',
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
  };
}

let route = { origin: '', destination: '' };

async function newDraft(token = tokens.sales): Promise<string> {
  const body = {
    ...quotationRequest(),
    originLocationId: route.origin,
    destinationLocationId: route.destination,
  };
  return (
    (await r.agentPost('/quotation-drafts', token, body).expect(201)).body as EntryDraftSummaryDto
  ).id;
}

const card = async (id: string, token = tokens.sales) =>
  (await r.agentGet(`/quotation-drafts/${id}/assistant`, token).expect(200))
    .body as AssistantDraftDto<QuotationDraftDto>;

const grant = (userId: string, kinds: unknown, cookie = cookies.admin) =>
  r.put(`/users/${userId}/assistant-approvals`, cookie, { kinds });

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  const dxb = await branchId(t.prisma, 'DXB');
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  route = { origin: await loc('AEJEA'), destination: await loc('SDPZU') };
  const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX);
  const sales = await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX);
  const salesPeer = await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX);
  const salesDxb = await createUser(t.prisma, ['SALES'], ['DXB']);
  ids.sales = sales.id;
  ids.salesPeer = salesPeer.id;
  cookies.admin = await signIn(t, admin.email);
  cookies.sales = await signIn(t, sales.email);
  cookies.salesDxb = await signIn(t, salesDxb.email);
  client = await registerClient(t, cookies.admin, 'Chat approval platform');
  otherClient = await registerClient(t, cookies.admin, 'Chat approval other platform');
  tokens.sales = await tokenFor(t, cookies.sales, client);
  tokens.salesOther = await tokenFor(t, cookies.sales, otherClient);
  tokens.salesPeer = await tokenFor(t, await signIn(t, salesPeer.email), client);
  customer = (
    await r
      .post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Chat Approval Test Trading',
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('grants to decide drafts from the assistant chat', () => {
  it('are set by an administrator in a session, replaced as a set, and audited', async () => {
    const empty = (
      await r.get(`/users/${ids.salesPeer}/assistant-approvals`, cookies.admin).expect(200)
    ).body as AssistantApprovalGrantsDto;
    expect(empty).toEqual({ userId: ids.salesPeer, kinds: [] });
    const set = (await grant(ids.salesPeer, ['receipt', 'quotation', 'quotation']).expect(200))
      .body as AssistantApprovalGrantsDto;
    expect(set.kinds).toEqual(['quotation', 'receipt']);
    const now = (
      await r.get(`/users/${ids.salesPeer}/assistant-approvals`, cookies.admin).expect(200)
    ).body as AssistantApprovalGrantsDto;
    expect(now.kinds).toEqual(['quotation', 'receipt']);
    await grant(ids.salesPeer, ['receipt']).expect(200);
    const events = await t.prisma.auditEvent.findMany({
      where: { entity: 'USER', entityId: ids.salesPeer },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.changes)).toEqual([
      [{ field: 'assistantApprovals', before: null, after: 'quotation, receipt' }],
      [{ field: 'assistantApprovals', before: 'quotation, receipt', after: 'receipt' }],
    ]);
    await grant(ids.salesPeer, []).expect(200);
  });

  it('refuse goods receipts, unknown kinds and other fields', async () => {
    for (const kinds of [['grn'], ['journal_entry'], 'quotation']) {
      await grant(ids.salesPeer, kinds).expect(400);
    }
    await r
      .put(`/users/${ids.salesPeer}/assistant-approvals`, cookies.admin, {
        kinds: [],
        userId: ids.sales,
      })
      .expect(400);
  });

  it('are refused to a user without users:update, to the assistant and for an unknown user', async () => {
    await grant(ids.salesPeer, ['quotation'], cookies.salesDxb).expect(403);
    await r.agentGet(`/users/${ids.sales}/assistant-approvals`, tokens.sales).expect(403);
    await grant('00000000-0000-4000-8000-000000000000', ['quotation']).expect(404);
  });
});

describe('the chat card', () => {
  it('shows the draft the assistant made for this user, with its hash and the grant', async () => {
    const id = await newDraft();
    const shown = await card(id);
    expect(shown).toMatchObject({ kind: 'quotation', canDecideFromAssistant: false });
    expect(shown.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(shown.draft).toMatchObject({ id, status: 'DRAFT', version: 1 });
    // The same content reads with the same hash.
    expect((await card(id)).contentHash).toBe(shown.contentHash);
  });

  it('names every id in the proposed values, so the card never shows a bare id', async () => {
    const shown = await card(await newDraft());
    expect(shown.names).toEqual({
      [customer.id]: `${customer.number} Chat Approval Test Trading`,
      [route.origin]: expect.stringMatching(/^AEJEA /) as unknown,
      [route.destination]: expect.stringMatching(/^SDPZU /) as unknown,
    });
  });

  it('names only what the user may see, leaving out another branch’s records', async () => {
    const jed = await branchId(t.prisma, 'JED');
    const outsider = { allowedBranchIds: [jed] } as unknown as AuthUser;
    const names = await referenceNames(t.prisma, outsider, {
      customerId: customer.id,
      originLocationId: route.origin,
    });
    expect(Object.keys(names)).toEqual([route.origin]);
  });

  it('is not found for another user or another assistant client, and refused to a session', async () => {
    const id = await newDraft();
    await r.agentGet(`/quotation-drafts/${id}/assistant`, tokens.salesPeer).expect(404);
    await r.agentGet(`/quotation-drafts/${id}/assistant`, tokens.salesOther).expect(404);
    await r.get(`/quotation-drafts/${id}/assistant`, cookies.salesDxb).expect(403);
  });
});

describe('deciding in the chat', () => {
  it('needs the grant for the kind', async () => {
    await grant(ids.sales, []).expect(200);
    const id = await newDraft();
    const { contentHash } = await card(id);
    await r
      .agentPost(`/quotation-drafts/${id}/assistant-approve`, tokens.sales, {
        version: 1,
        contentHash,
      })
      .expect(403);
    await r
      .agentPost(`/quotation-drafts/${id}/assistant-reject`, tokens.sales, {
        version: 1,
        reason: 'no',
      })
      .expect(403);
    await grant(ids.sales, ['receipt']).expect(200);
    await r
      .agentPost(`/quotation-drafts/${id}/assistant-approve`, tokens.sales, {
        version: 1,
        contentHash,
      })
      .expect(403);
    expect(
      (await t.prisma.quotationDraft.findUniqueOrThrow({ where: { id } })).decidedAt,
    ).toBeNull();
  });

  it('approves the content and version the card showed, recorded as from the assistant', async () => {
    await grant(ids.sales, ['quotation']).expect(200);
    const id = await newDraft();
    const shown = await card(id);
    expect(shown.canDecideFromAssistant).toBe(true);
    const approve = (body: object, token = tokens.sales) =>
      r.agentPost(`/quotation-drafts/${id}/assistant-approve`, token, body);
    await approve({ version: 1, contentHash: 'a'.repeat(64) }).expect(409);
    await approve({ version: 2, contentHash: shown.contentHash }).expect(409);
    await approve({ version: 1 }).expect(400);
    await approve({ version: 1, contentHash: 'not-a-hash' }).expect(400);
    // Another user or another client of the same user cannot decide it.
    await approve({ version: 1, contentHash: shown.contentHash }, tokens.salesPeer).expect(404);
    await approve({ version: 1, contentHash: shown.contentHash }, tokens.salesOther).expect(404);
    const approved = (await approve({ version: 1, contentHash: shown.contentHash }).expect(200))
      .body as QuotationDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2, decidedFromAssistant: true });
    const row = await t.prisma.quotationDraft.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ decidedVia: 'ASSISTANT', decidedById: ids.sales });
    const quotation = (
      await r.get(`/quotations/${approved.quotationId}`, cookies.salesDxb).expect(200)
    ).body as QuotationDto;
    expect(quotation).toMatchObject({ status: 'DRAFT', total: '2999.5' });
  });

  it('asks for a reload when a name the card showed changed (a repriced rate card, say)', async () => {
    await grant(ids.sales, ['quotation']).expect(200);
    const id = await newDraft();
    const shown = await card(id);
    const number = customer.number;
    await t.prisma.customer.update({ where: { id: customer.id }, data: { number: `${number}-R` } });
    try {
      await r
        .agentPost(`/quotation-drafts/${id}/assistant-approve`, tokens.sales, {
          version: 1,
          contentHash: shown.contentHash,
        })
        .expect(409);
      expect((await card(id)).contentHash).not.toBe(shown.contentHash);
    } finally {
      await t.prisma.customer.update({ where: { id: customer.id }, data: { number } });
    }
  });

  it('rejects with a reason, recorded as from the assistant', async () => {
    const id = await newDraft();
    const rejected = (
      await r
        .agentPost(`/quotation-drafts/${id}/assistant-reject`, tokens.sales, {
          version: 1,
          reason: 'Customer changed their mind',
        })
        .expect(200)
    ).body as QuotationDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', decidedFromAssistant: true });
    expect((await t.prisma.quotationDraft.findUniqueOrThrow({ where: { id } })).decidedVia).toBe(
      'ASSISTANT',
    );
  });

  it('stops when the grant is withdrawn', async () => {
    const id = await newDraft();
    const { contentHash } = await card(id);
    await grant(ids.sales, []).expect(200);
    await r
      .agentPost(`/quotation-drafts/${id}/assistant-approve`, tokens.sales, {
        version: 1,
        contentHash,
      })
      .expect(403);
  });

  it('keeps the review screen a session route, recorded as such', async () => {
    const id = await newDraft();
    await r.agentPost(`/quotation-drafts/${id}/approve`, tokens.sales, { version: 1 }).expect(403);
    await r
      .post(`/quotation-drafts/${id}/assistant-approve`, cookies.salesDxb, {
        version: 1,
        contentHash: 'a'.repeat(64),
      })
      .expect(403);
    const approved = (
      await r.post(`/quotation-drafts/${id}/approve`, cookies.salesDxb, { version: 1 }).expect(200)
    ).body as QuotationDraftDto;
    expect(approved.decidedFromAssistant).toBe(false);
    expect((await t.prisma.quotationDraft.findUniqueOrThrow({ where: { id } })).decidedVia).toBe(
      'SESSION',
    );
  });

  it('never decides a goods receipt from the chat', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await r
      .agentPost(`/shipments/${id}/grn-drafts/${id}/assistant-approve`, tokens.sales, {})
      .expect(404);
    await r.agentPost(`/grn-drafts/${id}/assistant-approve`, tokens.sales, {}).expect(404);
  });
});
