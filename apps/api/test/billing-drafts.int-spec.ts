import { randomInt, randomUUID } from 'node:crypto';
import type {
  AccountDto,
  AssistantDraftDto,
  AgentClientCreatedDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  DraftPreCheckDto,
  EntryDraftSummaryDto,
  InvoiceDraftDto,
  InvoiceDraftListItemDto,
  InvoiceDraftSuggestedValuesDto,
  InvoiceSuggestionDto,
  ReceiptDraftDto,
  ReceiptDraftListItemDto,
  ReceiptCashAccountDto,
  ReceiptOpenInvoiceDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
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
import { uniquePhone } from './test-data.js';

// Invoice and receipt drafts proposed by the staff assistant (entry drafts). Approved receipts
// post entries, which are never deleted, so the people are LEDGER users, the customers and cash
// accounts are this run's own and documents are dated in a random year of this suite's range
// (300-599; the other ledger suites use 600-2000). The assistant's users are agent-it- users.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let pts: string;
let customer: CustomerDto;
let other: CustomerDto;
let cashUsd: AccountDto;
let cashSdg: AccountDto;

const year = String(randomInt(300, 600)).padStart(4, '0');
const d = (monthDay: string) => `${year}-${monthDay}`;

const cookies = { admin: '', financePts: '', financeJed: '', salesPts: '', opsPts: '' };
const agentCookies = { financeAgent: '', salesAgent: '', financeJedAgent: '' };
const tokens = { finance: '', sales: '', financeJed: '' };
const agentIds = { financeAgent: '' };

async function shipment(customerId = customer.id): Promise<string> {
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  const booking = (
    await r
      .post('/bookings', cookies.salesPts, {
        customerId,
        originLocationId: await loc('SDPZU'),
        destinationLocationId: await loc('SDKRT'),
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
      })
      .expect(201)
  ).body as BookingDto;
  const confirmed = (await r.post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
    .body as BookingDto;
  if (!confirmed.shipmentId) throw new Error('No shipment');
  return confirmed.shipmentId;
}

/** An approved USD invoice of `unitPrice` for a new shipment of the customer. */
async function approvedInvoice(unitPrice: string, customerId = customer.id) {
  const draft = (
    await r
      .post('/customer-invoices', cookies.financePts, { shipmentId: await shipment(customerId) })
      .expect(201)
  ).body as CustomerInvoiceDto;
  await t
    .http()
    .patch(`/api/v1/customer-invoices/${draft.id}`)
    .set('Origin', APP_ORIGIN)
    .set('Cookie', cookies.financePts)
    .send({
      currency: 'USD',
      invoiceDate: d('01-10'),
      dueDate: d('02-10'),
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice }],
    })
    .expect(200);
  return (await r.post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
    .body as CustomerInvoiceDto;
}

function invoiceRequest(shipmentId: string, extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    shipmentId,
    currency: 'USD',
    invoiceDate: d('03-01'),
    dueDate: d('03-31'),
    notes: 'Freight Port Sudan to Khartoum',
    lines: [{ chargeTypeCode: 'FREIGHT', quantity: '2', unitPrice: '100.505' }],
    ...extra,
  };
}

const createInvoiceDraft = (body: object, token = tokens.finance) =>
  r.agentPost('/invoice-drafts', token, body);

