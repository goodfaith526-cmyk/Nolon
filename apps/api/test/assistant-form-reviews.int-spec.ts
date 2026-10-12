import type { AgentClientCreatedDto, FormReviewDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestApp,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { AGENT_PREFIX, registerClient, requests, tokenFor } from './agent-drafts-helpers.js';
import { DraftRetentionService } from '../src/drafts/draft-retention.service.js';

// "Review with the assistant": a form NOLON refused, kept for its author's assistant to read.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
const cookies = { admin: '', sales: '', otherSales: '', finance: '', ops: '' };
const tokens = { sales: '', otherSales: '' };

const refusedBooking = {
  form: 'booking',
  mode: 'create',
  values: {
    customerId: '00000000-0000-4000-8000-000000000001',
    mode: 'SEA',
    items: [{ quantity: 2, weightKg: '12٬5' }],
  },
  invalidFields: ['items.0.weightKg'],
  reason: 'items.0.weightKg',
  customerName: 'Acme Trading',
};

const keep = async (body: object = refusedBooking, cookie = cookies.sales) =>
  (await r.post('/assistant-form-reviews', cookie, body).expect(201)).body as FormReviewDto;

beforeAll(async () => {
  t = await createTestApp({ AGENT_ASSISTANT_URL: 'https://agent.test/?tenant=nolon-test' });
  r = requests(t);
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    sales: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    otherSales: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    finance: await createUser(t.prisma, ['FINANCE'], ['DXB']),
    ops: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Form review platform');
  tokens.sales = await tokenFor(t, cookies.sales, client);
  tokens.otherSales = await tokenFor(t, cookies.otherSales, client);
});

afterAll(async () => {
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('a refused form kept for the assistant', () => {
  it('is kept for an hour and read back by its author, in NOLON and through the assistant', async () => {
    const kept = await keep();
    expect(kept).toMatchObject({
      form: 'booking',
      mode: 'create',
      values: refusedBooking.values,
      invalidFields: ['items.0.weightKg'],
      customerName: 'Acme Trading',
    });
    const minutes = (Date.parse(kept.expiresAt) - Date.parse(kept.createdAt)) / 60_000;
    expect(minutes).toBe(60);
    const own = await r.get(`/assistant-form-reviews/${kept.id}`, cookies.sales).expect(200);
    expect((own.body as FormReviewDto).id).toBe(kept.id);
    const viaAgent = await r
      .agentGet(`/assistant-form-reviews/${kept.id}`, tokens.sales)
      .expect(200);
    expect((viaAgent.body as FormReviewDto).values).toEqual(refusedBooking.values);
  });

  it('is not found for anyone else, in NOLON or through the assistant', async () => {
    const kept = await keep();
    await r.get(`/assistant-form-reviews/${kept.id}`, cookies.otherSales).expect(404);
    await r.agentGet(`/assistant-form-reviews/${kept.id}`, tokens.otherSales).expect(404);
    await r.get(`/assistant-form-reviews/${kept.id}`, cookies.admin).expect(404);
  });

  it('is not found once expired, and the purge removes it', async () => {
    const kept = await keep();
    await t.prisma.assistantFormReview.update({
      where: { id: kept.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await r.agentGet(`/assistant-form-reviews/${kept.id}`, tokens.sales).expect(404);
    const purged = await t.app.get(DraftRetentionService).purge();
    expect(purged).toMatchObject({ skipped: false });
    expect(await t.prisma.assistantFormReview.count({ where: { id: kept.id } })).toBe(0);
  });

  it('needs the permission saving that form needs', async () => {
    await r.post('/assistant-form-reviews', cookies.finance, refusedBooking).expect(403);
    // Operations may save a booking, not a quotation.
    await keep(refusedBooking, cookies.ops);
    await r
      .post('/assistant-form-reviews', cookies.ops, { ...refusedBooking, form: 'quotation' })
      .expect(403);
    await r
      .post('/assistant-form-reviews', cookies.sales, { ...refusedBooking, mode: 'container' })
      .expect(403);
  });

  it('refuses other forms, unknown fields and the assistant itself', async () => {
    await r
      .post('/assistant-form-reviews', cookies.sales, { ...refusedBooking, form: 'invoice' })
      .expect(400);
    await r
      .post('/assistant-form-reviews', cookies.sales, { ...refusedBooking, userId: 'x' })
      .expect(400);
    // The assistant reads a kept form; it never writes one.
    const res = await r.agentPost('/assistant-form-reviews', tokens.sales, refusedBooking);
    expect([401, 403]).toContain(res.status);
  });

  it('is refused when NOLON has no assistant', async () => {
    const plain = await createTestApp({ AGENT_ASSISTANT_URL: undefined });
    try {
      const cookie = await signIn(
        plain,
        (await createUser(plain.prisma, ['SALES'], ['DXB'])).email,
      );
      await requests(plain).post('/assistant-form-reviews', cookie, refusedBooking).expect(404);
    } finally {
      await plain.close();
    }
  });
});
