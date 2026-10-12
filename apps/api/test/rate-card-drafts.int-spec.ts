import { randomInt } from 'node:crypto';
import type {
  AgentClientCreatedDto,
  EntryDraftSummaryDto,
  RateCardDraftDto,
  RateCardDraftListItemDto,
  RateCardDto,
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
import { deleteCommercialTestData } from './test-data.js';

// Selling rates proposed by the staff assistant (entry drafts). The assistant's users (agent-it-)
// create drafts; it- users approve them, so the rates they create are removed by the usual cleanup.

// Each rate starts on a day of its own, in a range no other spec uses: a branch holds one draft or
// approved rate per offer, start date included.
let rateDay = randomInt(0, 15000);
const nextRateDay = () =>
  new Date(Date.UTC(1900, 0, 1) + rateDay++ * 86_400_000).toISOString().slice(0, 10);

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let jed: string;
let jebelAli: string;
let portSudan: string;

const cookies = { admin: '', salesDxb: '', salesJed: '', opsDxb: '', managerDxb: '' };
const agentCookies = { salesAgent: '', opsAgent: '' };
const tokens = { sales: '', ops: '' };

function rateRequest(extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    branchId: dxb,
    originLocationId: jebelAli,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    containerTypeCode: '40HC',
    unit: 'PER_CONTAINER',
    price: '1250.50',
    currency: 'USD',
    validFrom: nextRateDay(),
    validTo: '2099-12-31',
    ...extra,
  };
}

/** The same rate as a direct POST /rates body: no idempotency key. */
function directRate(body: object): Record<string, unknown> {
  const rate: Record<string, unknown> = { ...body };
  delete rate['idempotencyKey'];
  return rate;
}

const createDraft = (body: object, token = tokens.sales) =>
  r.agentPost('/rate-card-drafts', token, body);