async function invoiceDraft(body: object): Promise<InvoiceDraftDto> {
  const created = (await createInvoiceDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/invoice-drafts/${created.id}`, cookies.financePts).expect(200))
    .body as InvoiceDraftDto;
}

function receiptRequest(invoiceId: string, extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    customerId: customer.id,
    receiptDate: d('04-01'),
    currency: 'USD',
    amount: '200.00',
    cashAccountId: cashUsd.id,
    reference: 'TT 12345',
    notes: 'Bank transfer',
    allocations: [{ invoiceId, amount: '200' }],
    ...extra,
  };
}

const createReceiptDraft = (body: object, token = tokens.finance) =>
  r.agentPost('/receipt-drafts', token, body);

async function receiptDraft(body: object): Promise<ReceiptDraftDto> {
  const created = (await createReceiptDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/receipt-drafts/${created.id}`, cookies.financePts).expect(200))
    .body as ReceiptDraftDto;
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  pts = await branchId(t.prisma, 'PTS');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
    financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
    salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const assistantUsers = {
    financeAgent: await createUser(t.prisma, ['FINANCE'], ['PTS'], AGENT_PREFIX),
    salesAgent: await createUser(t.prisma, ['SALES'], ['PTS'], AGENT_PREFIX),
    financeJedAgent: await createUser(t.prisma, ['FINANCE'], ['JED'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  agentIds.financeAgent = assistantUsers.financeAgent.id;
  client = await registerClient(t, cookies.admin, 'Billing draft platform');
  tokens.finance = await tokenFor(t, agentCookies.financeAgent, client);
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.financeJed = await tokenFor(t, agentCookies.financeJedAgent, client);

  const newCustomer = async (name: string) =>
    (
      await r
        .post('/customers', cookies.salesPts, {
          branchId: pts,
          kind: 'COMPANY',
          name: `${name} ${year} ${randomUUID().slice(0, 6)}`,
          phone: uniquePhone(),
          preferredCurrency: 'USD',
        })
        .expect(201)
    ).body as CustomerDto;
  customer = await newCustomer('Billing Draft');
  other = await newCustomer('Billing Draft Other');
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const cash = async (code: string, currency: string) =>
    (
      await r
        .post('/accounting/accounts', cookies.admin, {
          code,
          nameEn: `Draft test cash ${currency}`,
          nameAr: 'نقدية اختبار المسودات',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency,
          branchId: pts,
        })
        .expect(201)
    ).body as AccountDto;
  cashUsd = await cash(`D${suffix}U`, 'USD');
  cashSdg = await cash(`D${suffix}S`, 'SDG');
});

afterAll(async () => {
  await t.close();
});

// The approval gate (no-required-fields plan, 3.3): an incomplete or invalid draft is refused on
// the review screen and in the assistant's chat, before anything is checked against the ledger,
// and nothing live or financial is written; complete again, it approves once.
describe('invoice and receipt drafts: the approval gate', () => {
  const grant = (kinds: string[]) =>
    r
      .put(`/users/${agentIds.financeAgent}/assistant-approvals`, cookies.admin, { kinds })
      .expect(200);

  it('refuses an invoice draft without lines on both paths, writing no invoice; then approves', async () => {
    await grant(['invoice', 'receipt']);
    const shipmentId = await shipment();
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    const lines = await t.prisma.invoiceDraftLine.findMany({ where: { draftId: draft.id } });
    await t.prisma.invoiceDraftLine.deleteMany({ where: { draftId: draft.id } });

    expectGateRefusal(
      await r.post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 }),
      ['lines'],
    );
    const card = (
      await r.agentGet(`/invoice-drafts/${draft.id}/assistant`, tokens.finance).expect(200)
    ).body as AssistantDraftDto<InvoiceDraftDto>;
    expectGateRefusal(
      await r.agentPost(`/invoice-drafts/${draft.id}/assistant-approve`, tokens.finance, {
        version: 1,
        contentHash: card.contentHash,
      }),
      ['lines'],
    );
    // The usual refusals come first: another branch, no permission, an old version.
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.financeJed, { version: 1 })
      .expect(404);
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.salesPts, { version: 1 })
      .expect(403);
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 2 })
      .expect(409);
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(0);
    expect(
      await t.prisma.invoiceDraft.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({ state: 'DRAFT', version: 1, invoiceId: null });

    await t.prisma.invoiceDraftLine.createMany({ data: lines });
    const approved = (
      await r
        .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
        .expect(200)
    ).body as InvoiceDraftDto;
    expect(approved.status).toBe('APPROVED');
    const again = (
      await r
        .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
        .expect(200)
    ).body as InvoiceDraftDto;
    expect(again).toMatchObject({ status: 'APPROVED', invoiceId: approved.invoiceId });
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(1);
  });

  it('refuses a receipt draft holding an invalid currency on both paths, posting nothing', async () => {
    await grant(['invoice', 'receipt']);
    const invoice = await approvedInvoice('300');
    const draft = await receiptDraft(
      receiptRequest(invoice.id, {
        amount: '100',
        allocations: [{ invoiceId: invoice.id, amount: '100' }],
      }),
    );
    await t.prisma.receiptDraft.update({ where: { id: draft.id }, data: { currency: 'usd' } });
    const entries = await t.prisma.journalEntry.count();

    expectGateRefusal(
      await r.post(`/receipt-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 }),
      [],
      ['currency'],
    );
    const card = (
      await r.agentGet(`/receipt-drafts/${draft.id}/assistant`, tokens.finance).expect(200)
    ).body as AssistantDraftDto<ReceiptDraftDto>;
    expectGateRefusal(
      await r.agentPost(`/receipt-drafts/${draft.id}/assistant-approve`, tokens.finance, {
        version: 1,
        contentHash: card.contentHash,
      }),
      [],
      ['currency'],
    );
    await r
      .post(`/receipt-drafts/${draft.id}/approve`, cookies.financeJed, { version: 1 })
      .expect(404);
    await r
      .post(`/receipt-drafts/${draft.id}/approve`, cookies.salesPts, { version: 1 })
      .expect(403);
    await r
      .post(`/receipt-drafts/${draft.id}/approve`, cookies.financePts, { version: 2 })
      .expect(409);
    expect(await t.prisma.journalEntry.count()).toBe(entries);
    expect(await t.prisma.receiptAllocation.count({ where: { invoiceId: invoice.id } })).toBe(0);
    expect(
      await t.prisma.receiptDraft.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({ state: 'DRAFT', version: 1, receiptId: null });

    await t.prisma.receiptDraft.update({ where: { id: draft.id }, data: { currency: 'USD' } });
    const approved = (
      await r
        .post(`/receipt-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
        .expect(200)
    ).body as ReceiptDraftDto;
    expect(approved.status).toBe('APPROVED');
    await r
      .post(`/receipt-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
      .expect(200);
    expect(await t.prisma.receiptAllocation.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

describe('invoice drafts: the assistant proposes', () => {
  it('creates a draft, gets back ids and counts only, and creates no invoice yet', async () => {
    const shipmentId = await shipment();
    const res = await createInvoiceDraft(invoiceRequest(shipmentId)).expect(201);
    const body = res.body as EntryDraftSummaryDto;
    expect(body).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'missingFields', 'status', 'version'].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('Freight Port Sudan');
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(0);
  });

  it('returns the same draft for a repeat, and refuses the key with another request', async () => {
    const shipmentId = await shipment();
    const body = invoiceRequest(shipmentId);
    const first = (await createInvoiceDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const again = {
      ...body,
      shipmentId: shipmentId.toUpperCase(),
      lines: [{ chargeTypeCode: 'freight', quantity: '2.0', unitPrice: '100.5050' }],
    };
    const second = (await createInvoiceDraft(again).expect(201)).body as EntryDraftSummaryDto;
    expect(second.id).toBe(first.id);
    await createInvoiceDraft({ ...body, dueDate: d('04-30') }).expect(409);
    const found = await r
      .agentGet(`/invoice-drafts/by-key/${body.idempotencyKey}`, tokens.finance)
      .expect(200);
    expect((found.body as EntryDraftSummaryDto).id).toBe(first.id);
    await r
      .agentGet(`/invoice-drafts/by-key/${body.idempotencyKey}`, tokens.financeJed)
      .expect(404);
  });

  it('refuses another branch, a missing permission and what NOLON would refuse', async () => {
    const shipmentId = await shipment();
    const before = await t.prisma.invoiceDraft.count();
    await createInvoiceDraft(invoiceRequest(shipmentId), tokens.financeJed).expect(404);
    await createInvoiceDraft(invoiceRequest(shipmentId), tokens.sales).expect(403);
    await createInvoiceDraft(invoiceRequest(shipmentId, { dueDate: d('02-01') })).expect(400);
    await createInvoiceDraft(
      invoiceRequest(shipmentId, {
        lines: [{ chargeTypeCode: 'NO_SUCH_CHARGE', quantity: '1', unitPrice: '1' }],
      }),
    ).expect(400);
    // The assistant gives no fx rate (the table's is used), and no status.
    await createInvoiceDraft(invoiceRequest(shipmentId, { fxRate: '1' })).expect(400);
    await createInvoiceDraft({ ...invoiceRequest(shipmentId), status: 'APPROVED' }).expect(400);
    // A draft may be saved without lines (filled in on review), never with a malformed one.
    await createInvoiceDraft(
      invoiceRequest(shipmentId, { lines: [{ chargeTypeCode: 'FREIGHT', quantity: 'two' }] }),
    ).expect(400);
    expect(await t.prisma.invoiceDraft.count()).toBe(before);
  });

  it('cannot read or decide drafts, nor create or approve invoices itself', async () => {
    const shipmentId = await shipment();
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    await r.agentGet('/invoice-drafts', tokens.finance).expect(403);
    await r.agentGet(`/invoice-drafts/${draft.id}`, tokens.finance).expect(403);
    await r
      .agentPost(`/invoice-drafts/${draft.id}/approve`, tokens.finance, { version: 1 })
      .expect(403);
    await r
      .agentPost(`/invoice-drafts/${draft.id}/reject`, tokens.finance, { version: 1, reason: 'x' })
      .expect(403);
    await r.agentPost('/customer-invoices', tokens.finance, { shipmentId }).expect(403);
    await r.post('/invoice-drafts', cookies.financePts, invoiceRequest(shipmentId)).expect(403);
  });
});

describe('invoice drafts: a person reviews', () => {
  it('shows drafts of their branches only, with the total NOLON computes', async () => {
    const shipmentId = await shipment();
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    // 2 x 100.505 = 201.01 in USD cents.
    expect(draft.check).toEqual({ ok: true, total: '201.01', currency: 'USD' });
    expect(draft).toMatchObject({
      customerId: customer.id,
      actions: { canEdit: true, canDecide: true },
    });
    expect(draft.request.lines[0]).toMatchObject({ quantity: '2', unitPrice: '100.505' });
    const list = (await r.get('/invoice-drafts?status=DRAFT', cookies.financePts).expect(200))
      .body as InvoiceDraftListItemDto[];
    expect(list.map((x) => x.id)).toContain(draft.id);
    const jed = (await r.get('/invoice-drafts', cookies.financeJed).expect(200))
      .body as InvoiceDraftListItemDto[];
    expect(jed.map((x) => x.id)).not.toContain(draft.id);
    await r.get(`/invoice-drafts/${draft.id}`, cookies.financeJed).expect(404);
    // Operations sees invoices but cannot create them.
    const ops = (await r.get(`/invoice-drafts/${draft.id}`, cookies.opsPts).expect(200))
      .body as InvoiceDraftDto;
    expect(ops.actions.canDecide).toBe(false);
    await r.post(`/invoice-drafts/${draft.id}/approve`, cookies.opsPts, { version: 1 }).expect(403);
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.financeJed, { version: 1 })
      .expect(404);
  });

  it('approves into an ordinary DRAFT invoice that posts nothing, once', async () => {
    const shipmentId = await shipment();
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 2 })
      .expect(409);
    const approved = (
      await r
        .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
        .expect(200)
    ).body as InvoiceDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null, invoiceNumber: null });
    const invoice = (
      await r.get(`/customer-invoices/${approved.invoiceId}`, cookies.financePts).expect(200)
    ).body as CustomerInvoiceDto;
    expect(invoice).toMatchObject({
      status: 'DRAFT',
      total: '201.01',
      shipmentId,
      customerId: customer.id,
      journalEntryId: null,
    });
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
      .expect(200);
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(1);
  });

  it('two concurrent approvals create one invoice', async () => {
    const shipmentId = await shipment();
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    const results = await Promise.all([
      r.post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 }),
      r.post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 }),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(1);
  });

  it('rejects with a reason; the database keeps decided drafts as they are', async () => {
    const shipmentId = await shipment();
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    const rejected = (
      await r
        .post(`/invoice-drafts/${draft.id}/reject`, cookies.financePts, {
          version: 1,
          reason: 'Wrong price',
        })
        .expect(200)
    ).body as InvoiceDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Wrong price' });
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 2 })
      .expect(409);
    await expect(
      t.prisma.invoiceDraft.update({ where: { id: draft.id }, data: { notes: 'Changed' } }),
    ).rejects.toThrow(/decided/);
    await expect(
      t.prisma.invoiceDraftLine.updateMany({
        where: { draftId: draft.id },
        data: { unitPrice: '1' },
      }),
    ).rejects.toThrow(/decided/);
    const open = await invoiceDraft(invoiceRequest(shipmentId));
    await expect(
      t.prisma.invoiceDraftLine.updateMany({
        where: { draftId: open.id },
        data: { draftId: draft.id },
      }),
    ).rejects.toThrow(/another draft/);
    await expect(
      t.prisma.invoiceDraft.update({ where: { id: open.id }, data: { state: 'APPROVED' } }),
    ).rejects.toThrow();
  });
});

describe('invoice drafts for a shipment that already has invoices (Q3)', () => {
  it('the review screen lists them and its approval names them; the chat sends it there', async () => {
    await r
      .put(`/users/${agentIds.financeAgent}/assistant-approvals`, cookies.admin, {
        kinds: ['invoice', 'receipt'],
      })
      .expect(200);
    const shipmentId = await shipment();
    const first = (
      await r.post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    expect(draft.shipmentInvoices).toEqual([{ id: first.id, number: null, status: 'DRAFT' }]);
    const suggestion = (
      await r.agentPost('/invoice-drafts/suggest', tokens.finance, { shipmentId }).expect(200)
    ).body as InvoiceSuggestionDto;
    expect(suggestion.shipmentInvoices.map((i) => i.id)).toEqual([first.id]);

    // Without the invoices named, or with others, nothing is written and the draft stays open.
    for (const body of [
      { version: 1 },
      { version: 1, acknowledgedInvoiceIds: [] },
      { version: 1, acknowledgedInvoiceIds: [randomUUID()] },
      { version: 1, acknowledgedInvoiceIds: [first.id, randomUUID()] },
    ]) {
      const res = await r.post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'SHIPMENT_ALREADY_INVOICED',
        params: { approved: '—', drafts: '1' },
      });
    }
    // The assistant's chat cannot list them: the approval is sent to the review screen.
    const card = (
      await r.agentGet(`/invoice-drafts/${draft.id}/assistant`, tokens.finance).expect(200)
    ).body as AssistantDraftDto<InvoiceDraftDto>;
    const chat = await r.agentPost(
      `/invoice-drafts/${draft.id}/assistant-approve`,
      tokens.finance,
      {
        version: 1,
        contentHash: card.contentHash,
      },
    );
    expect(chat.status).toBe(409);
    expect(chat.body).toMatchObject({ code: 'SHIPMENT_ALREADY_INVOICED_REVIEW' });
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(1);
    expect(
      await t.prisma.invoiceDraft.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({ state: 'DRAFT', version: 1, invoiceId: null });

    const approved = (
      await r
        .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, {
          version: 1,
          acknowledgedInvoiceIds: [first.id],
        })
        .expect(200)
    ).body as InvoiceDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', shipmentInvoices: [] });
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(2);
  });

  it('a draft approved after the shipment is cancelled is refused', async () => {
    const shipmentId = await shipment();
    const draft = await invoiceDraft(invoiceRequest(shipmentId));
    await r
      .post(`/shipments/${shipmentId}/cancel`, cookies.opsPts, { reason: 'Withdrawn' })
      .expect(200);
    await r
      .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
      .expect(409);
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(0);
  });
});

describe('receipt drafts', () => {
  it('the assistant proposes a receipt; nothing is posted yet', async () => {
    const invoice = await approvedInvoice('500');
    const body = receiptRequest(invoice.id);
    const res = await createReceiptDraft(body).expect(201);
    const created = res.body as EntryDraftSummaryDto;
    expect(created).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(JSON.stringify(created)).not.toContain('TT 12345');
    expect(await t.prisma.receiptAllocation.count({ where: { invoiceId: invoice.id } })).toBe(0);
    // Repeat in another canonical form; key reuse.
    const again = (
      await createReceiptDraft({
        ...body,
        amount: '200',
        cashAccountId: cashUsd.id.toUpperCase(),
      }).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(again.id).toBe(created.id);
    await createReceiptDraft({ ...body, amount: '250' }).expect(409);
  });

  it('refuses another branch, a missing permission and what NOLON would refuse', async () => {
    const invoice = await approvedInvoice('500');
    const otherInvoice = await approvedInvoice('500', other.id);
    const before = await t.prisma.receiptDraft.count();
    await createReceiptDraft(receiptRequest(invoice.id), tokens.financeJed).expect(404);
    await createReceiptDraft(receiptRequest(invoice.id), tokens.sales).expect(403);
    // An invoice of another customer, a cash account in another currency, more than received.
    await createReceiptDraft(receiptRequest(otherInvoice.id)).expect(400);
    await createReceiptDraft(receiptRequest(invoice.id, { cashAccountId: cashSdg.id })).expect(400);
    await createReceiptDraft(
      receiptRequest(invoice.id, { allocations: [{ invoiceId: invoice.id, amount: '300' }] }),
    ).expect(400);
    // An invoice id that does not exist is refused like another customer's.
    await createReceiptDraft(receiptRequest(randomUUID())).expect(400);
    // The assistant gives no fx rate.
    await createReceiptDraft(receiptRequest(invoice.id, { fxRate: '1' })).expect(400);
    expect(await t.prisma.receiptDraft.count()).toBe(before);
  });

  it('cannot read or decide drafts, nor record receipts itself', async () => {
    const invoice = await approvedInvoice('500');
    const draft = await receiptDraft(receiptRequest(invoice.id));
    await r.agentGet('/receipt-drafts', tokens.finance).expect(403);
    await r.agentGet(`/receipt-drafts/${draft.id}`, tokens.finance).expect(403);
    await r
      .agentPost(`/receipt-drafts/${draft.id}/approve`, tokens.finance, { version: 1 })
      .expect(403);
    const plain: Record<string, unknown> = receiptRequest(invoice.id);
    delete plain.idempotencyKey;
    await r.agentPost('/receipts', tokens.finance, plain).expect(403);
    await r.post('/receipt-drafts', cookies.financePts, receiptRequest(invoice.id)).expect(403);
  });

  it('a person reviews and approves it into a posted receipt that settles the invoice, once', async () => {
    const invoice = await approvedInvoice('500');
    const draft = await receiptDraft(receiptRequest(invoice.id));
    expect(draft).toMatchObject({
      customerId: customer.id,
      cashAccountCode: cashUsd.code,
      invoiceNumbers: [invoice.number],
      check: { ok: true, total: '200', currency: 'USD' },
      actions: { canEdit: true, canDecide: true },
    });
    const list = (await r.get('/receipt-drafts?status=DRAFT', cookies.financePts).expect(200))
      .body as ReceiptDraftListItemDto[];
    expect(list.find((x) => x.id === draft.id)).toMatchObject({ amount: '200', currency: 'USD' });
    await r.get(`/receipt-drafts/${draft.id}`, cookies.financeJed).expect(404);
    // Operations does not see receipts at all; Sales sees them but cannot record them.
    await r.get(`/receipt-drafts/${draft.id}`, cookies.opsPts).expect(403);
    const sales = (await r.get(`/receipt-drafts/${draft.id}`, cookies.salesPts).expect(200))
      .body as ReceiptDraftDto;
    expect(sales.actions.canDecide).toBe(false);
    await r
      .post(`/receipt-drafts/${draft.id}/approve`, cookies.salesPts, { version: 1 })
      .expect(403);

    const approved = (
      await r
        .post(`/receipt-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
        .expect(200)
    ).body as ReceiptDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null });
    expect(approved.receiptNumber).toMatch(/RC/);
    const receipt = await t.prisma.receipt.findUniqueOrThrow({
      where: { id: approved.receiptId! },
    });
    expect(receipt.status).toBe('POSTED');
    expect(receipt.journalEntryId).toBeTruthy();
    const settled = await t.prisma.customerInvoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(settled.paidAmount.toString()).toBe('200');
    await r
      .post(`/receipt-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
      .expect(200);
    expect(await t.prisma.receiptAllocation.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it('refuses settling more than the invoice owes, under the lock, and leaves the draft open', async () => {
    const invoice = await approvedInvoice('500');
    const allocations = [{ invoiceId: invoice.id, amount: '400' }];
    const first = await receiptDraft(receiptRequest(invoice.id, { amount: '400', allocations }));
    const second = await receiptDraft(receiptRequest(invoice.id, { amount: '400', allocations }));
    const results = await Promise.all([
      r.post(`/receipt-drafts/${first.id}/approve`, cookies.financePts, { version: 1 }),
      r.post(`/receipt-drafts/${second.id}/approve`, cookies.financePts, { version: 1 }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
    expect(await t.prisma.receiptAllocation.count({ where: { invoiceId: invoice.id } })).toBe(1);
    const states = await t.prisma.receiptDraft.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { state: true },
    });
    expect(states.map((s) => s.state).sort()).toEqual(['APPROVED', 'DRAFT']);
  });

  it('rejects with a reason; the database keeps decided drafts as they are', async () => {
    const invoice = await approvedInvoice('500');
    const draft = await receiptDraft(receiptRequest(invoice.id));
    await r
      .post(`/receipt-drafts/${draft.id}/reject`, cookies.financePts, { version: 1 })
      .expect(400);
    const rejected = (
      await r
        .post(`/receipt-drafts/${draft.id}/reject`, cookies.financePts, {
          version: 1,
          reason: 'Not received yet',
        })
        .expect(200)
    ).body as ReceiptDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Not received yet' });
    await expect(
      t.prisma.receiptDraft.update({ where: { id: draft.id }, data: { amount: '1' } }),
    ).rejects.toThrow(/decided/);
    await expect(
      t.prisma.receiptDraftAllocation.deleteMany({ where: { draftId: draft.id } }),
    ).rejects.toThrow(/decided/);
  });
});

describe('receipt drafts on the live card: pick lists and field refusals', () => {
  const pick = (path: string, query: string, token = tokens.finance) =>
    r.agentGet(`/receipt-drafts/${path}?${query}`, token);
  const cashAccounts = async (query: string) =>
    ((await pick('cash-accounts', query).expect(200)).body as { items: ReceiptCashAccountDto[] })
      .items;
  const openInvoices = async (query: string) =>
    ((await pick('open-invoices', query).expect(200)).body as { items: ReceiptOpenInvoiceDto[] })
      .items;

  async function refusals(body: object) {
    const result = (await r.agentPost('/receipt-drafts/check', tokens.finance, body).expect(200))
      .body as DraftPreCheckDto;
    if (result.ok) throw new Error('expected a refusal');
    return result.refusals;
  }

  it("lists the cash accounts of the customer's branch, and its open invoices oldest due first", async () => {
    const accounts = await cashAccounts(`customerId=${customer.id}`);
    expect(accounts.map((a) => a.id)).toEqual(expect.arrayContaining([cashUsd.id, cashSdg.id]));
    expect(accounts.find((a) => a.id === cashUsd.id)).toMatchObject({
      code: cashUsd.code,
      currency: 'USD',
      isActive: true,
    });

    const invoice = await approvedInvoice('500');
    const otherInvoice = await approvedInvoice('500', other.id);
    const usd = await openInvoices(`customerId=${customer.id}&currency=USD`);
    expect(usd.find((i) => i.id === invoice.id)).toMatchObject({
      number: invoice.number,
      currency: 'USD',
      total: '500',
      outstanding: '500',
      dueDate: invoice.dueDate,
    });
    expect(usd.map((i) => i.id)).not.toContain(otherInvoice.id);
    expect(usd.length).toBeLessThanOrEqual(40);
    const due = usd.map((i) => i.dueDate);
    expect(due).toEqual([...due].sort());
    expect(await openInvoices(`customerId=${customer.id}&currency=SDG`)).toEqual([]);

    // A part payment lowers what is outstanding; settling the rest takes it off the list.
    const pay = async (amount: string) => {
      const draft = await receiptDraft(
        receiptRequest(invoice.id, { amount, allocations: [{ invoiceId: invoice.id, amount }] }),
      );
      await r
        .post(`/receipt-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
        .expect(200);
    };
    await pay('120.5');
    const partly = await openInvoices(`customerId=${customer.id}`);
    expect(partly.find((i) => i.id === invoice.id)?.outstanding).toBe('379.5');
    await pay('379.5');
    expect((await openInvoices(`customerId=${customer.id}`)).map((i) => i.id)).not.toContain(
      invoice.id,
    );
  });

  it('is refused for a customer of another branch, without the create permission, or malformed', async () => {
    for (const path of ['cash-accounts', 'open-invoices']) {
      await pick(path, `customerId=${customer.id}`, tokens.financeJed).expect(404);
      await pick(path, `customerId=${customer.id}`, tokens.sales).expect(403);
      await pick(path, 'customerId=nope').expect(400);
      await pick(path, `customerId=${customer.id}&branchId=${pts}`).expect(400);
    }
    await pick('open-invoices', `customerId=${customer.id}&currency=usd`).expect(400);
    // A currency (the review screen's filter, functional review هـ6) must be a code too.
    await pick('cash-accounts', `customerId=${customer.id}&currency=usd`).expect(400);
  });

  it('refuses a bad cash account or allocation at its field, with a code', async () => {
    const invoice = await approvedInvoice('500');
    const otherInvoice = await approvedInvoice('500', other.id);
    expect(await refusals(receiptRequest(invoice.id, { cashAccountId: cashSdg.id }))).toMatchObject(
      [{ field: 'cashAccountId', code: 'CASH_ACCOUNT_NOT_USABLE' }],
    );
    expect(
      await refusals(receiptRequest(invoice.id, { cashAccountId: randomUUID() })),
    ).toMatchObject([{ field: 'cashAccountId', code: 'CASH_ACCOUNT_NOT_USABLE' }]);
    expect(await refusals(receiptRequest(otherInvoice.id))).toMatchObject([
      { field: 'allocations.0.invoiceId', code: 'ALLOCATION_OTHER_CUSTOMER' },
    ]);
    const unapproved = (
      await r
        .post('/customer-invoices', cookies.financePts, { shipmentId: await shipment() })
        .expect(201)
    ).body as CustomerInvoiceDto;
    expect(await refusals(receiptRequest(unapproved.id))).toMatchObject([
      { field: 'allocations.0.invoiceId', code: 'ALLOCATION_NOT_APPROVED' },
    ]);
    const second = await approvedInvoice('300');
    expect(
      await refusals(
        receiptRequest(invoice.id, {
          amount: '900',
          allocations: [
            { invoiceId: invoice.id, amount: '500' },
            { invoiceId: second.id, amount: '300.01' },
          ],
        }),
      ),
    ).toMatchObject([
      {
        field: 'allocations.1.amount',
        code: 'ALLOCATION_EXCEEDS_BALANCE',
        params: { invoice: second.number, balance: '300', currency: 'USD' },
      },
    ]);
    // The create refuses the same values, and writes nothing.
    const before = await t.prisma.receiptDraft.count();
    await createReceiptDraft(
      receiptRequest(second.id, { allocations: [{ invoiceId: second.id, amount: '300.01' }] }),
    ).expect(400);
    expect(await t.prisma.receiptDraft.count()).toBe(before);
  });
});

