import type {
  AgentClientCreatedDto,
  CustomerDto,
  DraftKeySettlementDto,
  EntryDraftSummaryDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DraftRetentionService,
  PURGED_DRAFT_MODELS,
} from '../src/drafts/draft-retention.service.js';
import { lockKeyInTx } from '../src/drafts/drafts.service.js';
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

// Settling a create's key (POST /assistant-drafts/settle): the final answer for a create whose
// response the assistant lost. CREATED when a draft is committed under the key; NOT_CREATED, and
// from then on no create under the key ever commits, not even one already in flight. The answer
// does not depend on permissions or branches the user may have lost since.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let customer: CustomerDto;
let jebelAli: string;
let portSudan: string;
const users: { id: string; email: string }[] = [];

const tomorrowPlus = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function quotationRequest(idempotencyKey: string) {
  return {
    idempotencyKey,
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
        unitPrice: '100',
        quantity: '1',
        description: 'Ocean freight',
      },
    ],
  };
}

/** A staff member with a delegated token for the test client. */
async function agentFor(roles: Parameters<typeof createUser>[1] = ['SALES']) {
  const user = await createUser(t.prisma, roles, ['DXB'], AGENT_PREFIX);
  users.push(user);
  const token = await tokenFor(t, await signIn(t, user.email), client);
  return { user, token };
}

const settle = async (token: string, idempotencyKey: string, kind = 'quotation') =>
  (await r.agentPost('/assistant-drafts/settle', token, { kind, idempotencyKey }).expect(200))
    .body as DraftKeySettlementDto;

