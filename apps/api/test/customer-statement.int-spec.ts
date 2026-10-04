import type {
  AccountDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  CustomerStatementDto,
  ReceiptDto,
} from '@nolon/shared';
import { randomInt, randomUUID } from 'node:crypto';
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

/**
 * Customer statement of account (annex D printout 12) against PostgreSQL. Posted entries are never
 * deleted, so the users are LEDGER users, the customer and cash accounts are this run's own and
 * everything is dated in a random year of this suite's range (600-999; the other ledger suites
 * use 1000-2000). Only the receipt's cancellation is dated today (the API dates it so).
 */
describe('customer statement', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let customer: CustomerDto;
  let other: CustomerDto;
  let cashUsd: AccountDto;
  let cashSdg: AccountDto;
  const inv: Record<'i1' | 'i2' | 'i3', CustomerInvoiceDto> = {} as Record<
    'i1' | 'i2' | 'i3',
    CustomerInvoiceDto
  >;
  const rc: Record<'r1' | 'r2' | 'r3' | 'r4', ReceiptDto> = {} as Record<
    'r1' | 'r2' | 'r3' | 'r4',
    ReceiptDto
  >;
  const year = String(randomInt(600, 1000)).padStart(4, '0');
  const d = (monthDay: string) => `${year}-${monthDay}`;
  /** Far enough ahead to include today's cancellation in any branch time zone. */
  const later = `${new Date().getUTCFullYear() + 1}-12-31`;
  const cookies = { admin: '', financePts: '', financeJed: '', salesPts: '', opsPts: '' };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  async function statement(
    query: string,
    cookie = cookies.financePts,
    id = customer.id,
  ): Promise<CustomerStatementDto> {
    return (await get(`/customer-statements/${id}?${query}`, cookie).expect(200))
      .body as CustomerStatementDto;
  }

  async function shipment(): Promise<string> {
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: await loc('SDPZU'),
        destinationLocationId: await loc('SDKRT'),
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm: '1', weightKg: '100' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  async function invoice(
    fields: { currency: string; fxRate?: string; invoiceDate: string },
    unitPrice: string,
    approve = true,
  ): Promise<CustomerInvoiceDto> {
    const draft = (
      await post('/customer-invoices', cookies.financePts, { shipmentId: await shipment() }).expect(
        201,
      )
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      ...fields,
      dueDate: fields.invoiceDate,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice }],
    }).expect(200);
    if (!approve) return draft;
    return (await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as CustomerInvoiceDto;
  }

  async function receipt(body: object): Promise<ReceiptDto> {
    return (
      await post('/receipts', cookies.financePts, { customerId: customer.id, ...body }).expect(201)
    ).body as ReceiptDto;
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    const newCustomer = async (name: string) =>
      (
        await post('/customers', cookies.salesPts, {
          branchId: pts,
          kind: 'COMPANY',
          name: `${name} ${year} ${randomUUID().slice(0, 6)}`,
          phone: '+249912000777',
          preferredCurrency: 'USD',
        }).expect(201)
      ).body as CustomerDto;
    customer = await newCustomer('Statement');
    other = await newCustomer('Statement Other');
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const cash = async (code: string, currency: string) =>
      (
        await post('/accounting/accounts', cookies.admin, {
          code,
          nameEn: `Statement test cash ${currency}`,
          nameAr: 'نقدية اختبار كشف الحساب',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency,
          branchId: pts,
        }).expect(201)
      ).body as AccountDto;
    cashUsd = await cash(`S${suffix}U`, 'USD');
    cashSdg = await cash(`S${suffix}S`, 'SDG');

    // Invoices: 1000 USD (10 Jan), 300 USD (1 Feb), 600,000 SDG at 600 (10 Feb); a draft of
    // 5,555 USD posts nothing.
    inv.i1 = await invoice({ currency: 'USD', invoiceDate: d('01-10') }, '1000');
    inv.i2 = await invoice({ currency: 'USD', invoiceDate: d('02-01') }, '300');
    inv.i3 = await invoice({ currency: 'SDG', fxRate: '600', invoiceDate: d('02-10') }, '600000');
    await invoice({ currency: 'USD', invoiceDate: d('02-11') }, '5555', false);

    // Receipts: 400 USD on I1; 300,000 SDG at 500 on I3 (clears 500 USD at the invoice's rate;
    // the gain is not the customer's balance); 100 USD on I2, cancelled today (a reversing
    // entry); 50 USD unallocated (an advance).
    rc.r1 = await receipt({
      receiptDate: d('02-15'),
      currency: 'USD',
      amount: '400',
      cashAccountId: cashUsd.id,
      allocations: [{ invoiceId: inv.i1.id, amount: '400' }],
    });
    rc.r2 = await receipt({
      receiptDate: d('03-05'),
      currency: 'SDG',
      fxRate: '500',
      amount: '300000',
      cashAccountId: cashSdg.id,
      allocations: [{ invoiceId: inv.i3.id, amount: '300000' }],
    });
    rc.r3 = await receipt({
      receiptDate: d('03-20'),
      currency: 'USD',
      amount: '100',
      cashAccountId: cashUsd.id,
      allocations: [{ invoiceId: inv.i2.id, amount: '100' }],
    });
    rc.r4 = await receipt({
      receiptDate: d('03-25'),
      currency: 'USD',
      amount: '50',
      cashAccountId: cashUsd.id,
      allocations: [],
    });
    rc.r3 = (
      await post(`/receipts/${rc.r3.id}/cancel`, cookies.financePts, { reason: 'Bounced' }).expect(
        200,
      )
    ).body as ReceiptDto;
  });

  afterAll(async () => {
    await t.close();
  });

  it('gives the opening balance, every posted line with a running balance, per currency', async () => {
    const s = await statement(`from=${d('02-01')}&to=${later}`);
    expect(s).toMatchObject({
      customerId: customer.id,
      customerNumber: customer.number,
      customerName: customer.name,
      customerBranchId: pts,
      branchId: null,
      from: d('02-01'),
      to: later,
    });
    expect(s.sections.map((x) => x.currency)).toEqual(['SDG', 'USD']);
    const [sdg, usd] = s.sections;

    expect(sdg).toMatchObject({
      openingBalance: '0',
      totalDebit: '600000',
      totalCredit: '300000',
      closingBalance: '300000',
      closingBalanceUsd: '500',
    });
    expect(
      sdg?.lines.map((l) => [l.date, l.kind, l.documentNumber, l.debit, l.credit, l.balance]),
    ).toEqual([
      [d('02-10'), 'INVOICE', inv.i3.number, '600000', '0', '600000'],
      [d('03-05'), 'RECEIPT', rc.r2.number, '0', '300000', '300000'],
    ]);

    // Opening: I1 (1000). Then I2, R1, R3, the advance R4 and, today, R3's cancellation.
    expect(usd).toMatchObject({
      openingBalance: '1000',
      totalDebit: '400',
      totalCredit: '550',
      closingBalance: '850',
      closingBalanceUsd: '850',
    });
    const lines = usd?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.documentId, l.debit, l.credit, l.balance])).toEqual([
      ['INVOICE', inv.i2.id, '300', '0', '1300'],
      ['RECEIPT', rc.r1.id, '0', '400', '900'],
      ['RECEIPT', rc.r3.id, '0', '100', '800'],
      ['RECEIPT', rc.r4.id, '0', '50', '750'],
      ['RECEIPT_CANCELLATION', rc.r3.id, '100', '0', '850'],
    ]);
    expect(lines[0]?.entryNumber).toBe(inv.i2.journalEntryNumber);
    expect(lines[4]?.entryNumber).toBe(rc.r3.cancelJournalEntryNumber);
    expect(lines[4]?.documentNumber).toBe(rc.r3.number);
  });

  it('is as of its end date: a later cancellation does not show yet', async () => {
    const s = await statement(`from=${d('01-01')}&to=${d('12-31')}`);
    const usd = s.sections.find((x) => x.currency === 'USD');
    expect(usd?.openingBalance).toBe('0');
    expect(usd?.lines.map((l) => [l.kind, l.balance])).toEqual([
      ['INVOICE', '1000'],
      ['INVOICE', '1300'],
      ['RECEIPT', '900'],
      ['RECEIPT', '800'],
      ['RECEIPT', '750'],
    ]);
    expect(usd?.closingBalance).toBe('750');
  });

  it('carries everything before the period into the opening balance', async () => {
    const s = await statement(`from=${d('04-01')}&to=${d('12-31')}`);
    expect(
      s.sections.map((x) => [x.currency, x.openingBalance, x.lines.length, x.closingBalance]),
    ).toEqual([
      ['SDG', '300000', 0, '300000'],
      ['USD', '750', 0, '750'],
    ]);
  });

  it('is empty for a customer with no posted lines', async () => {
    const s = await statement(`from=${d('01-01')}&to=${later}`, cookies.financePts, other.id);
    expect(s.sections).toEqual([]);
  });

  it('covers only the branch asked for', async () => {
    const all = await statement(`from=${d('01-01')}&to=${later}&branchId=${pts}`, cookies.admin);
    expect(all.sections.map((x) => x.closingBalance)).toEqual(['300000', '850']);
    // The customer is PTS's: its lines are not JED's.
    const jedOnly = await statement(
      `from=${d('01-01')}&to=${later}&branchId=${jed}`,
      cookies.admin,
    );
    expect(jedOnly.sections).toEqual([]);
  });

  it('lets Sales read it (invoices and receipts are theirs to view)', async () => {
    const s = await statement(`from=${d('01-01')}&to=${later}`, cookies.salesPts);
    expect(s.sections).toHaveLength(2);
  });

  it('hides another branch’s customer (404) and refuses another branch (403)', async () => {
    const query = `from=${d('01-01')}&to=${later}`;
    await get(`/customer-statements/${customer.id}?${query}`, cookies.financeJed).expect(404);
    await get(
      `/customer-statements/${customer.id}?${query}&branchId=${jed}`,
      cookies.financePts,
    ).expect(403);
    await get(`/customer-statements/${randomUUID()}?${query}`, cookies.financePts).expect(404);
  });

  it('needs both invoice and receipt view permissions (403 without)', async () => {
    await get(
      `/customer-statements/${customer.id}?from=${d('01-01')}&to=${later}`,
      cookies.opsPts,
    ).expect(403);
  });

  it('rejects a bad period and unknown fields (400), and needs a session (401)', async () => {
    await get(
      `/customer-statements/${customer.id}?from=${d('03-01')}&to=${d('02-01')}`,
      cookies.financePts,
    ).expect(400);
    await get(`/customer-statements/${customer.id}?from=${d('03-01')}`, cookies.financePts).expect(
      400,
    );
    await get(
      `/customer-statements/${customer.id}?from=${d('01-01')}&to=${later}&customerId=${other.id}`,
      cookies.financePts,
    ).expect(400);
    await t
      .http()
      .get(`/api/v1/customer-statements/${customer.id}?from=${d('01-01')}&to=${later}`)
      .expect(401);
  });
});
