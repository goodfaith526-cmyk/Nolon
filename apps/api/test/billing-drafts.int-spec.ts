import { randomInt, randomUUID } from 'node:crypto';
import type {
  AccountDto,
  AgentClientCreatedDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  EntryDraftSummaryDto,
  InvoiceDraftDto,
  InvoiceDraftListItemDto,
  ReceiptDraftDto,
  ReceiptDraftListItemDto,
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

describe('invoice drafts: the assistant proposes', () => {
  it('creates a draft, gets back ids and counts only, and creates no invoice yet', async () => {
    const shipmentId = await shipment();
    const res = await createInvoiceDraft(invoiceRequest(shipmentId)).expect(201);
    const body = res.body as EntryDraftSummaryDto;
    expect(body).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'status', 'version'].sort(),
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
    await createInvoiceDraft(invoiceRequest(shipmentId, { lines: [] })).expect(400);
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
      actions: { canEdit: false, canDecide: true },
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
      actions: { canEdit: false, canDecide: true },
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