const draftsUnder = (createdById: string, idempotencyKey: string) =>
  t.prisma.quotationDraft.count({ where: { createdById, idempotencyKey } });

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  jebelAli = await loc('AEJEA');
  portSudan = await loc('SDPZU');
  const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX);
  users.push(admin);
  const adminCookie = await signIn(t, admin.email);
  client = await registerClient(t, adminCookie, 'Key settle platform');
  const sales = await createUser(t.prisma, ['SALES'], ['DXB']);
  customer = (
    await r
      .post('/customers', await signIn(t, sales.email), {
        branchId: await branchId(t.prisma, 'DXB'),
        kind: 'COMPANY',
        name: 'Key Settle Trading',
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await t.prisma.assistantDraftKey.deleteMany({
    where: { createdById: { in: users.map((u) => u.id) } },
  });
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('settling a draft create key', () => {
  it('answers CREATED with the draft a create committed under the key', async () => {
    const { token } = await agentFor();
    const key = draftKey();
    const draft = (await r.agentPost('/quotation-drafts', token, quotationRequest(key)).expect(201))
      .body as EntryDraftSummaryDto;
    expect(await settle(token, key)).toEqual({ state: 'CREATED', draftId: draft.id });
  });

  it('answers NOT_CREATED for a key with no draft, and then refuses a create under it', async () => {
    const { user, token } = await agentFor();
    const key = draftKey();
    expect(await settle(token, key)).toEqual({ state: 'NOT_CREATED' });
    // The same question gets the same answer.
    expect(await settle(token, key)).toEqual({ state: 'NOT_CREATED' });
    const refused = await r
      .agentPost('/quotation-drafts', token, quotationRequest(key))
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'KEY_SETTLED' });
    expect(await draftsUnder(user.id, key)).toBe(0);
  });

  it('never lets a create in flight commit after NOT_CREATED, nor answer NOT_CREATED before it commits', async () => {
    const { user, token } = await agentFor();
    const key = draftKey();
    const agentClientId = client.client.id;
    let release = () => undefined as void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // Hold the key's lock, as a create part-way through its transaction would.
    let held = () => undefined as void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = t.prisma.$transaction(
      async (tx) => {
        await lockKeyInTx(tx, 'quotation_drafts', {
          agentClientId,
          createdById: user.id,
          idempotencyKey: key,
        });
        held();
        await released;
      },
      { timeout: 20_000 },
    );
    await holding;
    const create = r
      .agentPost('/quotation-drafts', token, quotationRequest(key))
      .then((res) => res);
    const settled = r
      .agentPost('/assistant-drafts/settle', token, { kind: 'quotation', idempotencyKey: key })
      .then((res) => res);
    // Both wait on the key's lock before either decides.
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const [row] = await t.prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 72031012 AND NOT granted`;
      waiting = row?.waiting ?? 0;
    }
    expect(waiting).toBe(2);
    release();
    await holder;
    const [created, answer] = await Promise.all([create, settled]);
    const body = answer.body as DraftKeySettlementDto;
    expect(answer.status).toBe(200);
    if (created.status === 201) {
      expect(body).toEqual({
        state: 'CREATED',
        draftId: (created.body as EntryDraftSummaryDto).id,
      });
    } else {
      expect(created.status).toBe(409);
      expect(created.body).toMatchObject({ code: 'KEY_SETTLED' });
      expect(body).toEqual({ state: 'NOT_CREATED' });
      expect(await draftsUnder(user.id, key)).toBe(0);
    }
  });

  it('answers CREATED even when the user has since lost the permission to see the draft', async () => {
    const { user, token } = await agentFor();
    const key = draftKey();
    const draft = (await r.agentPost('/quotation-drafts', token, quotationRequest(key)).expect(201))
      .body as EntryDraftSummaryDto;
    await t.prisma.userRole.deleteMany({ where: { userId: user.id } });
    // The draft's own read now refuses: that says nothing about whether it was created.
    await r.agentGet(`/quotation-drafts/by-key/${key}`, token).expect(403);
    expect(await settle(token, key)).toEqual({ state: 'CREATED', draftId: draft.id });
  });

  it('reaches only the key this assistant client used for this user, and only through the assistant', async () => {
    const owner = await agentFor();
    const someoneElse = await agentFor();
    const key = draftKey();
    await r.agentPost('/quotation-drafts', owner.token, quotationRequest(key)).expect(201);
    // Another user's same key is theirs, and still free.
    expect(await settle(someoneElse.token, key)).toEqual({ state: 'NOT_CREATED' });
    expect(await settle(owner.token, key)).toMatchObject({ state: 'CREATED' });
    // A key is scoped to its kind of draft.
    expect(await settle(owner.token, key, 'booking')).toEqual({ state: 'NOT_CREATED' });
    // A person's session cannot settle anything.
    const cookie = await signIn(t, owner.user.email);
    await r
      .post('/assistant-drafts/settle', cookie, { kind: 'quotation', idempotencyKey: key })
      .expect(403);
    // An unknown kind or a malformed key is refused.
    await r
      .agentPost('/assistant-drafts/settle', owner.token, { kind: 'journal', idempotencyKey: key })
      .expect(400);
    await r
      .agentPost('/assistant-drafts/settle', owner.token, {
        kind: 'quotation',
        idempotencyKey: 'x',
      })
      .expect(400);
  });
});

describe('the key ledger: a settle answers the same after the draft is purged', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const purge = (now: Date) => t.app.get(DraftRetentionService).purge(now);
  const ledger = (createdById: string, idempotencyKey: string) =>
    t.prisma.assistantDraftKey.findMany({ where: { createdById, idempotencyKey } });

  /** A draft whose create answer was "lost", expired long enough ago for the purge. */
  async function purgeableDraft() {
    const { user, token } = await agentFor();
    const key = draftKey();
    const draft = (await r.agentPost('/quotation-drafts', token, quotationRequest(key)).expect(201))
      .body as EntryDraftSummaryDto;
    await t.prisma.quotationDraft.update({
      where: { id: draft.id },
      data: { expiresAt: new Date(Date.now() - 91 * DAY) },
    });
    return { user, token, key, draft };
  }

  it('answers CREATED after the purge removed the draft, and refuses a re-send', async () => {
    const { user, token, key, draft } = await purgeableDraft();
    await purge(new Date());
    expect(await t.prisma.quotationDraft.count({ where: { id: draft.id } })).toBe(0);
    expect(await ledger(user.id, key)).toMatchObject([
      { outcome: 'CREATED', draftId: draft.id, ackedAt: null },
    ]);
    expect(await settle(token, key)).toEqual({ state: 'CREATED', draftId: draft.id });
    // The same request again never makes a second draft.
    const resent = await r.agentPost('/quotation-drafts', token, quotationRequest(key)).expect(409);
    expect(resent.body).toMatchObject({ code: 'KEY_SETTLED' });
    expect(await draftsUnder(user.id, key)).toBe(0);
  });

  it('keeps a key until acknowledged, and then for the retention period only', async () => {
    const { user, token, key, draft } = await purgeableDraft();
    await purge(new Date());
    // Never acknowledged: kept, years on too.
    await purge(new Date(Date.now() + 3650 * DAY));
    expect(await ledger(user.id, key)).toHaveLength(1);
    const acked = (
      await r
        .agentPost('/assistant-drafts/settle/ack', token, {
          kind: 'quotation',
          idempotencyKey: key,
        })
        .expect(200)
    ).body as DraftKeySettlementDto;
    expect(acked).toEqual({ state: 'CREATED', draftId: draft.id });
    const [row] = await ledger(user.id, key);
    expect(row?.ackedAt).toBeInstanceOf(Date);
    await purge(new Date(Date.now() + 89 * DAY));
    expect(await ledger(user.id, key)).toHaveLength(1);
    await purge(new Date(Date.now() + 91 * DAY));
    expect(await ledger(user.id, key)).toHaveLength(0);
  });

  it('acknowledges a key with no draft as NOT_CREATED, final from then on', async () => {
    const { user, token } = await agentFor();
    const key = draftKey();
    expect(
      (
        await r
          .agentPost('/assistant-drafts/settle/ack', token, {
            kind: 'quotation',
            idempotencyKey: key,
          })
          .expect(200)
      ).body,
    ).toEqual({ state: 'NOT_CREATED' });
    expect(await ledger(user.id, key)).toMatchObject([{ outcome: 'NOT_CREATED', draftId: null }]);
    await r.agentPost('/quotation-drafts', token, quotationRequest(key)).expect(409);
    expect(await draftsUnder(user.id, key)).toBe(0);
  });

  it('a purge that fails part-way deletes no draft and records no key', async () => {
    const { user, key, draft } = await purgeableDraft();
    const failing = vi
      .spyOn(PURGED_DRAFT_MODELS, 'RateCardDraft')
      .mockRejectedValue(new Error('purge failed'));
    try {
      await expect(purge(new Date())).rejects.toThrow('purge failed');
    } finally {
      failing.mockRestore();
    }
    expect(await t.prisma.quotationDraft.count({ where: { id: draft.id } })).toBe(1);
    expect(await ledger(user.id, key)).toHaveLength(0);
  });
});