// Drafts saved with missing values (no-required-fields plan, 3.2 and 3.3): an invoice or receipt
// draft may name only its branch (security context); a person fills in the rest (PATCH), and
// approving is refused (422) on both paths while anything is missing, writing no invoice and
// posting no entry.
describe('invoice drafts saved with missing values', () => {
  const read = async (id: string, cookie = cookies.financePts) =>
    (await r.get(`/invoice-drafts/${id}`, cookie).expect(200)).body as InvoiceDraftDto;

  it('saves a draft naming only its branch, and reads it back with nulls', async () => {
    const empty = (
      await createInvoiceDraft({ idempotencyKey: draftKey(), branchId: pts }).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(empty.missingFields).toEqual([
      'shipmentId',
      'customerId',
      'currency',
      'invoiceDate',
      'dueDate',
      'lines',
    ]);
    expect(await read(empty.id)).toMatchObject({
      check: null,
      actions: { canEdit: true, canDecide: true },
      request: { shipmentId: null, currency: null, invoiceDate: null, dueDate: null, lines: [] },
    });
    const list = (await r.get('/invoice-drafts?status=DRAFT', cookies.financePts).expect(200))
      .body as InvoiceDraftListItemDto[];
    expect(list.map((d) => d.id)).toContain(empty.id);
    await r.get(`/invoice-drafts/${empty.id}`, cookies.financeJed).expect(404);
  });

  it('refuses a draft without a branch, of another branch, or with a malformed value', async () => {
    const jed = await branchId(t.prisma, 'JED');
    const shipmentId = await shipment();
    const before = await t.prisma.invoiceDraft.count();
    const refused = async (body: object, status: number) =>
      (await createInvoiceDraft({ idempotencyKey: draftKey(), ...body }).expect(status)).body as {
        code?: string;
      };
    expect((await refused({ notes: 'No branch' }, 400)).code).toBe('BRANCH_REQUIRED');
    await refused({ branchId: jed }, 403);
    expect((await refused({ shipmentId, branchId: jed }, 400)).code).toBe('BRANCH_MISMATCH');
    await refused({ branchId: pts, invoiceDate: 'soon' }, 400);
    expect(await t.prisma.invoiceDraft.count()).toBe(before);
  });

  it('refuses the approval on both paths while values are missing, then approves once filled in', async () => {
    await r
      .put(`/users/${agentIds.financeAgent}/assistant-approvals`, cookies.admin, {
        kinds: ['invoice', 'receipt'],
      })
      .expect(200);
    const shipmentId = await shipment();
    const { id } = (
      await createInvoiceDraft({ idempotencyKey: draftKey(), shipmentId }).expect(201)
    ).body as EntryDraftSummaryDto;
    const missing = ['currency', 'invoiceDate', 'dueDate', 'lines'];
    expectGateRefusal(
      await r.post(`/invoice-drafts/${id}/approve`, cookies.financePts, { version: 1 }),
      missing,
    );
    const card = (await r.agentGet(`/invoice-drafts/${id}/assistant`, tokens.finance).expect(200))
      .body as AssistantDraftDto<InvoiceDraftDto>;
    expect(card.draft.missingFields).toEqual(missing);
    expectGateRefusal(
      await r.agentPost(`/invoice-drafts/${id}/assistant-approve`, tokens.finance, {
        version: 1,
        contentHash: card.contentHash,
      }),
      missing,
    );
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(0);

    const edit = (cookie: string, body: object) => r.patch(`/invoice-drafts/${id}`, cookie, body);
    await edit(cookies.financeJed, { version: 1, currency: 'USD' }).expect(404);
    await edit(cookies.salesPts, { version: 1, currency: 'USD' }).expect(403);
    await r
      .agentPatch(`/invoice-drafts/${id}`, tokens.finance, { version: 1, currency: 'USD' })
      .expect(403);
    await edit(cookies.financePts, { version: 2, currency: 'USD' }).expect(409);
    await edit(cookies.financePts, { version: 1, dueDate: 'later' }).expect(400);
    const filled = (
      await edit(cookies.financePts, {
        version: 1,
        currency: 'USD',
        invoiceDate: d('05-01'),
        dueDate: d('05-31'),
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '250' }],
      }).expect(200)
    ).body as InvoiceDraftDto;
    expect(filled).toMatchObject({ version: 2, missingFields: [], check: { ok: true } });
    const approved = (
      await r.post(`/invoice-drafts/${id}/approve`, cookies.financePts, { version: 2 }).expect(200)
    ).body as InvoiceDraftDto;
    expect(approved.status).toBe('APPROVED');
    const again = (
      await r.post(`/invoice-drafts/${id}/approve`, cookies.financePts, { version: 2 }).expect(200)
    ).body as InvoiceDraftDto;
    expect(again.invoiceId).toBe(approved.invoiceId);
    expect(await t.prisma.customerInvoice.count({ where: { shipmentId } })).toBe(1);
  });
});