async function rateDraft(body: object = rateRequest()): Promise<RateCardDraftDto> {
  const created = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/rate-card-drafts/${created.id}`, cookies.salesDxb).expect(200))
    .body as RateCardDraftDto;
}

const approve = (id: string, cookie = cookies.salesDxb, body: object = { version: 1 }) =>
  r.post(`/rate-card-drafts/${id}/approve`, cookie, body);

const ratesOn = (validFrom: string) =>
  t.prisma.rateCard.count({
    where: { branchId: dxb, originLocationId: jebelAli, validFrom: new Date(validFrom) },
  });

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
    managerDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
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
  client = await registerClient(t, cookies.admin, 'Rate card draft platform');
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('rate card drafts: the assistant proposes', () => {
  it('creates a draft, gets back ids and counts only, and creates no rate yet', async () => {
    const body = rateRequest();
    const summary = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(Object.keys(summary).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'status', 'version'].sort(),
    );
    expect(summary).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(await ratesOn(body.validFrom)).toBe(0);
  });

  it('returns the same draft for a repeat, also with the amount written otherwise', async () => {
    const body = rateRequest();
    const first = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const again = (await createDraft({ ...body, price: '1250.5000' }).expect(201))
      .body as EntryDraftSummaryDto;
    expect(again.id).toBe(first.id);
    await createDraft({ ...body, price: '1250.51' }).expect(409);
    const found = (
      await r.agentGet(`/rate-card-drafts/by-key/${body.idempotencyKey}`, tokens.sales).expect(200)
    ).body as EntryDraftSummaryDto;
    expect(found.id).toBe(first.id);
  });

  it('refuses another branch, a missing permission, the same offer and bad fields', async () => {
    await createDraft(rateRequest({ branchId: jed })).expect(403);
    await createDraft(rateRequest(), tokens.ops).expect(403);
    const taken = rateRequest();
    await r.post('/rates', cookies.salesDxb, directRate(taken)).expect(201);
    await createDraft(rateRequest({ validFrom: taken.validFrom })).expect(409);
    await createDraft(rateRequest({ price: 1250.5 })).expect(400);
    await createDraft(rateRequest({ price: '-1' })).expect(400);
    await createDraft(rateRequest({ currency: 'XXX' })).expect(400);
    await createDraft(rateRequest({ status: 'APPROVED' })).expect(400);
  });

  it('cannot read, approve or reject drafts, nor create a rate itself', async () => {
    const draft = await rateDraft();
    await r.agentGet(`/rate-card-drafts/${draft.id}`, tokens.sales).expect(403);
    await r.agentGet('/rate-card-drafts', tokens.sales).expect(403);
    await r
      .agentPost(`/rate-card-drafts/${draft.id}/approve`, tokens.sales, { version: 1 })
      .expect(403);
    await r
      .agentPost(`/rate-card-drafts/${draft.id}/reject`, tokens.sales, {
        version: 1,
        reason: 'no',
      })
      .expect(403);
    await r.agentPost('/rates', tokens.sales, directRate(rateRequest())).expect(403);
  });
});

describe('rate card drafts: a person reviews', () => {
  it('shows drafts of their branches only; who cannot create rates cannot decide', async () => {
    const draft = await rateDraft();
    const list = (await r.get('/rate-card-drafts', cookies.salesDxb).expect(200))
      .body as RateCardDraftListItemDto[];
    const item = list.find((d) => d.id === draft.id);
    expect(item).toMatchObject({
      subject: 'AEJEA → SDPZU',
      price: '1250.5',
      currency: 'USD',
      actions: { canDecide: true },
    });
    const jedList = (await r.get('/rate-card-drafts', cookies.salesJed).expect(200))
      .body as RateCardDraftListItemDto[];
    expect(jedList.some((d) => d.id === draft.id)).toBe(false);
    await r.get(`/rate-card-drafts/${draft.id}`, cookies.salesJed).expect(404);
    const opsView = (await r.get(`/rate-card-drafts/${draft.id}`, cookies.opsDxb).expect(200))
      .body as RateCardDraftDto;
    expect(opsView.actions.canDecide).toBe(false);
    await approve(draft.id, cookies.opsDxb).expect(403);
    await approve(draft.id, cookies.salesJed).expect(404);
  });

  it('approves into an ordinary DRAFT rate of the branch, once, that a manager approves', async () => {
    const body = rateRequest({ minimumCharge: '300', transitDays: 21, notes: 'Peak season' });
    const draft = await rateDraft(body);
    expect(draft.check).toMatchObject({ ok: true });
    expect(draft.request).toMatchObject({ price: '1250.5', minimumCharge: '300' });
    const approved = (await approve(draft.id).expect(200)).body as RateCardDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null });
    expect(approved.rateCardId).not.toBeNull();
    await approve(draft.id).expect(200);
    expect(await ratesOn(body.validFrom)).toBe(1);
    const rate = (await r.get(`/rates/${approved.rateCardId}`, cookies.salesDxb).expect(200))
      .body as RateCardDto;
    expect(rate).toMatchObject({
      status: 'DRAFT',
      price: '1250.5',
      minimumCharge: '300',
      containerTypeCode: '40HC',
      chargeTypeCode: 'FREIGHT',
      validFrom: body.validFrom,
      transitDays: 21,
      notes: 'Peak season',
    });
    // The rate is in the audit log, in the approver's name, and goes through the usual approval.
    expect(
      await t.prisma.auditEvent.count({
        where: { entityId: rate.id, action: 'CREATED' },
      }),
    ).toBe(1);
    await r.post(`/rates/${rate.id}/approve`, cookies.managerDxb).expect(200);
  });

  it('a replay after the approval returns the saved draft, not a refusal', async () => {
    const body = rateRequest();
    const draft = await rateDraft(body);
    await approve(draft.id).expect(200);
    const replay = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(replay).toMatchObject({ id: draft.id, status: 'APPROVED' });
    // A new request for the offer the approval created is the duplicate it is.
    await createDraft({ ...body, idempotencyKey: draftKey() }).expect(409);
    expect(await ratesOn(body.validFrom)).toBe(1);
  });

  it('refuses the same offer added since the draft, under the lock, and leaves it open', async () => {
    const body = rateRequest();
    const draft = await rateDraft(body);
    await r.post('/rates', cookies.salesDxb, directRate(body)).expect(201);
    const read = (await r.get(`/rate-card-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as RateCardDraftDto;
    expect(read.check?.ok).toBe(false);
    await approve(draft.id).expect(409);
    const after = (await r.get(`/rate-card-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as RateCardDraftDto;
    expect(after.status).toBe('DRAFT');
    expect(await ratesOn(body.validFrom)).toBe(1);
  });

  it('two concurrent approvals create one rate', async () => {
    const body = rateRequest();
    const draft = await rateDraft(body);
    const results = await Promise.all([approve(draft.id), approve(draft.id)]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 200]);
    expect(await ratesOn(body.validFrom)).toBe(1);
  });

  it('rejects with a reason; decided drafts never change', async () => {
    const draft = await rateDraft();
    await r
      .post(`/rate-card-drafts/${draft.id}/reject`, cookies.salesDxb, {
        version: 1,
        reason: 'Price is from last season',
      })
      .expect(200);
    await approve(draft.id).expect(409);
    await expect(
      t.prisma.rateCardDraft.update({ where: { id: draft.id }, data: { notes: 'x' } }),
    ).rejects.toThrow(/decided and cannot change/);
  });

  it('the database refuses an approval without the rate it created', async () => {
    const draft = await rateDraft();
    const decider = await t.prisma.user.findFirstOrThrow({
      where: { email: { startsWith: 'it-' } },
    });
    await expect(
      t.prisma.rateCardDraft.update({
        where: { id: draft.id },
        data: {
          state: 'APPROVED',
          decidedAt: new Date(),
          decidedById: decider.id,
          decidedVia: 'SESSION',
        },
      }),
    ).rejects.toThrow(/rate_card_drafts_decision_check/);
  });
});

describe("rate card drafts: the staff member's words", () => {
  it('keeps the words with the draft and approves only once each value is ticked', async () => {
    const evidence = [
      { field: 'price', quote: 'السعر 1250 ونص دولار' },
      { field: 'destinationLocationId', quote: 'لبورتسودان' },
      { field: 'containerTypeCode', quote: 'الكونتينر الـ 40 هاي كيوب' },
    ];
    const body = rateRequest({ evidence });
    const draft = await rateDraft(body);
    expect(draft.evidence).toEqual(evidence);
    // Other words under the same key are another request.
    await createDraft({ ...body, evidence: evidence.slice(0, 2) }).expect(409);
    await approve(draft.id).expect(400);
    await approve(draft.id, cookies.salesDxb, {
      version: 1,
      confirmed: ['price', 'destinationLocationId'],
    }).expect(400);
    expect(await ratesOn(body.validFrom)).toBe(0);
    await approve(draft.id, cookies.salesDxb, {
      version: 1,
      confirmed: ['containerTypeCode', 'destinationLocationId', 'price'],
    }).expect(200);
    expect(await ratesOn(body.validFrom)).toBe(1);
  });

  it('refuses words for a field it does not bind, or the same field twice', async () => {
    const before = await t.prisma.rateCardDraft.count();
    await createDraft(rateRequest({ evidence: [{ field: 'notes', quote: 'x' }] })).expect(400);
    await createDraft(
      rateRequest({
        evidence: [
          { field: 'price', quote: 'a' },
          { field: 'price', quote: 'b' },
        ],
      }),
    ).expect(400);
    expect(await t.prisma.rateCardDraft.count()).toBe(before);
  });
});
