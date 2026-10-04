import type {
  AccountDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  FiscalPeriodDto,
  FxRateLookupDto,
  JournalEntryDto,
  Page,
  ReceiptDto,
  TrialBalanceDto,
} from '@nolon/shared';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import { waitForLockWaiter } from './test-data.js';

/**
 * Accounting: invoices, receipts, manual journals, periods and the database guards on posted
 * entries. Everything is dated in a random past year so periods and balances of this run do not
 * meet those of earlier runs (posted entries are never deleted, so they stay in the database).
 */
describe('accounting: journals, invoices, receipts, periods', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let customer: CustomerDto;
  let cashSdg: AccountDto;
  let cashUsd: AccountDto;
  let accounts: Map<string, AccountDto>;
  const year = randomInt(1901, 2000);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const cookies = {
    admin: '',
    financePts: '',
    financeJed: '',
    salesPts: '',
    managerPts: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const del = (path: string, cookie: string) =>
    t.http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);

  const account = (code: string): AccountDto => {
    const found = accounts.get(code);
    if (!found) throw new Error(`No account ${code}`);
    return found;
  };

  async function shipmentId(): Promise<string> {
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
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '1000' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  /** An SDG invoice of 1,000,000.50 at 600 (1,666.67 USD) for a new shipment, approved. */
  async function approvedInvoice(invoiceDate = d('03-10')): Promise<CustomerInvoiceDto> {
    const draft = (
      await post('/customer-invoices', cookies.financePts, {
        shipmentId: await shipmentId(),
      }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      currency: 'SDG',
      fxRate: '600',
      invoiceDate,
      dueDate: invoiceDate,
      lines: [
        { chargeTypeCode: 'FREIGHT', quantity: '2', unitPrice: '300000' },
        { chargeTypeCode: 'CUSTOMS', quantity: '1', unitPrice: '300000' },
        { chargeTypeCode: 'DUTIES', quantity: '1', unitPrice: '100000.50' },
      ],
    }).expect(200);
    return (await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as CustomerInvoiceDto;
  }

  const journal = async (id: string) =>
    (await get(`/accounting/journals/${id}`, cookies.financePts).expect(200))
      .body as JournalEntryDto;

  /** Signed USD movement (debit - credit) per account code between two dates, in PTS. */
  async function movement(from: string, to: string): Promise<Map<string, string>> {
    const at = async (asOf: string) =>
      (
        await get(
          `/accounting/trial-balance?asOf=${asOf}&branchId=${pts}`,
          cookies.financePts,
        ).expect(200)
      ).body as TrialBalanceDto;
    const [before, after] = await Promise.all([at(from), at(to)]);
    const result = new Map<string, string>();
    for (const row of after.rows) {
      const old = before.rows.find((r) => r.accountId === row.accountId)?.balanceUsd ?? '0';
      result.set(row.code, new Prisma.Decimal(row.balanceUsd).minus(old).toFixed());
    }
    return result;
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
      managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger Test ${year}`,
        phone: '+249912000222',
        preferredCurrency: 'SDG',
      }).expect(201)
    ).body as CustomerDto;
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    cashSdg = (
      await post('/accounting/accounts', cookies.admin, {
        code: `T${suffix}S`,
        nameEn: 'Test cash PTS (SDG)',
        nameAr: 'نقدية اختبار',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'SDG',
        branchId: pts,
      }).expect(201)
    ).body as AccountDto;
    cashUsd = (
      await post('/accounting/accounts', cookies.admin, {
        code: `T${suffix}U`,
        nameEn: 'Test bank (USD)',
        nameAr: 'بنك اختبار',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'USD',
      }).expect(201)
    ).body as AccountDto;
    const list = (await get('/accounting/accounts', cookies.financePts).expect(200))
      .body as AccountDto[];
    accounts = new Map(list.map((a) => [a.code, a]));
    // New drafts take the rate table's rate for today; earlier days are fine (latest on or before).
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await put('/accounting/fx-rates', cookies.financePts, {
      currency: 'SDG',
      rateDate: twoDaysAgo,
      rate: '600',
    }).expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('customer invoices', () => {
    it('a draft takes its currency from the customer and its rate from the rate table', async () => {
      const draft = (
        await post('/customer-invoices', cookies.financePts, {
          shipmentId: await shipmentId(),
        }).expect(201)
      ).body as CustomerInvoiceDto;
      expect(draft).toMatchObject({ status: 'DRAFT', number: null, currency: 'SDG', total: '0' });
      expect(draft.actions).toEqual({ canEdit: true, canApprove: true, canCancel: true });
      // An empty invoice is not approved.
      await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(400);
    });

    it('approving posts the receivable against each charge’s revenue account', async () => {
      const invoice = await approvedInvoice();
      expect(invoice.status).toBe('APPROVED');
      expect(invoice.number).toMatch(new RegExp(`^NOL-INV-${year}-\\d{6}$`));
      expect(invoice).toMatchObject({
        total: '1000000.5',
        totalUsd: '1666.67',
        balance: '1000000.5',
      });
      expect(invoice.paymentStatus).toBe('UNPAID');
      expect(invoice.actions).toEqual({ canEdit: false, canApprove: false, canCancel: false });

      const entry = await journal(invoice.journalEntryId ?? '');
      expect(entry).toMatchObject({
        status: 'POSTED',
        source: 'CUSTOMER_INVOICE',
        sourceNumber: invoice.number,
        entryDate: d('03-10'),
        totalUsd: '1666.67',
      });
      const byAccount = Object.fromEntries(
        entry.lines.map((l) => [l.accountCode, [l.debitUsd, l.creditUsd, l.debit, l.credit]]),
      );
      expect(byAccount).toEqual({
        '1200': ['1666.67', '0', '1000000.5', '0'], // receivable
        '4100': ['0', '1000', '0', '600000'], // freight revenue
        '4200': ['0', '500', '0', '300000'], // customs revenue
        '1300': ['0', '166.67', '0', '100000.5'], // duties: reimbursable clearing
      });
      expect(entry.lines.every((l) => l.branchId === pts && l.customerId === customer.id)).toBe(
        true,
      );
      // Approved invoices are not edited, approved again or cancelled as drafts.
      await patch(`/customer-invoices/${invoice.id}`, cookies.financePts, {
        currency: 'SDG',
        invoiceDate: d('03-10'),
        dueDate: d('03-10'),
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '1' }],
      }).expect(409);
      await post(`/customer-invoices/${invoice.id}/approve`, cookies.financePts).expect(409);
      await post(`/customer-invoices/${invoice.id}/cancel`, cookies.financePts, {
        reason: 'x',
      }).expect(409);
    });

    it('permissions and branch scope', async () => {
      const draft = (
        await post('/customer-invoices', cookies.financePts, {
          shipmentId: await shipmentId(),
        }).expect(201)
      ).body as CustomerInvoiceDto;
      // Sales views invoices but does not create or approve them.
      await get(`/customer-invoices/${draft.id}`, cookies.salesPts).expect(200);
      await post('/customer-invoices', cookies.salesPts, { shipmentId: draft.shipmentId }).expect(
        403,
      );
      await post(`/customer-invoices/${draft.id}/approve`, cookies.salesPts).expect(403);
      // Another branch's finance sees nothing.
      await get(`/customer-invoices/${draft.id}`, cookies.financeJed).expect(404);
      await post('/customer-invoices', cookies.financeJed, { shipmentId: draft.shipmentId }).expect(
        404,
      );
      const list = (await get('/customer-invoices', cookies.financeJed).expect(200))
        .body as Page<CustomerInvoiceDto>;
      expect(list.items.every((i) => i.branchId !== pts)).toBe(true);
      // A branch manager approves (A) but does not edit.
      await patch(`/customer-invoices/${draft.id}`, cookies.managerPts, {
        currency: 'USD',
        invoiceDate: d('03-11'),
        dueDate: d('03-11'),
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '10' }],
      }).expect(403);
      await post(`/customer-invoices/${draft.id}/cancel`, cookies.financePts, {
        reason: 'Duplicate',
      }).expect(200);
    });

    it('rejects a wrong USD rate and a due date before the invoice date', async () => {
      const draft = (
        await post('/customer-invoices', cookies.financePts, {
          shipmentId: await shipmentId(),
        }).expect(201)
      ).body as CustomerInvoiceDto;
      const body = {
        currency: 'USD',
        invoiceDate: d('03-12'),
        dueDate: d('03-12'),
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '10' }],
      };
      await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
        ...body,
        fxRate: '2',
      }).expect(400);
      await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
        ...body,
        dueDate: d('03-01'),
      }).expect(400);
      const saved = (
        await patch(`/customer-invoices/${draft.id}`, cookies.financePts, body).expect(200)
      ).body as CustomerInvoiceDto;
      expect(saved).toMatchObject({ fxRate: '1', total: '10', totalUsd: '10' });
    });
  });

  describe('receipts', () => {
    it('partial and final payments clear the invoice and book the exchange difference', async () => {
      const invoice = await approvedInvoice(d('04-01'));
      // 500,000 SDG at 650 = 769.23 USD in cash; it clears 833.33 USD of receivable at 600.
      const first = (
        await post('/receipts', cookies.financePts, {
          customerId: customer.id,
          receiptDate: d('04-15'),
          currency: 'SDG',
          fxRate: '650',
          amount: '500000',
          cashAccountId: cashSdg.id,
          reference: 'TT-1',
          allocations: [{ invoiceId: invoice.id, amount: '500000' }],
        }).expect(201)
      ).body as ReceiptDto;
      expect(first.number).toMatch(new RegExp(`^NOL-RC-${year}-\\d{6}$`));
      expect(first).toMatchObject({ allocated: '500000', unallocated: '0', status: 'POSTED' });
      expect(first.allocations[0]).toMatchObject({ amount: '500000', relievedUsd: '833.33' });
      const firstEntry = await journal(first.journalEntryId);
      const lines = Object.fromEntries(
        firstEntry.lines.map((l) => [l.accountCode, [l.debitUsd, l.creditUsd]]),
      );
      expect(lines).toEqual({
        [cashSdg.code]: ['769.23', '0'],
        '1200': ['0', '833.33'],
        '6900': ['64.1', '0'], // realized exchange loss
      });

      let current = (await get(`/customer-invoices/${invoice.id}`, cookies.financePts).expect(200))
        .body as CustomerInvoiceDto;
      expect(current).toMatchObject({ paymentStatus: 'PARTIAL', balance: '500000.5' });

      // The final payment clears what is left in USD exactly; 100 SDG more is a customer advance.
      const second = (
        await post('/receipts', cookies.financePts, {
          customerId: customer.id,
          receiptDate: d('04-20'),
          currency: 'SDG',
          fxRate: '650',
          amount: '500100.5',
          cashAccountId: cashSdg.id,
          allocations: [{ invoiceId: invoice.id, amount: '500000.5' }],
        }).expect(201)
      ).body as ReceiptDto;
      expect(second).toMatchObject({ unallocated: '100' });
      expect(second.allocations[0]?.relievedUsd).toBe('833.34');
      const secondLines = Object.fromEntries(
        (await journal(second.journalEntryId)).lines.map((l) => [
          l.accountCode,
          [l.debitUsd, l.creditUsd],
        ]),
      );
      expect(secondLines).toEqual({
        [cashSdg.code]: ['769.39', '0'],
        '1200': ['0', '833.34'],
        '2200': ['0', '0.15'], // customer advance
        '6900': ['64.1', '0'],
      });
      current = (await get(`/customer-invoices/${invoice.id}`, cookies.financePts).expect(200))
        .body as CustomerInvoiceDto;
      expect(current).toMatchObject({ paymentStatus: 'PAID', balance: '0' });
      expect(current.payments.map((p) => p.receiptNumber)).toEqual([first.number, second.number]);
      const stored = await t.prisma.customerInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(stored.paidUsd.eq(stored.totalUsd)).toBe(true);

      // Cancelling the second receipt reverses its entry and reopens the invoice.
      const cancelled = (
        await post(`/receipts/${second.id}/cancel`, cookies.financePts, {
          reason: 'Bounced transfer',
        }).expect(200)
      ).body as ReceiptDto;
      expect(cancelled.status).toBe('CANCELLED');
      const reversal = await journal(cancelled.cancelJournalEntryId ?? '');
      expect(reversal).toMatchObject({ source: 'REVERSAL', reversalOfId: second.journalEntryId });
      expect(reversal.lines.find((l) => l.accountCode === '1200')?.debitUsd).toBe('833.34');
      current = (await get(`/customer-invoices/${invoice.id}`, cookies.financePts).expect(200))
        .body as CustomerInvoiceDto;
      expect(current).toMatchObject({ paymentStatus: 'PARTIAL', balance: '500000.5' });
      expect(current.payments.find((p) => p.receiptId === second.id)?.cancelled).toBe(true);
      await post(`/receipts/${second.id}/cancel`, cookies.financePts, { reason: 'x' }).expect(409);
      const original = await journal(second.journalEntryId);
      expect(original.reversedById).toBe(reversal.id);
    });

    it('refuses allocations that do not fit', async () => {
      const invoice = await approvedInvoice(d('05-01'));
      const base = {
        customerId: customer.id,
        receiptDate: d('05-02'),
        currency: 'SDG',
        fxRate: '600',
        amount: '2000000',
        cashAccountId: cashSdg.id,
      };
      // More than the invoice's balance, and more than the receipt.
      await post('/receipts', cookies.financePts, {
        ...base,
        allocations: [{ invoiceId: invoice.id, amount: '1000001' }],
      }).expect(400);
      await post('/receipts', cookies.financePts, {
        ...base,
        amount: '10',
        allocations: [{ invoiceId: invoice.id, amount: '11' }],
      }).expect(400);
      // Another currency than the invoice, and a cash account in another currency.
      await post('/receipts', cookies.financePts, {
        ...base,
        currency: 'USD',
        fxRate: null,
        amount: '100',
        cashAccountId: cashUsd.id,
        allocations: [{ invoiceId: invoice.id, amount: '100' }],
      }).expect(400);
      await post('/receipts', cookies.financePts, {
        ...base,
        cashAccountId: cashUsd.id,
        allocations: [],
      }).expect(400);
      // A draft invoice cannot be paid.
      const draft = (
        await post('/customer-invoices', cookies.financePts, {
          shipmentId: await shipmentId(),
        }).expect(201)
      ).body as CustomerInvoiceDto;
      await post('/receipts', cookies.financePts, {
        ...base,
        allocations: [{ invoiceId: draft.id, amount: '1' }],
      }).expect(400);
      expect(
        (
          await t.prisma.customerInvoice.findUniqueOrThrow({ where: { id: invoice.id } })
        ).paidAmount.toFixed(),
      ).toBe('0');
    });

    it('two receipts settling the same invoice at once: only one succeeds', async () => {
      const invoice = await approvedInvoice(d('05-05'));
      const pay = () =>
        post('/receipts', cookies.financePts, {
          customerId: customer.id,
          receiptDate: d('05-06'),
          currency: 'SDG',
          fxRate: '600',
          amount: '1000000.5',
          cashAccountId: cashSdg.id,
          allocations: [{ invoiceId: invoice.id, amount: '1000000.5' }],
        });
      const results = await Promise.all([pay(), pay()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      const stored = await t.prisma.customerInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(stored.paidAmount.eq(stored.total)).toBe(true);
    });

    it('permissions and branch scope', async () => {
      const body = {
        customerId: customer.id,
        receiptDate: d('05-10'),
        currency: 'SDG',
        fxRate: '600',
        amount: '100',
        cashAccountId: cashSdg.id,
        allocations: [],
      };
      await post('/receipts', cookies.salesPts, body).expect(403);
      await post('/receipts', cookies.financeJed, body).expect(404);
      const receipt = (await post('/receipts', cookies.financePts, body).expect(201))
        .body as ReceiptDto;
      expect(receipt.unallocated).toBe('100');
      await get(`/receipts/${receipt.id}`, cookies.salesPts).expect(200);
      await get(`/receipts/${receipt.id}`, cookies.financeJed).expect(404);
      await post(`/receipts/${receipt.id}/cancel`, cookies.managerPts, { reason: 'x' }).expect(403);
    });
  });

  describe('manual journals', () => {
    const expenseLines = () => [
      { accountId: account('6100').id, currency: 'SDG', fxRate: '600', debit: '1000' },
      { accountId: cashSdg.id, currency: 'SDG', fxRate: '600', credit: '500' },
      { accountId: cashSdg.id, currency: 'SDG', fxRate: '600', credit: '500' },
    ];

    it('a draft is posted with a rounding line, then reversed once', async () => {
      const draft = (
        await post('/accounting/journals', cookies.financePts, {
          branchId: pts,
          entryDate: d('06-01'),
          description: 'Office supplies',
          lines: expenseLines(),
        }).expect(201)
      ).body as JournalEntryDto;
      expect(draft).toMatchObject({ status: 'DRAFT', source: 'MANUAL' });
      expect(draft.actions).toMatchObject({ canEdit: true, canPost: true, canReverse: false });

      const posted = (
        await post(`/accounting/journals/${draft.id}/post`, cookies.financePts).expect(200)
      ).body as JournalEntryDto;
      expect(posted.status).toBe('POSTED');
      // 1000 SDG is 1.67 USD, but each 500 SDG is 0.83: the cent goes to rounding.
      expect(posted.lines).toHaveLength(4);
      expect(posted.lines[3]).toMatchObject({ accountCode: '6950', creditUsd: '0.01' });
      await patch(`/accounting/journals/${draft.id}`, cookies.financePts, {
        entryDate: d('06-01'),
        description: 'x',
        lines: expenseLines(),
      }).expect(409);
      await del(`/accounting/journals/${draft.id}`, cookies.financePts).expect(409);

      const reversal = (
        await post(`/accounting/journals/${draft.id}/reverse`, cookies.financePts, {
          entryDate: d('06-02'),
          reason: 'Wrong account',
        }).expect(200)
      ).body as JournalEntryDto;
      expect(reversal).toMatchObject({
        source: 'REVERSAL',
        status: 'POSTED',
        reversalOfId: draft.id,
      });
      expect(reversal.lines.map((l) => [l.debitUsd, l.creditUsd])).toEqual(
        posted.lines.map((l) => [l.creditUsd, l.debitUsd]),
      );
      await post(`/accounting/journals/${draft.id}/reverse`, cookies.financePts, {
        reason: 'again',
      }).expect(409);
      // A reversal is not reversed, and invoice entries are reversed through their documents.
      await post(`/accounting/journals/${reversal.id}/reverse`, cookies.financePts, {
        reason: 'x',
      }).expect(409);
    });

    it('rejects unbalanced entries and control accounts', async () => {
      const draft = (
        await post('/accounting/journals', cookies.financePts, {
          branchId: pts,
          entryDate: d('06-03'),
          description: 'Unbalanced',
          lines: [
            { accountId: account('6100').id, currency: 'USD', debit: '10' },
            { accountId: cashUsd.id, currency: 'USD', credit: '9' },
          ],
        }).expect(201)
      ).body as JournalEntryDto;
      await post(`/accounting/journals/${draft.id}/post`, cookies.financePts).expect(400);
      expect((await journal(draft.id)).status).toBe('DRAFT');
      await del(`/accounting/journals/${draft.id}`, cookies.financePts).expect(204);

      await post('/accounting/journals', cookies.financePts, {
        branchId: pts,
        entryDate: d('06-03'),
        description: 'Into receivables',
        lines: [
          { accountId: account('1200').id, currency: 'USD', debit: '10' },
          { accountId: cashUsd.id, currency: 'USD', credit: '10' },
        ],
      }).expect(400);
      // Header accounts, both sides on one line, a cash account in another currency.
      for (const lines of [
        [
          { accountId: account('6000').id, currency: 'USD', debit: '10' },
          { accountId: cashUsd.id, currency: 'USD', credit: '10' },
        ],
        [
          { accountId: account('6100').id, currency: 'USD', debit: '10', credit: '10' },
          { accountId: cashUsd.id, currency: 'USD', credit: '10' },
        ],
        [
          { accountId: account('6100').id, currency: 'USD', debit: '10' },
          { accountId: cashSdg.id, currency: 'USD', credit: '10' },
        ],
      ]) {
        await post('/accounting/journals', cookies.financePts, {
          branchId: pts,
          entryDate: d('06-03'),
          description: 'Invalid',
          lines,
        }).expect(400);
      }
    });

    it('permissions and branch scope', async () => {
      const body = {
        branchId: pts,
        entryDate: d('06-04'),
        description: 'Scope',
        lines: [
          { accountId: account('6100').id, currency: 'USD', debit: '1' },
          { accountId: cashUsd.id, currency: 'USD', credit: '1' },
        ],
      };
      await post('/accounting/journals', cookies.salesPts, body).expect(403);
      await post('/accounting/journals', cookies.financeJed, body).expect(403);
      const draft = (await post('/accounting/journals', cookies.financePts, body).expect(201))
        .body as JournalEntryDto;
      await get(`/accounting/journals/${draft.id}`, cookies.financeJed).expect(404);
      await post(`/accounting/journals/${draft.id}/post`, cookies.financeJed).expect(404);
      await get(`/accounting/journals/${draft.id}`, cookies.managerPts).expect(403);
      await del(`/accounting/journals/${draft.id}`, cookies.financePts).expect(204);
    });
  });

  describe('posted entries are immutable in the database', () => {
    let posted: { id: string; lineId: string };

    beforeAll(async () => {
      const invoice = await approvedInvoice(d('07-01'));
      const entry = await t.prisma.journalEntry.findUniqueOrThrow({
        where: { id: invoice.journalEntryId ?? '' },
        include: { lines: true },
      });
      posted = { id: entry.id, lineId: entry.lines[0]?.id ?? '' };
    });

    it('rejects updating or deleting a posted entry or its lines', async () => {
      await expect(
        t.prisma.journalEntry.update({
          where: { id: posted.id },
          data: { description: 'changed' },
        }),
      ).rejects.toThrow(/posted/);
      await expect(t.prisma.journalEntry.delete({ where: { id: posted.id } })).rejects.toThrow(
        /posted/,
      );
      await expect(
        t.prisma.journalLine.update({ where: { id: posted.lineId }, data: { description: 'x' } }),
      ).rejects.toThrow(/posted/);
      await expect(t.prisma.journalLine.delete({ where: { id: posted.lineId } })).rejects.toThrow(
        /posted/,
      );
      await expect(
        t.prisma
          .$executeRaw`UPDATE "journal_entries" SET "status" = 'DRAFT' WHERE "id" = ${posted.id}::uuid`,
      ).rejects.toThrow(/posted/);
      await expect(t.prisma.$executeRawUnsafe('TRUNCATE "journal_lines" CASCADE')).rejects.toThrow(
        /truncated/,
      );
      const line = await t.prisma.journalLine.findUniqueOrThrow({ where: { id: posted.lineId } });
      await expect(
        t.prisma.journalLine.create({
          data: { ...line, id: randomUUID(), lineNo: 99 },
        }),
      ).rejects.toThrow(/posted/);
    });

    it('rejects entries created as posted and unbalanced posting', async () => {
      const period = await t.prisma.fiscalPeriod.findFirstOrThrow({
        where: { year, month: 7 },
      });
      const user = await t.prisma.user.findFirstOrThrow({
        where: { email: { startsWith: LEDGER_PREFIX } },
      });
      const base = {
        branchId: pts,
        entryDate: new Date(`${d('07-02')}T00:00:00Z`),
        periodId: period.id,
        description: 'Direct',
        source: 'MANUAL' as const,
        createdById: user.id,
      };
      await expect(
        t.prisma.journalEntry.create({
          data: {
            ...base,
            number: `TEST-${randomUUID().slice(0, 8)}`,
            status: 'POSTED',
            postedAt: new Date(),
            postedById: user.id,
          },
        }),
      ).rejects.toThrow(/draft/);
      const draft = await t.prisma.journalEntry.create({
        data: { ...base, number: `TEST-${randomUUID().slice(0, 8)}` },
      });
      await t.prisma.journalLine.create({
        data: {
          entryId: draft.id,
          lineNo: 1,
          accountId: account('6100').id,
          branchId: pts,
          currency: 'USD',
          fxRate: 1,
          debit: 5,
          debitUsd: 5,
        },
      });
      await t.prisma.journalLine.create({
        data: {
          entryId: draft.id,
          lineNo: 2,
          accountId: cashUsd.id,
          branchId: pts,
          currency: 'USD',
          fxRate: 1,
          credit: 4,
          creditUsd: 4,
        },
      });
      await expect(
        t.prisma.journalEntry.update({
          where: { id: draft.id },
          data: { status: 'POSTED', postedAt: new Date(), postedById: user.id },
        }),
      ).rejects.toThrow(/unbalanced/);
      await t.prisma.journalEntry.delete({ where: { id: draft.id } });
    });
  });

  describe('periods and exchange rates', () => {
    it('a closed period takes no new entries, in the API and in the database', async () => {
      const draft = (
        await post('/accounting/journals', cookies.financePts, {
          branchId: pts,
          entryDate: d('08-10'),
          description: 'Left as draft',
          lines: [
            { accountId: account('6100').id, currency: 'USD', debit: '1' },
            { accountId: cashUsd.id, currency: 'USD', credit: '1' },
          ],
        }).expect(201)
      ).body as JournalEntryDto;
      const periods = (await get('/accounting/periods', cookies.financePts).expect(200))
        .body as FiscalPeriodDto[];
      const august = periods.find((p) => p.year === year && p.month === 8);
      if (!august) throw new Error('No period');
      await post(`/accounting/periods/${august.id}/close`, cookies.salesPts).expect(403);
      // Drafts in the period block closing it.
      await post(`/accounting/periods/${august.id}/close`, cookies.financePts).expect(409);
      await del(`/accounting/journals/${draft.id}`, cookies.financePts).expect(204);
      const closed = (
        await post(`/accounting/periods/${august.id}/close`, cookies.financePts).expect(200)
      ).body as FiscalPeriodDto;
      expect(closed.status).toBe('CLOSED');
      await post(`/accounting/periods/${august.id}/close`, cookies.financePts).expect(409);

      await post('/accounting/journals', cookies.financePts, {
        branchId: pts,
        entryDate: d('08-11'),
        description: 'Too late',
        lines: [
          { accountId: account('6100').id, currency: 'USD', debit: '1' },
          { accountId: cashUsd.id, currency: 'USD', credit: '1' },
        ],
      }).expect(409);
      await post('/receipts', cookies.financePts, {
        customerId: customer.id,
        receiptDate: d('08-12'),
        currency: 'USD',
        amount: '1',
        cashAccountId: cashUsd.id,
        allocations: [],
      }).expect(409);

      // The trigger refuses too, even when the application is bypassed.
      const user = await t.prisma.user.findFirstOrThrow({
        where: { email: { startsWith: LEDGER_PREFIX } },
      });
      const entry = await t.prisma.journalEntry.create({
        data: {
          number: `TEST-${randomUUID().slice(0, 8)}`,
          branchId: pts,
          entryDate: new Date(`${d('08-13')}T00:00:00Z`),
          periodId: august.id,
          description: 'Bypass',
          source: 'MANUAL',
          createdById: user.id,
          lines: {
            create: [
              {
                lineNo: 1,
                accountId: account('6100').id,
                branchId: pts,
                currency: 'USD',
                fxRate: 1,
                debit: 1,
                debitUsd: 1,
              },
              {
                lineNo: 2,
                accountId: cashUsd.id,
                branchId: pts,
                currency: 'USD',
                fxRate: 1,
                credit: 1,
                creditUsd: 1,
              },
            ],
          },
        },
      });
      await expect(
        t.prisma.journalEntry.update({
          where: { id: entry.id },
          data: { status: 'POSTED', postedAt: new Date(), postedById: user.id },
        }),
      ).rejects.toThrow(/closed/);
      await t.prisma.journalEntry.delete({ where: { id: entry.id } });
    });

    it('documents without a rate take the latest one on or before their date', async () => {
      await put('/accounting/fx-rates', cookies.financePts, {
        currency: 'SDG',
        rateDate: d('09-01'),
        rate: '590.5',
      }).expect(200);
      const found = (
        await get(
          `/accounting/fx-rates/lookup?currency=SDG&date=${d('09-15')}`,
          cookies.financePts,
        ).expect(200)
      ).body as FxRateLookupDto;
      expect(found).toEqual({ currency: 'SDG', rate: '590.5', rateDate: d('09-01') });
      await put('/accounting/fx-rates', cookies.salesPts, {
        currency: 'SDG',
        rateDate: d('09-01'),
        rate: '1',
      }).expect(403);
      await put('/accounting/fx-rates', cookies.financePts, {
        currency: 'USD',
        rateDate: d('09-01'),
        rate: '1',
      }).expect(400);
      const receipt = (
        await post('/receipts', cookies.financePts, {
          customerId: customer.id,
          receiptDate: d('09-15'),
          currency: 'SDG',
          amount: '1181',
          cashAccountId: cashSdg.id,
          allocations: [],
        }).expect(201)
      ).body as ReceiptDto;
      expect(receipt.fxRate).toBe('590.5');
    });
  });

  describe('chart of accounts and trial balance', () => {
    it('only the administrator changes the chart; used accounts keep their meaning', async () => {
      const body = {
        code: `T${randomUUID().slice(0, 6).toUpperCase()}`,
        nameEn: 'Test expense',
        nameAr: 'مصروف اختبار',
        type: 'EXPENSE',
        parentId: account('6000').id,
        isPostable: true,
      };
      await post('/accounting/accounts', cookies.financePts, body).expect(403);
      // Wrong parent type, and a postable parent.
      await post('/accounting/accounts', cookies.admin, {
        ...body,
        parentId: account('4000').id,
      }).expect(400);
      await post('/accounting/accounts', cookies.admin, {
        ...body,
        parentId: account('6100').id,
      }).expect(400);
      const created = (await post('/accounting/accounts', cookies.admin, body).expect(201))
        .body as AccountDto;
      await post('/accounting/accounts', cookies.admin, body).expect(409);
      // The receivable account is mapped and used: it cannot become a header or change type.
      const receivable = account('1200');
      await patch(`/accounting/accounts/${receivable.id}`, cookies.admin, {
        code: receivable.code,
        nameEn: receivable.nameEn,
        nameAr: receivable.nameAr,
        type: 'LIABILITY',
        parentId: null,
        isPostable: true,
      }).expect(409);
      expect(receivable.isControl).toBe(true);
      await patch(`/accounting/accounts/${created.id}`, cookies.admin, {
        ...body,
        nameEn: 'Renamed',
      }).expect(200);
    });

    it('posting roles map only to accounts of their type; cash accounts are assets', async () => {
      const mapping = (role: string, accountId: string) =>
        put(`/accounting/settings/mappings/${role}`, cookies.admin, { accountId });
      await mapping('RECEIVABLE', account('4100').id).expect(400);
      await mapping('CUSTOMER_ADVANCES', account('6100').id).expect(400);
      await mapping('FX_GAIN', account('1300').id).expect(400);
      await mapping('RECEIVABLE', cashSdg.id).expect(400);
      // Mapping a role to its own account again is accepted.
      await mapping('FX_GAIN', account('4900').id).expect(200);
      await put('/accounting/settings/charge-types/CUSTOMS', cookies.admin, {
        revenueAccountId: account('5100').id,
        isReimbursable: false,
      }).expect(400);
      await post('/accounting/accounts', cookies.admin, {
        code: `T${randomUUID().slice(0, 6).toUpperCase()}`,
        nameEn: 'Not an asset',
        nameAr: 'ليس أصلاً',
        type: 'EXPENSE',
        isPostable: true,
        isCash: true,
        currency: 'SDG',
      }).expect(400);
    });

    it('an account a posting rule uses stays active, postable and of its type', async () => {
      // 4200 is the CUSTOMS charge type's revenue account (not a role mapping).
      const customs = account('4200');
      const body = {
        code: customs.code,
        nameEn: customs.nameEn,
        nameAr: customs.nameAr,
        type: customs.type,
        parentId: customs.parentId,
        isPostable: true,
      };
      await patch(`/accounting/accounts/${customs.id}`, cookies.admin, {
        ...body,
        isActive: false,
      }).expect(409);
      // The database refuses reclassifying an account with lines, whatever the application does.
      await expect(
        t.prisma
          .$executeRaw`UPDATE "accounts" SET "type" = 'LIABILITY' WHERE "id" = ${account('4100').id}::uuid`,
      ).rejects.toThrow(/has journal lines/);
    });

    it('an account edit waits for a line being written to it, then sees the line', async () => {
      const code = `T${randomUUID().slice(0, 6).toUpperCase()}`;
      const fresh = (
        await post('/accounting/accounts', cookies.admin, {
          code,
          nameEn: 'Fresh expense',
          nameAr: 'مصروف جديد',
          type: 'EXPENSE',
          parentId: account('6000').id,
          isPostable: true,
        }).expect(201)
      ).body as AccountDto;
      const draft = (
        await post('/accounting/journals', cookies.financePts, {
          branchId: pts,
          entryDate: d('07-01'),
          description: 'Draft holding a line',
          lines: [
            { accountId: account('6100').id, currency: 'USD', debit: '1' },
            { accountId: cashUsd.id, currency: 'USD', credit: '1' },
          ],
        }).expect(201)
      ).body as JournalEntryDto;
      const { pending } = await t.prisma.$transaction(async (tx) => {
        // The line trigger share-locks the account until this transaction commits.
        await tx.journalLine.create({
          data: {
            entryId: draft.id,
            lineNo: 3,
            accountId: fresh.id,
            branchId: pts,
            currency: 'USD',
            fxRate: 1,
            debit: 1,
            credit: 0,
            debitUsd: 1,
            creditUsd: 0,
          },
        });
        const request = patch(`/accounting/accounts/${fresh.id}`, cookies.admin, {
          code,
          nameEn: 'Fresh expense',
          nameAr: 'مصروف جديد',
          type: 'EXPENSE',
          parentId: account('6000').id,
          isPostable: false,
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(409);
      await del(`/accounting/journals/${draft.id}`, cookies.financePts).expect(204);
    });

    it('a line waits for an account being deactivated, then is refused', async () => {
      const code = `T${randomUUID().slice(0, 6).toUpperCase()}`;
      const fresh = (
        await post('/accounting/accounts', cookies.admin, {
          code,
          nameEn: 'Closing expense',
          nameAr: 'مصروف يُغلق',
          type: 'EXPENSE',
          parentId: account('6000').id,
          isPostable: true,
        }).expect(201)
      ).body as AccountDto;
      const { pending } = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "accounts" SET "is_active" = false WHERE "id" = ${fresh.id}::uuid`;
        const request = post('/accounting/journals', cookies.financePts, {
          branchId: pts,
          entryDate: d('07-02'),
          description: 'Too late',
          lines: [
            { accountId: fresh.id, currency: 'USD', debit: '1' },
            { accountId: cashUsd.id, currency: 'USD', credit: '1' },
          ],
        }).then((r) => r.status);
        await waitForLockWaiter(t.prisma);
        return { pending: request };
      });
      expect(await pending).toBe(400);
      expect(await t.prisma.journalLine.count({ where: { accountId: fresh.id } })).toBe(0);
    });

    it('a receipt clears the receivable the invoice was posted to, after a remap', async () => {
      const original = account('1200');
      const invoice = await approvedInvoice(d('11-01'));
      const other = (
        await post('/accounting/accounts', cookies.admin, {
          code: `T${randomUUID().slice(0, 6).toUpperCase()}`,
          nameEn: 'Second receivable',
          nameAr: 'ذمم مدينة ثانية',
          type: 'ASSET',
          parentId: account('1000').id,
          isPostable: true,
        }).expect(201)
      ).body as AccountDto;
      await put('/accounting/settings/mappings/RECEIVABLE', cookies.admin, {
        accountId: other.id,
      }).expect(200);
      try {
        // The old receivable still holds an open invoice, so it stays a control account.
        const list = (await get('/accounting/accounts', cookies.financePts).expect(200))
          .body as AccountDto[];
        expect(list.find((a) => a.id === original.id)?.isControl).toBe(true);
        await patch(`/accounting/accounts/${original.id}`, cookies.admin, {
          code: original.code,
          nameEn: original.nameEn,
          nameAr: original.nameAr,
          type: original.type,
          parentId: original.parentId,
          isPostable: true,
          isActive: false,
        }).expect(409);
        const receipt = (
          await post('/receipts', cookies.financePts, {
            customerId: customer.id,
            receiptDate: d('11-02'),
            currency: 'SDG',
            fxRate: '600',
            amount: invoice.total,
            cashAccountId: cashSdg.id,
            allocations: [{ invoiceId: invoice.id, amount: invoice.total }],
          }).expect(201)
        ).body as ReceiptDto;
        const entry = await journal(receipt.journalEntryId);
        const credited = entry.lines.filter((l) => l.creditUsd !== '0');
        expect(credited.map((l) => l.accountId)).toEqual([original.id]);
        expect(entry.lines.some((l) => l.accountId === other.id)).toBe(false);
        const paid = (await get(`/customer-invoices/${invoice.id}`, cookies.financePts).expect(200))
          .body as CustomerInvoiceDto;
        expect(paid.paymentStatus).toBe('PAID');
        // The original receivable nets to zero for this invoice's shipment.
        const lines = await t.prisma.journalLine.findMany({
          where: { accountId: original.id, shipmentId: invoice.shipmentId },
        });
        const net = lines.reduce(
          (sum, l) => sum.plus(l.debitUsd).minus(l.creditUsd),
          new Prisma.Decimal(0),
        );
        expect(net.toFixed()).toBe('0');
      } finally {
        await put('/accounting/settings/mappings/RECEIVABLE', cookies.admin, {
          accountId: original.id,
        }).expect(200);
      }
    });

    it('the trial balance balances and shows this year’s movements', async () => {
      const moves = await movement(d('01-01'), d('12-31'));
      const tb = (
        await get(
          `/accounting/trial-balance?asOf=${d('12-31')}&branchId=${pts}`,
          cookies.financePts,
        ).expect(200)
      ).body as TrialBalanceDto;
      expect(tb.totalDebitUsd).toBe(tb.totalCreditUsd);
      // Revenue is credited (negative balance) and the realized losses are debited.
      expect(new Prisma.Decimal(moves.get('4100') ?? '0').lt(0)).toBe(true);
      expect(new Prisma.Decimal(moves.get('6900') ?? '0').gte('128.2')).toBe(true);
      await get(`/accounting/trial-balance?asOf=${d('12-31')}`, cookies.salesPts).expect(403);
      await get(
        `/accounting/trial-balance?asOf=${d('12-31')}&branchId=${jed}`,
        cookies.financePts,
      ).expect(403);
    });
  });
});