describe('receipt drafts saved with missing values', () => {
  const MISSING = ['customerId', 'receiptDate', 'currency', 'amount', 'cashAccountId'];
  const read = async (id: string, cookie = cookies.financePts) =>
    (await r.get(`/receipt-drafts/${id}`, cookie).expect(200)).body as ReceiptDraftDto;

  it('saves a draft naming only its branch, and reads it back with nulls', async () => {
    const empty = (
      await createReceiptDraft({ idempotencyKey: draftKey(), branchId: pts }).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(empty.missingFields).toEqual(MISSING);
    expect(await read(empty.id)).toMatchObject({
      check: null,
      actions: { canEdit: true, canDecide: true },
      request: { customerId: null, amount: null, cashAccountId: null, allocations: [] },
    });
    const list = (await r.get('/receipt-drafts?status=DRAFT', cookies.financePts).expect(200))
      .body as ReceiptDraftListItemDto[];
    expect(list.map((d) => d.id)).toContain(empty.id);
    await r.get(`/receipt-drafts/${empty.id}`, cookies.financeJed).expect(404);

    const partial = (
      await createReceiptDraft({
        idempotencyKey: draftKey(),
        customerId: customer.id,
        amount: '50',
      }).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(partial.missingFields).toEqual(['receiptDate', 'currency', 'cashAccountId']);
  });

  it('refuses a draft without a branch, of another branch, or with a malformed value', async () => {
    const jed = await branchId(t.prisma, 'JED');
    const before = await t.prisma.receiptDraft.count();
    const refused = async (body: object, status: number) =>
      (await createReceiptDraft({ idempotencyKey: draftKey(), ...body }).expect(status)).body as {
        code?: string;
      };
    expect((await refused({ notes: 'No branch' }, 400)).code).toBe('BRANCH_REQUIRED');
    await refused({ branchId: jed }, 403);
    expect((await refused({ customerId: customer.id, branchId: jed }, 400)).code).toBe(
      'BRANCH_MISMATCH',
    );
    await refused({ branchId: pts, amount: 'lots' }, 400);
    expect(await t.prisma.receiptDraft.count()).toBe(before);
  });

  it('refuses the approval on both paths while values are missing, then approves once filled in', async () => {
    await r
      .put(`/users/${agentIds.financeAgent}/assistant-approvals`, cookies.admin, {
        kinds: ['invoice', 'receipt'],
      })
      .expect(200);
    const invoice = await approvedInvoice('300');
    const { id } = (
      await createReceiptDraft({ idempotencyKey: draftKey(), customerId: customer.id }).expect(201)
    ).body as EntryDraftSummaryDto;
    const missing = MISSING.slice(1);
    const entries = await t.prisma.journalEntry.count();
    expectGateRefusal(
      await r.post(`/receipt-drafts/${id}/approve`, cookies.financePts, { version: 1 }),
      missing,
    );
    const card = (await r.agentGet(`/receipt-drafts/${id}/assistant`, tokens.finance).expect(200))
      .body as AssistantDraftDto<ReceiptDraftDto>;
    expectGateRefusal(
      await r.agentPost(`/receipt-drafts/${id}/assistant-approve`, tokens.finance, {
        version: 1,
        contentHash: card.contentHash,
      }),
      missing,
    );
    expect(await t.prisma.journalEntry.count()).toBe(entries);

    const edit = (cookie: string, body: object) => r.patch(`/receipt-drafts/${id}`, cookie, body);
    await edit(cookies.financeJed, { version: 1, amount: '100' }).expect(404);
    await edit(cookies.opsPts, { version: 1, amount: '100' }).expect(403);
    await r
      .agentPatch(`/receipt-drafts/${id}`, tokens.finance, { version: 1, amount: '100' })
      .expect(403);
    await edit(cookies.financePts, { version: 2, amount: '100' }).expect(409);
    await edit(cookies.financePts, { version: 1, amount: 'lots' }).expect(400);
    const filled = (
      await edit(cookies.financePts, {
        version: 1,
        receiptDate: d('04-02'),
        currency: 'USD',
        amount: '100',
        cashAccountId: cashUsd.id,
        allocations: [{ invoiceId: invoice.id, amount: '100' }],
      }).expect(200)
    ).body as ReceiptDraftDto;
    expect(filled).toMatchObject({ version: 2, missingFields: [], check: { ok: true } });
    const approved = (
      await r.post(`/receipt-drafts/${id}/approve`, cookies.financePts, { version: 2 }).expect(200)
    ).body as ReceiptDraftDto;
    expect(approved.status).toBe('APPROVED');
    await r.post(`/receipt-drafts/${id}/approve`, cookies.financePts, { version: 2 }).expect(200);
    expect(await t.prisma.receiptAllocation.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

// Functional review هـ4: the review screen offers NOLON's suggestion (suggestForShipment) for the
// currency and dates an invoice draft misses; the person applies it with the PATCH, and the
// assistant's request under its key never changes.
describe('invoice drafts: suggested values on the review screen', () => {
  const suggested = async (id: string, cookie = cookies.financePts) =>
    (await r.get(`/invoice-drafts/${id}/suggested-values`, cookie).expect(200))
      .body as InvoiceDraftSuggestedValuesDto;
  const row = (id: string) => t.prisma.invoiceDraft.findUniqueOrThrow({ where: { id } });

  it('suggests the missing currency and dates without saving them; the PATCH applies them', async () => {
    const shipmentId = await shipment();
    const body = { idempotencyKey: draftKey(), shipmentId };
    const { id } = (await createInvoiceDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const stored = await row(id);
    const derived = (
      await r.agentPost('/invoice-drafts/suggest', tokens.finance, { shipmentId }).expect(200)
    ).body as InvoiceSuggestionDto;
    const offer = await suggested(id);
    expect(offer).toEqual({
      version: 1,
      values: { currency: 'USD', invoiceDate: derived.invoiceDate, dueDate: derived.dueDate },
      currencySource: derived.currencySource,
    });
    // Nothing saved by the read.
    expect(await row(id)).toMatchObject({ version: 1, currency: null, invoiceDate: null });
    const card = (await r.agentGet(`/invoice-drafts/${id}/assistant`, tokens.finance).expect(200))
      .body as AssistantDraftDto<InvoiceDraftDto>;

    // The person applies them as shown, at the version shown.
    const values = offer.values ?? { currency: null, invoiceDate: null, dueDate: null };
    const saved = (
      await r
        .patch(`/invoice-drafts/${id}`, cookies.financePts, { version: 1, ...values })
        .expect(200)
    ).body as InvoiceDraftDto;
    expect(saved).toMatchObject({ version: 2, request: values });
    expect(saved.missingFields).toEqual(['lines']);
    // The card the assistant showed is stale now: its content hash moved on.
    const fresh = (await r.agentGet(`/invoice-drafts/${id}/assistant`, tokens.finance).expect(200))
      .body as AssistantDraftDto<InvoiceDraftDto>;
    expect(fresh.contentHash).not.toBe(card.contentHash);
    expect(fresh.draft.version).toBe(2);
    // Nothing is left to suggest; an old version is refused by the PATCH as before.
    expect(await suggested(id)).toEqual({ version: 2, values: null, currencySource: null });
    await r
      .patch(`/invoice-drafts/${id}`, cookies.financePts, { version: 1, ...values })
      .expect(409);

    // The assistant's retry under the same key answers with the same draft, its request unchanged.
    const replay = (await createInvoiceDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(replay).toMatchObject({ id, version: 2 });
    const after = await row(id);
    expect(after.payloadHash).toBe(stored.payloadHash);
    expect(after.idempotencyKey).toBe(stored.idempotencyKey);
    expect(
      await t.prisma.invoiceDraft.count({ where: { idempotencyKey: body.idempotencyKey } }),
    ).toBe(1);
  });

  it('suggests only what is missing: a due date after the invoice date the draft holds', async () => {
    const shipmentId = await shipment();
    const { id } = (
      await createInvoiceDraft({
        idempotencyKey: draftKey(),
        shipmentId,
        currency: 'SDG',
        invoiceDate: d('06-01'),
      }).expect(201)
    ).body as EntryDraftSummaryDto;
    const derived = (
      await r
        .agentPost('/invoice-drafts/suggest', tokens.finance, {
          shipmentId,
          currency: 'SDG',
          invoiceDate: d('06-01'),
        })
        .expect(200)
    ).body as InvoiceSuggestionDto;
    expect(await suggested(id)).toEqual({
      version: 1,
      values: { currency: null, invoiceDate: null, dueDate: derived.dueDate },
      currencySource: null,
    });
  });

  it('suggests nothing without a shipment, and only to a person who may edit the draft', async () => {
    const { id } = (
      await createInvoiceDraft({ idempotencyKey: draftKey(), branchId: pts }).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(await suggested(id)).toEqual({ version: 1, values: null, currencySource: null });
    await r.agentGet(`/invoice-drafts/${id}/suggested-values`, tokens.finance).expect(403);
    await r.get(`/invoice-drafts/${id}/suggested-values`, cookies.salesPts).expect(403);
    await r.get(`/invoice-drafts/${id}/suggested-values`, cookies.financeJed).expect(404);
  });
});

// Functional review هـ6: the review screen asks for the cash accounts in the receipt's currency.
describe('receipt drafts: cash accounts in a currency', () => {
  it('filters by the currency given; without it, as before', async () => {
    const list = async (query: string, cookie = cookies.financePts) =>
      (
        (await r.get(`/receipt-drafts/cash-accounts?${query}`, cookie).expect(200)).body as {
          items: ReceiptCashAccountDto[];
        }
      ).items.map((a) => a.id);
    const all = await list(`customerId=${customer.id}`);
    expect(all).toEqual(expect.arrayContaining([cashUsd.id, cashSdg.id]));
    const usd = await list(`customerId=${customer.id}&currency=USD`);
    expect(usd).toContain(cashUsd.id);
    expect(usd).not.toContain(cashSdg.id);
    await r
      .get(
        `/receipt-drafts/cash-accounts?customerId=${customer.id}&currency=usd`,
        cookies.financePts,
      )
      .expect(400);
  });
});
