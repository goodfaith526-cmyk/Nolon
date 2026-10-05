import type {
  AccountDto,
  ApAgingDto,
  ArAgingDto,
  BillableTripDto,
  BookingDto,
  CarrierDto,
  CreditNoteDto,
  CustomerDto,
  CustomerInvoiceDto,
  CustomerStatementDto,
  ExpenseCategoryDto,
  ExpenseDto,
  AccountingSettingsDto,
  AuditLogDto,
  AuditLogEntryDto,
  JournalEntryDto,
  OpenAccrualsDto,
  ReceiptDto,
  SupplierBillDto,
  SupplierDto,
  SupplierPaymentDto,
  TripDto,
} from '@nolon/shared';
import ExcelJS from 'exceljs';
import { randomInt, randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/common/dates.js';
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
 * Group 4b: credit notes, suppliers and their bills (rule 11a clearing of trip accruals),
 * supplier payments, general expenses, opening balances and AP aging. Posted entries are never
 * deleted, so these are LEDGER users and every date is in a random past year.
 */
describe('credit notes, payables, expenses and opening balances', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let portSudan: string;
  let khartoum: string;
  let customer: CustomerDto;
  let carrier: CarrierDto;
  let supplier: SupplierDto;
  let cashSdg: AccountDto;
  let cashUsd: AccountDto;
  /** An SDG cash account of Jeddah: another branch's. */
  let cashJed: AccountDto;
  let accounts: Map<string, AccountDto>;
  let auditorId: string;
  let adminId: string;
  let financePtsId: string;
  const year = randomInt(1901, 2000);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const at = (monthDay: string) => `${year}-${monthDay}T08:00:00+03:00`;
  const cookies = {
    admin: '',
    financePts: '',
    financeJed: '',
    salesPts: '',
    managerPts: '',
    opsPts: '',
    driverPts: '',
    managerJed: '',
    /** Finance and branch manager of Port Sudan: enters, approves and cancels, and reads the log. */
    auditor: '',
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
  const sum = (values: string[]) =>
    values.reduce((acc, v) => acc.plus(v), new Prisma.Decimal(0)).toFixed();
  const journal = async (id: string) =>
    (await get(`/accounting/journals/${id}`, cookies.financePts).expect(200))
      .body as JournalEntryDto;
  const balanced = (entry: JournalEntryDto) => {
    expect(entry.status).toBe('POSTED');
    expect(sum(entry.lines.map((l) => l.debitUsd))).toBe(sum(entry.lines.map((l) => l.creditUsd)));
  };
  const lineOf = (entry: JournalEntryDto, accountId: string) => {
    const found = entry.lines.filter((l) => l.accountId === accountId);
    if (found.length !== 1) throw new Error(`Expected one line on ${accountId}`);
    return found[0];
  };

  async function shipment(weightKg = '1000'): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  /** An SDG invoice of 1,000,000.50 at 600 (1,666.67 USD) for a new shipment, approved. */
  async function approvedInvoice(): Promise<CustomerInvoiceDto> {
    const draft = (
      await post('/customer-invoices', cookies.financePts, {
        shipmentId: await shipment(),
      }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      currency: 'SDG',
      fxRate: '600',
      invoiceDate: d('03-10'),
      dueDate: d('03-10'),
      lines: [
        { chargeTypeCode: 'FREIGHT', quantity: '2', unitPrice: '300000' },
        { chargeTypeCode: 'CUSTOMS', quantity: '1', unitPrice: '300000' },
        { chargeTypeCode: 'DUTIES', quantity: '1', unitPrice: '100000.50' },
      ],
    }).expect(200);
    return (await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as CustomerInvoiceDto;
  }

  /** A completed external trip of `carrier` (600,000 SDG at 600), split 750/250 by weight. */
  async function completedExternalTrip(carrierId = carrier.id): Promise<TripDto> {
    const shipments = [await shipment('750'), await shipment('250')];
    const trip = (
      await post('/trips', cookies.opsPts, {
        branchId: pts,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        shipmentIds: shipments,
        kind: 'EXTERNAL',
        carrierId,
        agreedCost: '600000',
        currency: 'SDG',
      }).expect(201)
    ).body as TripDto;
    // The trip and its shipments' history are dated in the test year (see transport.int-spec.ts).
    const planned = new Date(at('03-31'));
    await t.prisma.trip.update({ where: { id: trip.id }, data: { createdAt: planned } });
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: { in: shipments } },
      data: { occurredAt: planned },
    });
    for (const [status, day] of [
      ['DEPARTED', '04-01'],
      ['ARRIVED', '04-02'],
      ['COMPLETED', '04-03'],
    ] as const) {
      await post(`/trips/${trip.id}/status`, cookies.opsPts, {
        status,
        occurredAt: at(day),
      }).expect(200);
    }
    return (await get(`/trips/${trip.id}`, cookies.opsPts).expect(200)).body as TripDto;
  }

  async function approvedBill(body: object): Promise<SupplierBillDto> {
    const draft = (
      await post('/supplier-bills', cookies.financePts, {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: pts,
        currency: 'SDG',
        fxRate: '600',
        billDate: d('04-10'),
        dueDate: d('05-10'),
        ...body,
      }).expect(201)
    ).body as SupplierBillDto;
    return (await post(`/supplier-bills/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as SupplierBillDto;
  }

  async function workbookValues(res: Response): Promise<unknown[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(res.body as Buffer).buffer);
    const values: unknown[] = [];
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          values.push(cell.value);
        }),
      ),
    );
    return values;
  }

  const binary = (res: Response, done: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  /**
   * Starts the requests while a test transaction holds the row of `table` locked, waits until
   * each is blocked on that lock, then releases it: they run against each other deterministically.
   * Returns their statuses, sorted.
   */
  async function whileLocked(
    table: 'customer_invoices' | 'credit_notes' | 'supplier_bills',
    id: string,
    requests: (() => Promise<Response>)[],
  ): Promise<number[]> {
    const { pending } = await t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid FOR UPDATE`;
        const started = Promise.all(requests.map((request) => request()));
        await waitForLockWaiter(t.prisma, requests.length);
        return { pending: started };
      },
      { timeout: 15_000 },
    );
    return (await pending).map((r) => r.status).sort();
  }

  const creditNoteDraft = async (invoiceId: string, amount: string, creditDate = d('03-20')) =>
    (
      await post('/credit-notes', cookies.financePts, {
        requestId: randomUUID(),
        invoiceId,
        creditDate,
        amount,
        reason: 'Allowance',
      }).expect(201)
    ).body as CreditNoteDto;

  const invoiceRow = (id: string) => t.prisma.customerInvoice.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    portSudan = await loc('SDPZU');
    khartoum = await loc('SDKRT');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
      driverPts: await createUser(t.prisma, ['DRIVER'], ['PTS'], LEDGER_PREFIX),
      managerJed: await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'], LEDGER_PREFIX),
      auditor: await createUser(t.prisma, ['FINANCE', 'BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
    };
    auditorId = users.auditor.id;
    adminId = users.admin.id;
    financePtsId = users.financePts.id;
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger 4B ${year}`,
        phone: '+249912000444',
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
    cashJed = (
      await post('/accounting/accounts', cookies.admin, {
        code: `T${suffix}J`,
        nameEn: 'Test cash JED (SDG)',
        nameAr: 'نقدية اختبار جدة',
        type: 'ASSET',
        isPostable: true,
        isCash: true,
        currency: 'SDG',
        branchId: jed,
      }).expect(201)
    ).body as AccountDto;
    const list = (await get('/accounting/accounts', cookies.financePts).expect(200))
      .body as AccountDto[];
    accounts = new Map(list.map((a) => [a.code, a]));
    await put('/accounting/fx-rates', cookies.financePts, {
      currency: 'SDG',
      rateDate: d('01-01'),
      rate: '600',
    }).expect(200);
    carrier = (
      await post('/transport/carriers', cookies.opsPts, { name: `LG4B Carrier ${suffix}` }).expect(
        201,
      )
    ).body as CarrierDto;
    supplier = (
      await post('/suppliers', cookies.financePts, {
        name: `LG4B Supplier ${suffix}`,
        paymentTermsDays: 30,
      }).expect(201)
    ).body as SupplierDto;
  });

  afterAll(async () => {
    await t.close();
  });

  describe('customer credit notes', () => {
    it('credits part, then the rest, of an approved invoice with reversing entries', async () => {
      const invoice = await approvedInvoice();
      const note = {
        requestId: randomUUID(),
        invoiceId: invoice.id,
        creditDate: d('03-20'),
        amount: '400000',
        reason: 'Agreed discount',
      };
      // Missing permission, wrong branch, more than the open amount.
      await post('/credit-notes', cookies.salesPts, note).expect(403);
      await post('/credit-notes', cookies.financeJed, note).expect(404);
      await post('/credit-notes', cookies.financePts, {
        ...note,
        amount: '1000000.51',
      }).expect(400);

      const draft = (await post('/credit-notes', cookies.financePts, note).expect(201))
        .body as CreditNoteDto;
      expect(draft).toMatchObject({ status: 'DRAFT', number: null, amount: '400000' });
      // A retry returns the same draft; the id cannot be reused by someone else.
      const again = (await post('/credit-notes', cookies.financePts, note).expect(201))
        .body as CreditNoteDto;
      expect(again.id).toBe(draft.id);
      await post('/credit-notes', cookies.admin, note).expect(409);
      await get(`/credit-notes/${draft.id}`, cookies.financeJed).expect(404);

      // Finance enters (E); the branch manager approves (A).
      await post(`/credit-notes/${draft.id}/approve`, cookies.financePts).expect(403);
      const approved = (
        await post(`/credit-notes/${draft.id}/approve`, cookies.managerPts).expect(200)
      ).body as CreditNoteDto;
      expect(approved.number).toMatch(new RegExp(`^NOL-CN-${year}-\\d{6}$`));
      expect(approved).toMatchObject({
        status: 'APPROVED',
        amountUsd: '666.67',
        invoiceBalance: '600000.5',
      });
      await post(`/credit-notes/${draft.id}/cancel`, cookies.admin, { reason: 'x' }).expect(409);

      const entry = await journal(approved.journalEntryId ?? '');
      expect(entry).toMatchObject({ source: 'CREDIT_NOTE', entryDate: d('03-20') });
      balanced(entry);
      expect(lineOf(entry, account('1200').id)).toMatchObject({
        credit: '400000',
        creditUsd: '666.67',
      });
      expect(sum(entry.lines.map((l) => l.debit))).toBe('400000');

      // The rest of the invoice: its whole remaining USD carrying value is cleared.
      const rest = (
        await post('/credit-notes', cookies.financePts, {
          ...note,
          requestId: randomUUID(),
          amount: '600000.5',
        }).expect(201)
      ).body as CreditNoteDto;
      const second = (
        await post(`/credit-notes/${rest.id}/approve`, cookies.managerPts).expect(200)
      ).body as CreditNoteDto;
      expect(second).toMatchObject({ amountUsd: '1000', invoiceBalance: '0' });
      const after = (await get(`/customer-invoices/${invoice.id}`, cookies.financePts).expect(200))
        .body as CustomerInvoiceDto;
      expect(after).toMatchObject({ balance: '0', creditedAmount: '1000000.5' });
      expect(after.creditNotes).toHaveLength(2);
      expect(after.actions.canCreditNote).toBe(false);
      await post('/credit-notes', cookies.financePts, {
        ...note,
        requestId: randomUUID(),
        amount: '1',
      }).expect(400);

      // A fully credited invoice is not in the AR aging.
      const aging = (
        await get(
          `/reports/ar-aging?asOf=${d('12-31')}&branchId=${pts}`,
          cookies.financePts,
        ).expect(200)
      ).body as ArAgingDto;
      expect(aging.invoices.map((i) => i.invoiceId)).not.toContain(invoice.id);

      // The posted entry cannot be edited.
      await expect(
        t.prisma.journalLine.update({
          where: { entryId_lineNo: { entryId: entry.id, lineNo: 1 } },
          data: { description: 'x' },
        }),
      ).rejects.toThrow(/posted/);
      await expect(
        t.prisma.journalEntry.update({ where: { id: entry.id }, data: { description: 'x' } }),
      ).rejects.toThrow(/posted/);
    });

    it('only a draft credit note is edited or cancelled', async () => {
      const invoice = await approvedInvoice();
      const draft = (
        await post('/credit-notes', cookies.financePts, {
          requestId: randomUUID(),
          invoiceId: invoice.id,
          creditDate: d('03-20'),
          amount: '100',
          reason: 'Typo',
        }).expect(201)
      ).body as CreditNoteDto;
      const edited = (
        await patch(`/credit-notes/${draft.id}`, cookies.financePts, {
          creditDate: d('03-21'),
          amount: '200',
          reason: 'Typo fixed',
        }).expect(200)
      ).body as CreditNoteDto;
      expect(edited).toMatchObject({ amount: '200', creditDate: d('03-21') });
      const cancelled = (
        await post(`/credit-notes/${draft.id}/cancel`, cookies.admin, {
          reason: 'Not needed',
        }).expect(200)
      ).body as CreditNoteDto;
      expect(cancelled.status).toBe('CANCELLED');
      await post(`/credit-notes/${draft.id}/approve`, cookies.managerPts).expect(409);
    });
    it('a credit note id is not reused with another body; an exact retry returns the draft', async () => {
      const invoice = await approvedInvoice();
      const note = {
        requestId: randomUUID(),
        invoiceId: invoice.id,
        creditDate: d('03-20'),
        amount: '100',
        reason: 'Allowance',
      };
      const draft = (await post('/credit-notes', cookies.financePts, note).expect(201))
        .body as CreditNoteDto;
      await post('/credit-notes', cookies.financePts, { ...note, amount: '101' }).expect(409);
      await post('/credit-notes', cookies.financePts, { ...note, reason: 'Other' }).expect(409);
      await post('/credit-notes', cookies.financePts, {
        ...note,
        creditDate: d('03-21'),
      }).expect(409);
      const retry = (await post('/credit-notes', cookies.financePts, note).expect(201))
        .body as CreditNoteDto;
      expect(retry.id).toBe(draft.id);
    });

    it('the credit note that closes an invoice after cent-rounded receipts balances', async () => {
      // SAR 10,000 at 3.75 is 2,666.67 USD; nine receipts of SAR 1,000 clear 266.67 each
      // (2,400.03), so the last SAR 1,000 has 266.64 USD left against 266.67 at the rate.
      const cashSar = (
        await post('/accounting/accounts', cookies.admin, {
          code: `T${randomUUID().slice(0, 6).toUpperCase()}R`,
          nameEn: 'Test cash PTS (SAR)',
          nameAr: 'نقدية اختبار ريال',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency: 'SAR',
          branchId: pts,
        }).expect(201)
      ).body as AccountDto;
      const draft = (
        await post('/customer-invoices', cookies.financePts, {
          shipmentId: await shipment(),
        }).expect(201)
      ).body as CustomerInvoiceDto;
      await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
        currency: 'SAR',
        fxRate: '3.75',
        invoiceDate: d('03-10'),
        dueDate: d('03-10'),
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '10000' }],
      }).expect(200);
      const invoice = (
        await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200)
      ).body as CustomerInvoiceDto;
      expect(invoice.totalUsd).toBe('2666.67');
      for (let i = 0; i < 9; i++) {
        const receipt = (
          await post('/receipts', cookies.financePts, {
            customerId: customer.id,
            receiptDate: d('03-15'),
            currency: 'SAR',
            fxRate: '3.75',
            amount: '1000',
            cashAccountId: cashSar.id,
            allocations: [{ invoiceId: invoice.id, amount: '1000' }],
          }).expect(201)
        ).body as ReceiptDto;
        expect(receipt.allocations[0]?.relievedUsd).toBe('266.67');
      }
      const note = await creditNoteDraft(invoice.id, '1000');
      const approved = (
        await post(`/credit-notes/${note.id}/approve`, cookies.managerPts).expect(200)
      ).body as CreditNoteDto;
      expect(approved).toMatchObject({ amountUsd: '266.64', invoiceBalance: '0' });
      const entry = await journal(approved.journalEntryId ?? '');
      balanced(entry);
      expect(lineOf(entry, account('1200').id)).toMatchObject({
        credit: '1000',
        creditUsd: '266.64',
      });
      const revenue = entry.lines.filter((l) => l.currency === 'SAR' && l.debit !== '0');
      expect(sum(revenue.map((l) => l.debitUsd))).toBe('266.67');
      const rounding = entry.lines.filter((l) => l.description === 'Rounding');
      expect(rounding).toEqual([expect.objectContaining({ currency: 'USD', creditUsd: '0.03' })]);
      const row = await invoiceRow(invoice.id);
      expect(row.paidUsd.plus(row.creditedUsd).toFixed()).toBe('2666.67');
      expect(row.paidAmount.plus(row.creditedAmount).toFixed()).toBe('10000');
    });

    it('two drafts that each fit but together exceed the invoice: the second approval fails', async () => {
      // Sequentially: 1,000,000.50 open, 600,000 approved, then 600,000 more is refused.
      const invoice = await approvedInvoice();
      const first = await creditNoteDraft(invoice.id, '600000');
      const second = await creditNoteDraft(invoice.id, '600000');
      await post(`/credit-notes/${first.id}/approve`, cookies.managerPts).expect(200);
      await post(`/credit-notes/${second.id}/approve`, cookies.managerPts).expect(400);
      expect((await invoiceRow(invoice.id)).creditedAmount.toFixed()).toBe('600000');

      // Concurrently: both approvals queue on the invoice; one posts, the other is refused.
      const other = await approvedInvoice();
      const a = await creditNoteDraft(other.id, '600000');
      const b = await creditNoteDraft(other.id, '600000');
      const statuses = await whileLocked('customer_invoices', other.id, [
        () => post(`/credit-notes/${a.id}/approve`, cookies.managerPts),
        () => post(`/credit-notes/${b.id}/approve`, cookies.managerPts),
      ]);
      expect(statuses).toEqual([200, 400]);
      expect((await invoiceRow(other.id)).creditedAmount.toFixed()).toBe('600000');
      expect(
        await t.prisma.journalEntry.count({
          where: { source: 'CREDIT_NOTE', sourceId: { in: [a.id, b.id] } },
        }),
      ).toBe(1);
    });

    it('a credit note approval racing a receipt never relieves more than the invoice', async () => {
      const invoice = await approvedInvoice();
      const note = await creditNoteDraft(invoice.id, '600000');
      const statuses = await whileLocked('customer_invoices', invoice.id, [
        () => post(`/credit-notes/${note.id}/approve`, cookies.managerPts),
        () =>
          post('/receipts', cookies.financePts, {
            customerId: customer.id,
            receiptDate: d('03-25'),
            currency: 'SDG',
            fxRate: '600',
            amount: '600000',
            cashAccountId: cashSdg.id,
            allocations: [{ invoiceId: invoice.id, amount: '600000' }],
          }),
      ]);
      // Whichever ran first succeeded (200 approve, 201 receipt); the other was refused cleanly.
      expect(statuses).toHaveLength(2);
      expect(statuses[1]).toBe(400);
      expect([200, 201]).toContain(statuses[0]);
      const row = await invoiceRow(invoice.id);
      expect(row.paidAmount.plus(row.creditedAmount).toFixed()).toBe('600000');
      expect(row.paidUsd.plus(row.creditedUsd).toFixed()).toBe('1000');
    });

    it('a credit note is approved once, sequentially or concurrently', async () => {
      const invoice = await approvedInvoice();
      const once = await creditNoteDraft(invoice.id, '100');
      await post(`/credit-notes/${once.id}/approve`, cookies.managerPts).expect(200);
      await post(`/credit-notes/${once.id}/approve`, cookies.managerPts).expect(409);

      const twice = await creditNoteDraft(invoice.id, '100');
      const statuses = await whileLocked('credit_notes', twice.id, [
        () => post(`/credit-notes/${twice.id}/approve`, cookies.managerPts),
        () => post(`/credit-notes/${twice.id}/approve`, cookies.managerPts),
      ]);
      expect(statuses).toEqual([200, 409]);
      expect(
        await t.prisma.journalEntry.count({ where: { source: 'CREDIT_NOTE', sourceId: twice.id } }),
      ).toBe(1);
      expect((await invoiceRow(invoice.id)).creditedAmount.toFixed()).toBe('200');
    });
  });

  describe('suppliers and bills', () => {
    it('suppliers are permissioned master data; carriers are linked to them', async () => {
      await post('/suppliers', cookies.salesPts, { name: 'Nope' }).expect(403);
      await get('/suppliers', cookies.salesPts).expect(403);
      const linked = (
        await put(
          `/suppliers/${supplier.id}/carriers/${carrier.id}`,
          cookies.financePts,
          {},
        ).expect(200)
      ).body as SupplierDto;
      expect(linked.carriers).toEqual([{ id: carrier.id, name: carrier.name }]);
      const fetched = (await get(`/transport/carriers`, cookies.opsPts).expect(200))
        .body as CarrierDto[];
      expect(fetched.find((c) => c.id === carrier.id)).toMatchObject({
        supplierId: supplier.id,
        supplierName: supplier.name,
      });
      expect(supplier.number).toMatch(/^NOL-SUP-\d{6}$/);
    });

    it('a bill for shipment costs and expenses posts to their accounts and the payable', async () => {
      const shipmentId = await shipment();
      const bill = await approvedBill({
        supplierReference: 'INV-77',
        lines: [
          { kind: 'SHIPMENT_COST', shipmentId, chargeTypeCode: 'CUSTOMS', amount: '120000' },
          { kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '60000' },
        ],
      });
      expect(bill.number).toMatch(new RegExp(`^NOL-SB-${year}-\\d{6}$`));
      expect(bill).toMatchObject({ status: 'APPROVED', total: '180000', totalUsd: '300' });
      const entry = await journal(bill.journalEntryId ?? '');
      expect(entry).toMatchObject({ source: 'SUPPLIER_BILL', entryDate: d('04-10') });
      balanced(entry);
      expect(lineOf(entry, account('5200').id)).toMatchObject({
        debitUsd: '200',
        shipmentId,
      });
      expect(lineOf(entry, account('6100').id)).toMatchObject({ debitUsd: '100' });
      expect(lineOf(entry, account('2100').id)).toMatchObject({
        credit: '180000',
        creditUsd: '300',
        supplierId: supplier.id,
      });
      await get(`/supplier-bills/${bill.id}`, cookies.financeJed).expect(404);
      await patch(`/supplier-bills/${bill.id}`, cookies.financePts, {
        branchId: pts,
        currency: 'SDG',
        billDate: d('04-10'),
        dueDate: d('05-10'),
        lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '1' }],
      }).expect(409);
    });

    it('draft checks: wrong branch, missing permission, bad dates and unknown categories', async () => {
      const body = {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: pts,
        currency: 'SDG',
        billDate: d('04-10'),
        dueDate: d('05-10'),
        lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '100' }],
      };
      await post('/supplier-bills', cookies.financeJed, body).expect(403);
      await post('/supplier-bills', cookies.salesPts, body).expect(403);
      await post('/supplier-bills', cookies.financePts, { ...body, dueDate: d('04-01') }).expect(
        400,
      );
      await post('/supplier-bills', cookies.financePts, {
        ...body,
        lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'NOPE', amount: '100' }],
      }).expect(400);
      // Operations enters bills (E) but cannot approve them.
      const draft = (await post('/supplier-bills', cookies.opsPts, body).expect(201))
        .body as SupplierBillDto;
      // An exact retry returns the draft; the id with another body is refused.
      const retry = (await post('/supplier-bills', cookies.opsPts, body).expect(201))
        .body as SupplierBillDto;
      expect(retry.id).toBe(draft.id);
      await post('/supplier-bills', cookies.opsPts, {
        ...body,
        lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '101' }],
      }).expect(409);
      await post('/supplier-bills', cookies.opsPts, { ...body, dueDate: d('05-11') }).expect(409);
      await post(`/supplier-bills/${draft.id}/approve`, cookies.opsPts).expect(403);
      const cancelled = (
        await post(`/supplier-bills/${draft.id}/cancel`, cookies.financePts, {
          reason: 'Dup',
        }).expect(200)
      ).body as SupplierBillDto;
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelJournalEntryId: null });
    });
    it('shipment costs and trips are of the bill branch; a cancelled shipment is refused', async () => {
      const ptsShipment = await shipment();
      const jedBill = {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: jed,
        currency: 'SDG',
        fxRate: '600',
        billDate: d('04-10'),
        dueDate: d('05-10'),
      };
      await post('/supplier-bills', cookies.admin, {
        ...jedBill,
        lines: [
          {
            kind: 'SHIPMENT_COST',
            shipmentId: ptsShipment,
            chargeTypeCode: 'CUSTOMS',
            amount: '1',
          },
        ],
      }).expect(400);
      const ptsTrip = await completedExternalTrip();
      await post('/supplier-bills', cookies.admin, {
        ...jedBill,
        lines: [{ kind: 'TRIP', tripId: ptsTrip.id, amount: '1' }],
      }).expect(400);

      // The shipment is cancelled after the draft: approval checks it again and refuses.
      const doomed = await shipment();
      const draft = (
        await post('/supplier-bills', cookies.financePts, {
          ...jedBill,
          branchId: pts,
          lines: [
            { kind: 'SHIPMENT_COST', shipmentId: doomed, chargeTypeCode: 'CUSTOMS', amount: '1' },
          ],
        }).expect(201)
      ).body as SupplierBillDto;
      await post(`/shipments/${doomed}/cancel`, cookies.opsPts, {
        reason: 'Customer withdrew',
      }).expect(200);
      await post(`/supplier-bills/${draft.id}/approve`, cookies.financePts).expect(400);
      const after = (await get(`/supplier-bills/${draft.id}`, cookies.financePts).expect(200))
        .body as SupplierBillDto;
      expect(after).toMatchObject({ status: 'DRAFT', journalEntryId: null });
    });

    it('a bill is approved once, sequentially or concurrently', async () => {
      const draft = async () =>
        (
          await post('/supplier-bills', cookies.financePts, {
            requestId: randomUUID(),
            supplierId: supplier.id,
            branchId: pts,
            currency: 'SDG',
            fxRate: '600',
            billDate: d('04-10'),
            dueDate: d('05-10'),
            lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '600' }],
          }).expect(201)
        ).body as SupplierBillDto;
      const once = await draft();
      await post(`/supplier-bills/${once.id}/approve`, cookies.financePts).expect(200);
      await post(`/supplier-bills/${once.id}/approve`, cookies.financePts).expect(409);

      const twice = await draft();
      const statuses = await whileLocked('supplier_bills', twice.id, [
        () => post(`/supplier-bills/${twice.id}/approve`, cookies.financePts),
        () => post(`/supplier-bills/${twice.id}/approve`, cookies.financePts),
      ]);
      expect(statuses).toEqual([200, 409]);
      expect(
        await t.prisma.journalEntry.count({
          where: { source: 'SUPPLIER_BILL', sourceId: twice.id },
        }),
      ).toBe(1);
    });
  });

  describe('rule 11a, payments and AP aging', () => {
    let trip: TripDto;
    let bill: SupplierBillDto;
    let payment: SupplierPaymentDto;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const openAccruals = async (asOf: string) =>
      (
        await get(`/reports/open-accruals?asOf=${asOf}&branchId=${pts}`, cookies.financePts).expect(
          200,
        )
      ).body as OpenAccrualsDto;

    it('a carrier bill clears the trip accrual; the difference goes to cost', async () => {
      trip = await completedExternalTrip();
      if (!trip.accrualJournalEntryId) throw new Error('No accrual');
      expect((await openAccruals(d('12-31'))).trips.map((x) => x.tripId)).toContain(trip.id);
      const billable = (
        await get(
          `/suppliers/${supplier.id}/billable-trips?branchId=${pts}`,
          cookies.financePts,
        ).expect(200)
      ).body as BillableTripDto[];
      expect(billable.find((b) => b.tripId === trip.id)).toMatchObject({
        agreedCost: '600000',
        currency: 'SDG',
      });

      // Billed 660,000 against 600,000 accrued: 1,100 USD payable, 1,000 accrued cleared.
      bill = await approvedBill({ lines: [{ kind: 'TRIP', tripId: trip.id, amount: '660000' }] });
      expect(bill).toMatchObject({ totalUsd: '1100', balance: '660000' });
      const entry = await journal(bill.journalEntryId ?? '');
      balanced(entry);
      const accrued = lineOf(entry, account('2300').id);
      expect(accrued).toMatchObject({ debit: '600000', debitUsd: '1000', fxRate: '600' });
      expect(lineOf(entry, account('2100').id)).toMatchObject({
        credit: '660000',
        creditUsd: '1100',
      });
      const costLines = entry.lines.filter(
        (l) => l.accountId !== account('2300').id && l.accountId !== account('2100').id,
      );
      expect(sum(costLines.map((l) => l.debitUsd))).toBe('100');

      expect((await openAccruals(d('12-31'))).trips.map((x) => x.tripId)).not.toContain(trip.id);
      const after = (
        await get(`/suppliers/${supplier.id}/billable-trips`, cookies.financePts).expect(200)
      ).body as BillableTripDto[];
      expect(after.map((b) => b.tripId)).not.toContain(trip.id);

      // A second bill for the same trip is refused on approval.
      const duplicate = (
        await post('/supplier-bills', cookies.financePts, {
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          currency: 'SDG',
          fxRate: '600',
          billDate: d('04-11'),
          dueDate: d('05-11'),
          lines: [{ kind: 'TRIP', tripId: trip.id, amount: '1' }],
        }).expect(201)
      ).body as SupplierBillDto;
      await post(`/supplier-bills/${duplicate.id}/approve`, cookies.financePts).expect(409);
    });

    it('a supplier payment books the realized exchange difference', async () => {
      const body = {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: pts,
        paymentDate: d('05-01'),
        currency: 'SDG',
        fxRate: '660',
        cashAccountId: cashSdg.id,
        allocations: [{ billId: bill.id, amount: '330000' }],
      };
      // Missing permission, wrong branch, more than the bill has open, wrong cash currency.
      await post('/supplier-payments', cookies.opsPts, body).expect(403);
      await post('/supplier-payments', cookies.financeJed, body).expect(403);
      await post('/supplier-payments', cookies.financePts, {
        ...body,
        allocations: [{ billId: bill.id, amount: '660000.01' }],
      }).expect(400);
      await post('/supplier-payments', cookies.financePts, {
        ...body,
        cashAccountId: cashUsd.id,
      }).expect(400);
      // Another branch's cash account.
      await post('/supplier-payments', cookies.financePts, {
        ...body,
        requestId: randomUUID(),
        cashAccountId: cashJed.id,
      }).expect(400);

      payment = (await post('/supplier-payments', cookies.financePts, body).expect(201))
        .body as SupplierPaymentDto;
      expect(payment.number).toMatch(new RegExp(`^NOL-SP-${year}-\\d{6}$`));
      expect(payment.allocations).toEqual([
        expect.objectContaining({ billId: bill.id, amount: '330000', relievedUsd: '550' }),
      ]);
      // An exact retry returns the same payment; a different body under the id is refused.
      const retry = (await post('/supplier-payments', cookies.financePts, body).expect(201))
        .body as SupplierPaymentDto;
      expect(retry.id).toBe(payment.id);
      await post('/supplier-payments', cookies.financePts, {
        ...body,
        allocations: [{ billId: bill.id, amount: '1' }],
      }).expect(409);

      const entry = await journal(payment.journalEntryId);
      expect(entry).toMatchObject({ source: 'SUPPLIER_PAYMENT', entryDate: d('05-01') });
      balanced(entry);
      expect(lineOf(entry, account('2100').id)).toMatchObject({
        debit: '330000',
        debitUsd: '550',
      });
      expect(lineOf(entry, cashSdg.id)).toMatchObject({ credit: '330000', creditUsd: '500' });
      expect(lineOf(entry, account('4900').id)).toMatchObject({ creditUsd: '50' });
      const paid = (await get(`/supplier-bills/${bill.id}`, cookies.financePts).expect(200))
        .body as SupplierBillDto;
      expect(paid).toMatchObject({ paidAmount: '330000', balance: '330000' });
      expect(paid.actions.canCancel).toBe(false);
    });

    it('AP aging lists the open part of the bill, scoped and exportable', async () => {
      const aging = (
        await get(
          `/reports/ap-aging?asOf=${d('12-31')}&branchId=${pts}&supplierId=${supplier.id}`,
          cookies.financePts,
        ).expect(200)
      ).body as ApAgingDto;
      expect(aging.bills.find((b) => b.billId === bill.id)).toMatchObject({
        outstanding: '330000',
        outstandingUsd: '550',
        bucket: 'over90',
      });
      expect(aging.suppliers).toHaveLength(1);
      // Before the payment the whole bill was open; before the bill, nothing.
      const april = (
        await get(
          `/reports/ap-aging?asOf=${d('04-30')}&supplierId=${supplier.id}`,
          cookies.financePts,
        ).expect(200)
      ).body as ApAgingDto;
      expect(april.bills.find((b) => b.billId === bill.id)).toMatchObject({
        outstanding: '660000',
        outstandingUsd: '1100',
        bucket: 'current',
      });
      const march = (
        await get(
          `/reports/ap-aging?asOf=${d('03-31')}&supplierId=${supplier.id}`,
          cookies.financePts,
        ).expect(200)
      ).body as ApAgingDto;
      expect(march.bills).toHaveLength(0);
      // Another branch's user sees none of it; Sales has no financial reports.
      const jed = (
        await get(
          `/reports/ap-aging?asOf=${d('12-31')}&supplierId=${supplier.id}`,
          cookies.financeJed,
        ).expect(200)
      ).body as ApAgingDto;
      expect(jed.bills).toHaveLength(0);
      await get(`/reports/ap-aging?asOf=${d('12-31')}&branchId=${pts}`, cookies.financeJed).expect(
        403,
      );
      await get(`/reports/ap-aging?asOf=${d('12-31')}`, cookies.salesPts).expect(403);

      const res = await get(
        `/reports/ap-aging/export?asOf=${d('12-31')}&branchId=${pts}&supplierId=${supplier.id}&locale=en`,
        cookies.financePts,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      const values = await workbookValues(res);
      expect(values).toContain('Supplier payables aging');
      expect(values).toContain(bill.number);
      expect(values).toContain(550);
    });

    it('cancelling the payment, then the bill, reopens the bill and the accrual', async () => {
      await post(`/supplier-bills/${bill.id}/cancel`, cookies.financePts, { reason: 'x' }).expect(
        409,
      );
      await post(`/supplier-payments/${payment.id}/cancel`, cookies.opsPts, { reason: 'x' }).expect(
        403,
      );
      const cancelled = (
        await post(`/supplier-payments/${payment.id}/cancel`, cookies.financePts, {
          reason: 'Wrong account',
        }).expect(200)
      ).body as SupplierPaymentDto;
      expect(cancelled.status).toBe('CANCELLED');
      await post(`/supplier-payments/${payment.id}/cancel`, cookies.financePts, {
        reason: 'again',
      }).expect(409);
      expect((await journal(payment.journalEntryId)).reversedById).not.toBeNull();

      const reopened = (await get(`/supplier-bills/${bill.id}`, cookies.financePts).expect(200))
        .body as SupplierBillDto;
      expect(reopened).toMatchObject({ paidAmount: '0', balance: '660000' });
      const billCancelled = (
        await post(`/supplier-bills/${bill.id}/cancel`, cookies.financePts, {
          reason: 'Billed in error',
        }).expect(200)
      ).body as SupplierBillDto;
      expect(billCancelled.status).toBe('CANCELLED');
      expect(billCancelled.cancelJournalEntryId).not.toBeNull();
      // The trip can be billed again and its accrual is open again from the reversal's date.
      const billable = (
        await get(`/suppliers/${supplier.id}/billable-trips`, cookies.financePts).expect(200)
      ).body as BillableTripDto[];
      expect(billable.map((b) => b.tripId)).toContain(trip.id);
      expect((await openAccruals(tomorrow)).trips.map((x) => x.tripId)).toContain(trip.id);
    });
  });

  describe('carrier links racing a carrier bill', () => {
    /** A new carrier linked to `supplier`, a completed trip of it, and a draft bill for it. */
    async function draftCarrierBill() {
      const own = (
        await post('/transport/carriers', cookies.opsPts, {
          name: `LG4B Carrier ${randomUUID().slice(0, 6)}`,
        }).expect(201)
      ).body as CarrierDto;
      await put(`/suppliers/${supplier.id}/carriers/${own.id}`, cookies.financePts, {}).expect(200);
      const trip = await completedExternalTrip(own.id);
      const draft = (
        await post('/supplier-bills', cookies.financePts, {
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          currency: 'SDG',
          fxRate: '600',
          billDate: d('04-12'),
          dueDate: d('05-12'),
          lines: [{ kind: 'TRIP', tripId: trip.id, amount: '600000' }],
        }).expect(201)
      ).body as SupplierBillDto;
      return { carrierId: own.id, trip, draft };
    }

    it('a link change that commits first makes the approval refuse the trip', async () => {
      const { carrierId, trip, draft } = await draftCarrierBill();
      const other = (
        await post('/suppliers', cookies.financePts, {
          name: `LG4B Other ${randomUUID().slice(0, 6)}`,
        }).expect(201)
      ).body as SupplierDto;
      // The approval waits on the trip row while the carrier is moved to another supplier.
      const approval = await t.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "trips" WHERE "id" = ${trip.id}::uuid FOR UPDATE`;
          const started = post(`/supplier-bills/${draft.id}/approve`, cookies.financePts).then(
            (r) => r,
          );
          await waitForLockWaiter(t.prisma);
          await put(`/suppliers/${other.id}/carriers/${carrierId}`, cookies.financePts, {}).expect(
            200,
          );
          return { started };
        },
        { timeout: 15_000 },
      );
      const res = await approval.started;
      expect(res.status).toBe(400);
      const bill = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: draft.id } });
      expect(bill).toMatchObject({ status: 'DRAFT', journalEntryId: null });
      const row = await t.prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
      expect(row.carrierBillId).toBeNull();
      const linked = await t.prisma.carrier.findUniqueOrThrow({ where: { id: carrierId } });
      expect(linked.supplierId).toBe(other.id);
    });

    it('an approval that read the link first makes the link change wait for it', async () => {
      const { carrierId, trip, draft } = await draftCarrierBill();
      // A bill of this year is numbered first, so the sequence row exists to be held.
      await approvedBill({
        lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '600' }],
      });
      let unlinked = false;
      // The approval passes the carrier (share lock held) and waits on the bill number while the
      // unlink is sent: the unlink must wait on the carrier row until the approval commits.
      const { approval, unlink } = await t.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT 1 FROM "number_sequences"
            WHERE "doc_type" = 'SUPPLIER_BILL' AND "period_key" = ${String(year)} FOR UPDATE`;
          const approval = post(`/supplier-bills/${draft.id}/approve`, cookies.financePts).then(
            (r) => r,
          );
          await waitForLockWaiter(t.prisma);
          const unlink = del(
            `/suppliers/${supplier.id}/carriers/${carrierId}`,
            cookies.financePts,
          ).then((r) => {
            unlinked = true;
            return r;
          });
          await waitForLockWaiter(t.prisma, 2);
          expect(unlinked).toBe(false);
          return { approval, unlink };
        },
        { timeout: 15_000 },
      );
      expect((await approval).status).toBe(200);
      expect((await unlink).status).toBe(200);
      const bill = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: draft.id } });
      expect(bill.status).toBe('APPROVED');
      const row = await t.prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
      expect(row.carrierBillId).toBe(draft.id);
      const after = await t.prisma.carrier.findUniqueOrThrow({ where: { id: carrierId } });
      expect(after.supplierId).toBeNull();
    });
  });

  describe('supplier payment retries and races', () => {
    const rentBill = () =>
      approvedBill({ lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '60000' }] });

    it('an exact retry replays; changing the rate, reference or notes is refused', async () => {
      const target = await rentBill();
      const body = {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: pts,
        paymentDate: d('05-02'),
        currency: 'SDG',
        fxRate: '600',
        cashAccountId: cashSdg.id,
        reference: 'TRF-1',
        notes: 'First half',
        allocations: [{ billId: target.id, amount: '30000' }],
      };
      const first = (await post('/supplier-payments', cookies.financePts, body).expect(201))
        .body as SupplierPaymentDto;
      // The same rate written another way is the same request.
      const replay = (
        await post('/supplier-payments', cookies.financePts, {
          ...body,
          fxRate: '600.00000000',
        }).expect(201)
      ).body as SupplierPaymentDto;
      expect(replay).toMatchObject({ id: first.id, number: first.number });
      for (const change of [
        { fxRate: '600.00000001' },
        { fxRate: '601' },
        { reference: 'TRF-2' },
        { reference: null },
        { notes: 'Second half' },
        { notes: null },
      ]) {
        await post('/supplier-payments', cookies.financePts, { ...body, ...change }).expect(409);
      }
      // Dropping a field the first request sent is a change too.
      for (const dropped of ['reference', 'notes'] as const) {
        const partial: Partial<typeof body> = { ...body };
        delete partial[dropped];
        await post('/supplier-payments', cookies.financePts, partial).expect(409);
      }

      // A request that left the rate to the table replays when it again omits it, and is refused
      // when it names another rate; a request without reference or notes replays without them.
      const tableRate = {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: pts,
        paymentDate: d('05-03'),
        currency: 'SDG',
        cashAccountId: cashSdg.id,
        allocations: [{ billId: target.id, amount: '10000' }],
      };
      const second = (await post('/supplier-payments', cookies.financePts, tableRate).expect(201))
        .body as SupplierPaymentDto;
      expect(second).toMatchObject({ fxRate: '600', reference: null, notes: null });
      const again = (
        await post('/supplier-payments', cookies.financePts, {
          ...tableRate,
          fxRate: null,
          reference: null,
          notes: null,
        }).expect(201)
      ).body as SupplierPaymentDto;
      expect(again.id).toBe(second.id);
      await post('/supplier-payments', cookies.financePts, { ...tableRate, fxRate: '650' }).expect(
        409,
      );
      await post('/supplier-payments', cookies.financePts, {
        ...tableRate,
        reference: 'TRF-3',
      }).expect(409);

      // Nothing more was posted or paid by the replays and refusals.
      const ids = [first.id, second.id];
      expect(await t.prisma.supplierPayment.count({ where: { id: { in: ids } } })).toBe(2);
      expect(
        await t.prisma.journalEntry.count({
          where: { source: 'SUPPLIER_PAYMENT', sourceId: { in: ids } },
        }),
      ).toBe(2);
      const row = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.paidAmount.toFixed()).toBe('40000');
    });

    it('a retry is compared with the rate the client sent, not with the rate table today', async () => {
      const target = await rentBill();
      const setRate = (rate: string) =>
        put('/accounting/fx-rates', cookies.financePts, {
          currency: 'SDG',
          rateDate: d('05-06'),
          rate,
        }).expect(200);
      await setRate('610');
      try {
        const tableRate = {
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          paymentDate: d('05-06'),
          currency: 'SDG',
          cashAccountId: cashSdg.id,
          allocations: [{ billId: target.id, amount: '12000' }],
        };
        const first = (await post('/supplier-payments', cookies.financePts, tableRate).expect(201))
          .body as SupplierPaymentDto;
        expect(first.fxRate).toBe('610');
        // The table's rate for the date is corrected after the payment.
        await setRate('620');
        const replay = (await post('/supplier-payments', cookies.financePts, tableRate).expect(201))
          .body as SupplierPaymentDto;
        expect(replay).toMatchObject({ id: first.id, number: first.number, fxRate: '610' });
        // Naming a rate the first request left to the table is another request, even the same one.
        for (const fxRate of ['610', '620']) {
          await post('/supplier-payments', cookies.financePts, { ...tableRate, fxRate }).expect(
            409,
          );
        }

        // A request that named its rate replays with that rate whatever the table says.
        const entered = {
          ...tableRate,
          requestId: randomUUID(),
          fxRate: '615',
          allocations: [{ billId: target.id, amount: '6000' }],
        };
        const second = (await post('/supplier-payments', cookies.financePts, entered).expect(201))
          .body as SupplierPaymentDto;
        await setRate('630');
        const again = (await post('/supplier-payments', cookies.financePts, entered).expect(201))
          .body as SupplierPaymentDto;
        expect(again).toMatchObject({ id: second.id, fxRate: '615' });
        await post('/supplier-payments', cookies.financePts, { ...entered, fxRate: '616' }).expect(
          409,
        );
        const omitted: Partial<typeof entered> = { ...entered };
        delete omitted.fxRate;
        await post('/supplier-payments', cookies.financePts, omitted).expect(409);

        // The replays and refusals posted and paid nothing more.
        const ids = [first.id, second.id];
        expect(await t.prisma.supplierPayment.count({ where: { id: { in: ids } } })).toBe(2);
        expect(
          await t.prisma.journalEntry.count({
            where: { source: 'SUPPLIER_PAYMENT', sourceId: { in: ids } },
          }),
        ).toBe(2);
        const row = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: target.id } });
        expect(row.paidAmount.toFixed()).toBe('18000');
      } finally {
        // Later dates resolve the suite's rate again.
        await setRate('600');
      }
    });

    it('two payments of the whole balance at once: one is recorded, the other refused', async () => {
      const target = await rentBill();
      const pay = (requestId: string) => () =>
        post('/supplier-payments', cookies.financePts, {
          requestId,
          supplierId: supplier.id,
          branchId: pts,
          paymentDate: d('05-04'),
          currency: 'SDG',
          fxRate: '600',
          cashAccountId: cashSdg.id,
          allocations: [{ billId: target.id, amount: '60000' }],
        });
      const ids = [randomUUID(), randomUUID()];
      const statuses = await whileLocked('supplier_bills', target.id, ids.map(pay));
      expect(statuses).toEqual([201, 400]);

      const row = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.paidAmount.toFixed()).toBe('60000');
      expect(row.paidAmount.lte(row.total)).toBe(true);
      expect(row.paidUsd.toFixed()).toBe('100');
      const payments = await t.prisma.supplierPayment.findMany({ where: { id: { in: ids } } });
      expect(payments).toHaveLength(1);
      expect(await t.prisma.supplierPaymentAllocation.count({ where: { billId: target.id } })).toBe(
        1,
      );
      expect(
        await t.prisma.journalEntry.count({
          where: { source: 'SUPPLIER_PAYMENT', sourceId: { in: ids } },
        }),
      ).toBe(1);
      // The refused request left nothing behind.
      const refused = ids.find((id) => id !== payments[0]?.id) ?? '';
      expect(
        await t.prisma.supplierPaymentAllocation.count({ where: { paymentId: refused } }),
      ).toBe(0);
      expect(await t.prisma.journalEntry.count({ where: { sourceId: refused } })).toBe(0);
    });
  });

  describe('general expenses', () => {
    const body = () => ({
      requestId: randomUUID(),
      branchId: pts,
      expenseDate: d('06-01'),
      categoryCode: 'RENT',
      description: 'Office rent June',
      currency: 'SDG',
      amount: '120000',
      cashAccountId: cashSdg.id,
    });

    it('draft, approve (posts) and cancel (reverses), permissioned and branch-scoped', async () => {
      const input = body();
      await post('/expenses', cookies.salesPts, input).expect(403);
      await post('/expenses', cookies.driverPts, input).expect(403);
      await post('/expenses', cookies.financeJed, input).expect(403);
      await post('/expenses', cookies.opsPts, { ...input, cashAccountId: cashUsd.id }).expect(400);
      await post('/expenses', cookies.opsPts, { ...input, cashAccountId: cashJed.id }).expect(400);
      await post('/expenses', cookies.opsPts, { ...input, categoryCode: 'NOPE' }).expect(400);

      const draft = (await post('/expenses', cookies.opsPts, input).expect(201)).body as ExpenseDto;
      expect(draft).toMatchObject({ status: 'DRAFT', number: null, fxRate: '600' });
      const retry = (await post('/expenses', cookies.opsPts, input).expect(201)).body as ExpenseDto;
      expect(retry.id).toBe(draft.id);
      await post('/expenses', cookies.opsPts, { ...input, amount: '120001' }).expect(409);
      await post('/expenses', cookies.opsPts, { ...input, description: 'Other' }).expect(409);
      await get(`/expenses/${draft.id}`, cookies.financeJed).expect(404);
      await post(`/expenses/${draft.id}/approve`, cookies.opsPts).expect(403);

      const approved = (await post(`/expenses/${draft.id}/approve`, cookies.managerPts).expect(200))
        .body as ExpenseDto;
      expect(approved.number).toMatch(new RegExp(`^NOL-EXP-${year}-\\d{6}$`));
      const entry = await journal(approved.journalEntryId ?? '');
      expect(entry).toMatchObject({ source: 'EXPENSE', entryDate: d('06-01') });
      balanced(entry);
      expect(lineOf(entry, account('6100').id)).toMatchObject({ debit: '120000', debitUsd: '200' });
      expect(lineOf(entry, cashSdg.id)).toMatchObject({ credit: '120000', creditUsd: '200' });
      await patch(`/expenses/${draft.id}`, cookies.opsPts, {
        expenseDate: d('06-01'),
        categoryCode: 'RENT',
        description: 'x',
        currency: 'SDG',
        amount: '1',
        cashAccountId: cashSdg.id,
      }).expect(409);

      const cancelled = (
        await post(`/expenses/${draft.id}/cancel`, cookies.financePts, {
          reason: 'Duplicate',
        }).expect(200)
      ).body as ExpenseDto;
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelJournalEntryId).not.toBeNull();
      expect((await journal(entry.id)).reversedById).not.toBeNull();
    });

    it('expense categories are master data the Administrator maintains', async () => {
      const code = `T${randomInt(10000, 99999)}`;
      const category = {
        nameEn: 'Test category',
        nameAr: 'فئة اختبار',
        accountId: account('6100').id,
      };
      await put(`/accounting/expense-categories/${code}`, cookies.financePts, category).expect(403);
      await put(`/accounting/expense-categories/${code}`, cookies.admin, {
        ...category,
        accountId: account('1200').id,
      }).expect(400);
      await put(`/accounting/expense-categories/${code}`, cookies.admin, {
        ...category,
        isActive: false,
      }).expect(200);
      const list = (await get('/accounting/expense-categories', cookies.opsPts).expect(200))
        .body as ExpenseCategoryDto[];
      expect(list.find((c) => c.code === code)).toMatchObject({ isActive: false });
      await post('/expenses', cookies.opsPts, { ...body(), categoryCode: code }).expect(400);
    });
  });

  describe('opening balances', () => {
    it('posts account balances against opening equity, once per request', async () => {
      const request = {
        requestId: randomUUID(),
        branchId: pts,
        entryDate: d('01-01'),
        lines: [{ accountId: cashSdg.id, currency: 'SDG', fxRate: '600', debit: '600000' }],
      };
      await post('/accounting/opening-balances', cookies.opsPts, request).expect(403);
      await post('/accounting/opening-balances', cookies.financeJed, request).expect(403);
      await post('/accounting/opening-balances', cookies.financePts, {
        ...request,
        requestId: randomUUID(),
        lines: [{ accountId: account('1200').id, currency: 'USD', debit: '10' }],
      }).expect(400);
      const entry = (
        await post('/accounting/opening-balances', cookies.financePts, request).expect(201)
      ).body as JournalEntryDto;
      expect(entry).toMatchObject({ source: 'OPENING_BALANCE', status: 'POSTED' });
      balanced(entry);
      expect(lineOf(entry, account('3100').id)).toMatchObject({ creditUsd: '1000' });
      const again = (
        await post('/accounting/opening-balances', cookies.financePts, request).expect(201)
      ).body as JournalEntryDto;
      expect(again.id).toBe(entry.id);
      // The id with other lines, branch-wide text or date is refused.
      await post('/accounting/opening-balances', cookies.financePts, {
        ...request,
        lines: [{ accountId: cashSdg.id, currency: 'SDG', fxRate: '600', debit: '600001' }],
      }).expect(409);
      await post('/accounting/opening-balances', cookies.financePts, {
        ...request,
        description: 'Other',
      }).expect(409);
      await post('/accounting/opening-balances', cookies.financePts, {
        ...request,
        entryDate: d('01-02'),
      }).expect(409);
    });

    it('customer and supplier open items post against opening equity and show in aging', async () => {
      const customerItem = {
        requestId: randomUUID(),
        customerId: customer.id,
        entryDate: d('01-01'),
        reference: 'OLD-INV-1',
        invoiceDate: d('01-01'),
        dueDate: d('01-31'),
        currency: 'SDG',
        amount: '300000',
      };
      await post('/customer-invoices/opening', cookies.salesPts, customerItem).expect(403);
      const invoice = (
        await post('/customer-invoices/opening', cookies.financePts, customerItem).expect(201)
      ).body as CustomerInvoiceDto;
      expect(invoice).toMatchObject({
        isOpening: true,
        status: 'APPROVED',
        shipmentId: null,
        reference: 'OLD-INV-1',
        totalUsd: '500',
      });
      expect(invoice.number).toMatch(new RegExp(`^NOL-OBI-${year}-\\d{6}$`));
      const invoiceEntry = await journal(invoice.journalEntryId ?? '');
      balanced(invoiceEntry);
      expect(lineOf(invoiceEntry, account('1200').id)).toMatchObject({ debitUsd: '500' });
      expect(lineOf(invoiceEntry, account('3100').id)).toMatchObject({ creditUsd: '500' });
      const arAging = (
        await get(
          `/reports/ar-aging?asOf=${d('01-15')}&customerId=${customer.id}`,
          cookies.financePts,
        ).expect(200)
      ).body as ArAgingDto;
      expect(arAging.invoices.map((i) => i.invoiceId)).toContain(invoice.id);
      // An exact retry returns the item; the id with another body is refused, and an open
      // item's id does not stand for an opening accounts entry.
      const sameItem = (
        await post('/customer-invoices/opening', cookies.financePts, customerItem).expect(201)
      ).body as CustomerInvoiceDto;
      expect(sameItem.id).toBe(invoice.id);
      for (const change of [
        { reference: 'OLD-INV-2' },
        { amount: '300001' },
        { dueDate: d('02-28') },
        { entryDate: d('01-02') },
      ]) {
        await post('/customer-invoices/opening', cookies.financePts, {
          ...customerItem,
          ...change,
        }).expect(409);
      }
      await post('/accounting/opening-balances', cookies.financePts, {
        requestId: customerItem.requestId,
        branchId: pts,
        entryDate: d('01-01'),
        lines: [{ accountId: cashSdg.id, currency: 'SDG', fxRate: '600', debit: '600000' }],
      }).expect(409);

      const supplierItem = {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: pts,
        entryDate: d('01-01'),
        reference: 'OLD-BILL-1',
        billDate: d('01-01'),
        dueDate: d('01-31'),
        currency: 'SDG',
        amount: '60000',
      };
      await post('/supplier-bills/opening', cookies.opsPts, supplierItem).expect(403);
      const openingBill = (
        await post('/supplier-bills/opening', cookies.financePts, supplierItem).expect(201)
      ).body as SupplierBillDto;
      expect(openingBill).toMatchObject({ isOpening: true, status: 'APPROVED', totalUsd: '100' });
      expect(openingBill.actions.canCancel).toBe(false);
      const billEntry = await journal(openingBill.journalEntryId ?? '');
      balanced(billEntry);
      expect(lineOf(billEntry, account('2100').id)).toMatchObject({
        creditUsd: '100',
        supplierId: supplier.id,
      });
      const retry = (
        await post('/supplier-bills/opening', cookies.financePts, supplierItem).expect(201)
      ).body as SupplierBillDto;
      expect(retry.id).toBe(openingBill.id);
      for (const change of [
        { reference: 'OLD-BILL-2' },
        { amount: '60001' },
        { dueDate: d('02-28') },
        { currency: 'USD', amount: '100' },
      ]) {
        await post('/supplier-bills/opening', cookies.financePts, {
          ...supplierItem,
          ...change,
        }).expect(409);
      }
      const apAging = (
        await get(
          `/reports/ap-aging?asOf=${d('01-15')}&supplierId=${supplier.id}`,
          cookies.financePts,
        ).expect(200)
      ).body as ApAgingDto;
      expect(apAging.bills.map((b) => b.billId)).toEqual([openingBill.id]);
    });

    it('a credit note on an opening item debits opening equity; both show on the statement', async () => {
      const item = (
        await post('/customer-invoices/opening', cookies.financePts, {
          requestId: randomUUID(),
          customerId: customer.id,
          entryDate: d('01-01'),
          reference: 'OLD-INV-9',
          invoiceDate: d('01-01'),
          dueDate: d('01-31'),
          currency: 'SDG',
          amount: '300000',
        }).expect(201)
      ).body as CustomerInvoiceDto;
      const draft = await creditNoteDraft(item.id, '100000', d('02-01'));
      const note = (await post(`/credit-notes/${draft.id}/approve`, cookies.managerPts).expect(200))
        .body as CreditNoteDto;
      expect(note).toMatchObject({ amountUsd: '166.67', invoiceBalance: '200000' });
      const invoiceAfter = (
        await get(`/customer-invoices/${item.id}`, cookies.financePts).expect(200)
      ).body as CustomerInvoiceDto;
      expect(invoiceAfter).toMatchObject({ creditedAmount: '100000', balance: '200000' });

      // The opening item credited OPENING_EQUITY; the credit note reverses that side, not revenue.
      const settings = (await get('/accounting/settings', cookies.admin).expect(200))
        .body as AccountingSettingsDto;
      const role = (name: string) => {
        const found = settings.mappings.find((m) => m.role === name)?.accountId;
        if (!found) throw new Error(`No ${name} account`);
        return found;
      };
      const equity = role('OPENING_EQUITY');
      const entry = await journal(note.journalEntryId ?? '');
      balanced(entry);
      expect(lineOf(entry, equity)).toMatchObject({
        debit: '100000',
        debitUsd: '166.67',
        customerId: customer.id,
      });
      expect(lineOf(entry, account('1200').id)).toMatchObject({
        credit: '100000',
        creditUsd: '166.67',
        customerId: customer.id,
      });
      expect(entry.lines.filter((l) => l.accountId === role('DEFAULT_REVENUE'))).toHaveLength(0);
      expect(entry.lines).toHaveLength(2);

      // Sales may not view journal entries, yet both lines show with their kind and number.
      const statement = (
        await get(
          `/customer-statements/${customer.id}?from=${d('01-01')}&to=${d('12-31')}`,
          cookies.salesPts,
        ).expect(200)
      ).body as CustomerStatementDto;
      const lines = statement.sections.flatMap((section) => section.lines);
      expect(lines.find((l) => l.documentId === item.id)).toMatchObject({
        kind: 'OPENING_BALANCE',
        documentNumber: item.number,
        detailsHidden: false,
        debit: '300000',
      });
      expect(lines.find((l) => l.documentId === draft.id)).toMatchObject({
        kind: 'CREDIT_NOTE',
        documentNumber: note.number,
        detailsHidden: false,
        credit: '100000',
      });
      // The running balance drops by the credit note, and the totals still close.
      const sdg = statement.sections.find((section) => section.currency === 'SDG');
      if (!sdg) throw new Error('No SDG section');
      const index = sdg.lines.findIndex((l) => l.documentId === draft.id);
      const before = index === 0 ? sdg.openingBalance : (sdg.lines[index - 1]?.balance ?? '');
      expect(new Prisma.Decimal(before).minus(sdg.lines[index]?.balance ?? '').toFixed()).toBe(
        '100000',
      );
      expect(
        new Prisma.Decimal(sdg.openingBalance)
          .plus(sdg.totalDebit)
          .minus(sdg.totalCredit)
          .toFixed(),
      ).toBe(sdg.closingBalance);
    });
  });

  describe('retries of open items, bills and expenses compare the rate the client sent', () => {
    type Body = Record<string, unknown> & { requestId: string };
    /**
     * For one create path: a request without a rate replays without one and is refused with one
     * (even the table's); a request with a rate replays with the same number and is refused
     * without it or with another. Nothing more is recorded.
     */
    const check = async (
      path: string,
      cookie: string,
      body: () => Body,
      count: (ids: string[]) => Promise<number>,
    ) => {
      const omitted = body();
      const first = (await post(path, cookie, omitted).expect(201)).body as { id: string };
      const replay = (await post(path, cookie, { ...omitted, fxRate: null }).expect(201)).body as {
        id: string;
      };
      expect(replay.id).toBe(first.id);
      await post(path, cookie, { ...omitted, fxRate: '600' }).expect(409);

      const entered = { ...body(), fxRate: '600' };
      const second = (await post(path, cookie, entered).expect(201)).body as { id: string };
      const again = (await post(path, cookie, { ...entered, fxRate: '600.00000000' }).expect(201))
        .body as { id: string };
      expect(again.id).toBe(second.id);
      const dropped: Partial<Body> = { ...entered };
      delete dropped.fxRate;
      await post(path, cookie, dropped).expect(409);
      await post(path, cookie, { ...entered, fxRate: null }).expect(409);
      await post(path, cookie, { ...entered, fxRate: '601' }).expect(409);
      expect(await count([first.id, second.id])).toBe(2);
    };

    it('opening customer items', async () => {
      await check(
        '/customer-invoices/opening',
        cookies.financePts,
        () => ({
          requestId: randomUUID(),
          customerId: customer.id,
          entryDate: d('01-02'),
          reference: `RATE-${randomInt(1e6)}`,
          invoiceDate: d('01-02'),
          dueDate: d('01-31'),
          currency: 'SDG',
          amount: '6000',
        }),
        (ids) => t.prisma.customerInvoice.count({ where: { id: { in: ids } } }),
      );
    });

    it('opening supplier items', async () => {
      await check(
        '/supplier-bills/opening',
        cookies.financePts,
        () => ({
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          entryDate: d('01-02'),
          reference: `RATE-${randomInt(1e6)}`,
          billDate: d('01-02'),
          dueDate: d('01-31'),
          currency: 'SDG',
          amount: '6000',
        }),
        (ids) => t.prisma.supplierBill.count({ where: { id: { in: ids } } }),
      );
    });

    it('supplier bills', async () => {
      await check(
        '/supplier-bills',
        cookies.opsPts,
        () => ({
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          currency: 'SDG',
          billDate: d('04-12'),
          dueDate: d('05-12'),
          lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '600' }],
        }),
        (ids) => t.prisma.supplierBill.count({ where: { id: { in: ids } } }),
      );
    });

    it('general expenses', async () => {
      await check(
        '/expenses',
        cookies.opsPts,
        () => ({
          requestId: randomUUID(),
          branchId: pts,
          expenseDate: d('06-02'),
          categoryCode: 'RENT',
          description: 'Rate retry',
          currency: 'SDG',
          amount: '600',
          cashAccountId: cashSdg.id,
        }),
        (ids) => t.prisma.expense.count({ where: { id: { in: ids } } }),
      );
    });
  });

  describe('postings whose USD value rounds to zero', () => {
    // 1 SDG at 600 is 0.0017 USD: 0.00 once rounded to cents. A document worth nothing in USD is
    // refused with a 400 and leaves nothing behind; it is never a 500 from the balance trigger.
    const tooSmall = /too small to post in USD/;
    const refused = async (res: PromiseLike<Response>) => {
      const body = (await res).body as { message?: unknown };
      expect(String(body.message)).toMatch(tooSmall);
    };

    it('a supplier bill worth 0.00 USD is refused on approval and stays a draft', async () => {
      const draft = (
        await post('/supplier-bills', cookies.financePts, {
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          currency: 'SDG',
          fxRate: '600',
          billDate: d('04-10'),
          dueDate: d('05-10'),
          lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '1' }],
        }).expect(201)
      ).body as SupplierBillDto;
      await refused(post(`/supplier-bills/${draft.id}/approve`, cookies.financePts).expect(400));
      const row = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row).toMatchObject({ status: 'DRAFT', number: null, journalEntryId: null });
      expect(await t.prisma.journalEntry.count({ where: { sourceId: draft.id } })).toBe(0);
    });

    it('lines that round to 0.00 USD in a bill worth more post, balanced by the rounding line', async () => {
      // 3 SDG is 0.005 USD: each line rounds up to 0.01, the 6 SDG payable to 0.01.
      const bill = await approvedBill({
        lines: [
          { kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '3' },
          { kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '3' },
          { kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '1' },
        ],
      });
      const entry = await journal(bill.journalEntryId ?? '');
      balanced(entry);
      expect(entry.lines.some((l) => l.debit === '1' && l.debitUsd === '0')).toBe(true);
      expect(lineOf(entry, account('2100').id)).toMatchObject({ credit: '7', creditUsd: '0.01' });
      expect(sum(entry.lines.map((l) => l.debitUsd))).toBe('0.02');
    });

    it('a supplier payment worth 0.00 USD is refused and writes nothing', async () => {
      const target = await approvedBill({
        lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '60000' }],
      });
      const requestId = randomUUID();
      await refused(
        post('/supplier-payments', cookies.financePts, {
          requestId,
          supplierId: supplier.id,
          branchId: pts,
          paymentDate: d('05-05'),
          currency: 'SDG',
          fxRate: '600',
          cashAccountId: cashSdg.id,
          allocations: [{ billId: target.id, amount: '1' }],
        }).expect(400),
      );
      expect(await t.prisma.supplierPayment.count({ where: { id: requestId } })).toBe(0);
      expect(await t.prisma.journalEntry.count({ where: { sourceId: requestId } })).toBe(0);
      const row = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.paidAmount.toFixed()).toBe('0');
    });

    it('an expense worth 0.00 USD is refused on approval and stays a draft', async () => {
      const draft = (
        await post('/expenses', cookies.opsPts, {
          requestId: randomUUID(),
          branchId: pts,
          expenseDate: d('06-02'),
          categoryCode: 'RENT',
          description: 'Stamp',
          currency: 'SDG',
          amount: '1',
          cashAccountId: cashSdg.id,
        }).expect(201)
      ).body as ExpenseDto;
      await refused(post(`/expenses/${draft.id}/approve`, cookies.managerPts).expect(400));
      const row = await t.prisma.expense.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row).toMatchObject({ status: 'DRAFT', number: null, journalEntryId: null });
    });

    it('a credit note worth 0.00 USD is refused on approval and stays a draft', async () => {
      const invoice = await approvedInvoice();
      const draft = await creditNoteDraft(invoice.id, '1');
      await refused(post(`/credit-notes/${draft.id}/approve`, cookies.managerPts).expect(400));
      const row = await t.prisma.creditNote.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row).toMatchObject({ status: 'DRAFT', journalEntryId: null });
      expect((await invoiceRow(invoice.id)).creditedAmount.toFixed()).toBe('0');
    });

    it('a receipt and a customer invoice worth 0.00 USD are refused', async () => {
      const invoice = await approvedInvoice();
      await refused(
        post('/receipts', cookies.financePts, {
          customerId: customer.id,
          receiptDate: d('03-15'),
          currency: 'SDG',
          fxRate: '600',
          amount: '1',
          cashAccountId: cashSdg.id,
          allocations: [{ invoiceId: invoice.id, amount: '1' }],
        }).expect(400),
      );
      expect((await invoiceRow(invoice.id)).paidAmount.toFixed()).toBe('0');

      const draft = (
        await post('/customer-invoices', cookies.financePts, {
          shipmentId: await shipment(),
        }).expect(201)
      ).body as CustomerInvoiceDto;
      await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
        currency: 'SDG',
        fxRate: '600',
        invoiceDate: d('03-10'),
        dueDate: d('03-10'),
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '1' }],
      }).expect(200);
      await refused(post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(400));
      expect((await invoiceRow(draft.id)).status).toBe('DRAFT');
    });

    it('opening balances and open items worth 0.00 USD are refused', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await refused(
        post('/accounting/opening-balances', cookies.financePts, {
          requestId: ids[0],
          branchId: pts,
          entryDate: d('01-01'),
          lines: [{ accountId: cashSdg.id, currency: 'SDG', fxRate: '600', debit: '1' }],
        }).expect(400),
      );
      await refused(
        post('/customer-invoices/opening', cookies.financePts, {
          requestId: ids[1],
          customerId: customer.id,
          entryDate: d('01-01'),
          reference: 'OLD-TINY',
          invoiceDate: d('01-01'),
          dueDate: d('01-31'),
          currency: 'SDG',
          amount: '1',
        }).expect(400),
      );
      await refused(
        post('/supplier-bills/opening', cookies.financePts, {
          requestId: ids[2],
          supplierId: supplier.id,
          branchId: pts,
          entryDate: d('01-01'),
          reference: 'OLD-TINY',
          billDate: d('01-01'),
          dueDate: d('01-31'),
          currency: 'SDG',
          amount: '1',
        }).expect(400),
      );
      expect(await t.prisma.customerInvoice.count({ where: { reference: 'OLD-TINY' } })).toBe(0);
      expect(await t.prisma.supplierBill.count({ where: { supplierReference: 'OLD-TINY' } })).toBe(
        0,
      );
    });
  });

  describe('audit log of credit notes, supplier bills and payments, and expenses', () => {
    let period: string;
    const numbers = { creditNote: '', bill: '', payment: '', expense: '' };
    const drafts = { creditNote: '' };

    const auditLog = async (query: string, cookie = cookies.auditor) =>
      (await get(`/reports/audit-log?${period}${query}`, cookie).expect(200)).body as AuditLogDto;
    const steps = (entries: AuditLogEntryDto[], reference: string) =>
      entries
        .filter((e) => e.reference === reference)
        .map((e) => [e.entity, e.action, e.status])
        .sort();

    beforeAll(async () => {
      const { timezone } = await t.prisma.branch.findUniqueOrThrow({ where: { id: pts } });
      const day = 86_400_000;
      // Recorded now: the period around today in the branch, whatever the time of day.
      period = `from=${todayIn(timezone, new Date(Date.now() - day))}&to=${todayIn(
        timezone,
        new Date(Date.now() + day),
      )}`;
      const by = cookies.auditor;

      // A credit note created, approved; another created and cancelled (a draft keeps no number).
      const invoice = await approvedInvoice();
      const note = (
        await post('/credit-notes', by, {
          requestId: randomUUID(),
          invoiceId: invoice.id,
          creditDate: d('03-20'),
          amount: '1000',
          reason: 'Audit allowance',
        }).expect(201)
      ).body as CreditNoteDto;
      numbers.creditNote =
        ((await post(`/credit-notes/${note.id}/approve`, by).expect(200)).body as CreditNoteDto)
          .number ?? '';
      const noteDraft = (
        await post('/credit-notes', by, {
          requestId: randomUUID(),
          invoiceId: invoice.id,
          creditDate: d('03-21'),
          amount: '1',
          reason: 'Audit draft',
        }).expect(201)
      ).body as CreditNoteDto;
      drafts.creditNote = noteDraft.id;
      // Only the Administrator cancels a credit note.
      await post(`/credit-notes/${noteDraft.id}/cancel`, cookies.admin, {
        reason: 'Audit: not needed',
      }).expect(200);

      // A supplier bill created, approved, paid; the payment and then the bill cancelled.
      const billDraft = (
        await post('/supplier-bills', by, {
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          currency: 'SDG',
          fxRate: '600',
          billDate: d('04-10'),
          dueDate: d('05-10'),
          supplierReference: 'AUD-1',
          lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'RENT', amount: '6000' }],
        }).expect(201)
      ).body as SupplierBillDto;
      numbers.bill =
        (
          (await post(`/supplier-bills/${billDraft.id}/approve`, by).expect(200))
            .body as SupplierBillDto
        ).number ?? '';
      const payment = (
        await post('/supplier-payments', by, {
          requestId: randomUUID(),
          supplierId: supplier.id,
          branchId: pts,
          paymentDate: d('05-01'),
          currency: 'SDG',
          fxRate: '600',
          cashAccountId: cashSdg.id,
          reference: 'AUD-TRF',
          allocations: [{ billId: billDraft.id, amount: '6000' }],
        }).expect(201)
      ).body as SupplierPaymentDto;
      numbers.payment = payment.number;
      await post(`/supplier-payments/${payment.id}/cancel`, by, { reason: 'Wrong bank' }).expect(
        200,
      );
      await post(`/supplier-bills/${billDraft.id}/cancel`, by, { reason: 'Billed twice' }).expect(
        200,
      );

      // An expense created, approved and cancelled.
      const expense = (
        await post('/expenses', by, {
          requestId: randomUUID(),
          branchId: pts,
          expenseDate: d('06-02'),
          categoryCode: 'RENT',
          description: 'Audit rent',
          currency: 'SDG',
          amount: '600',
          cashAccountId: cashSdg.id,
        }).expect(201)
      ).body as ExpenseDto;
      numbers.expense =
        ((await post(`/expenses/${expense.id}/approve`, by).expect(200)).body as ExpenseDto)
          .number ?? '';
      await post(`/expenses/${expense.id}/cancel`, by, { reason: 'Paid twice' }).expect(200);
    });

    it('records each step with its number, status, user, time and branch', async () => {
      const r = await auditLog(`&userId=${auditorId}`);
      expect(r.users.map((u) => u.id)).toEqual([auditorId]);
      expect(r.entries.every((e) => e.userId === auditorId && e.branchCode === 'PTS')).toBe(true);
      expect(r.entries.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
      expect(steps(r.entries, numbers.creditNote)).toEqual(
        [
          ['CREDIT_NOTE', 'CREATED', 'DRAFT'],
          ['CREDIT_NOTE', 'APPROVED', 'APPROVED'],
        ].sort(),
      );
      expect(steps(r.entries, numbers.bill)).toEqual(
        [
          ['SUPPLIER_BILL', 'CREATED', 'DRAFT'],
          ['SUPPLIER_BILL', 'APPROVED', 'APPROVED'],
          ['SUPPLIER_BILL', 'CANCELLED', 'CANCELLED'],
        ].sort(),
      );
      expect(steps(r.entries, numbers.payment)).toEqual(
        [
          ['SUPPLIER_PAYMENT', 'POSTED', 'POSTED'],
          ['SUPPLIER_PAYMENT', 'CANCELLED', 'CANCELLED'],
        ].sort(),
      );
      expect(steps(r.entries, numbers.expense)).toEqual(
        [
          ['EXPENSE', 'CREATED', 'DRAFT'],
          ['EXPENSE', 'APPROVED', 'APPROVED'],
          ['EXPENSE', 'CANCELLED', 'CANCELLED'],
        ].sort(),
      );
      // Cancellations carry the reason and who cancelled, a cancelled draft included.
      const cancelled = r.entries.filter((e) => e.action === 'CANCELLED');
      expect(cancelled.map((e) => [e.entity, e.detail]).sort()).toEqual(
        [
          ['EXPENSE', 'Paid twice'],
          ['SUPPLIER_BILL', 'Billed twice'],
          ['SUPPLIER_PAYMENT', 'Wrong bank'],
        ].sort(),
      );
      const byAdmin = await auditLog(`&userId=${adminId}&entity=CREDIT_NOTE`);
      expect(byAdmin.entries.filter((e) => e.detail === 'Audit: not needed')).toEqual([
        expect.objectContaining({
          entity: 'CREDIT_NOTE',
          action: 'CANCELLED',
          reference: '—',
          status: 'CANCELLED',
          userId: adminId,
          branchCode: 'PTS',
        }),
      ]);
      const row = await t.prisma.creditNote.findUniqueOrThrow({ where: { id: drafts.creditNote } });
      expect(row.cancelledById).toBe(adminId);
    });

    it('filters on each kind of record, the user and the branch', async () => {
      for (const entity of ['CREDIT_NOTE', 'SUPPLIER_BILL', 'SUPPLIER_PAYMENT', 'EXPENSE']) {
        const r = await auditLog(`&userId=${auditorId}&entity=${entity}`);
        expect(r.entity).toBe(entity);
        expect(r.entries.length).toBeGreaterThan(0);
        expect(r.entries.every((e) => e.entity === entity)).toBe(true);
      }
      const bills = await auditLog(`&userId=${auditorId}&entity=SUPPLIER_BILL&branchId=${pts}`);
      expect(bills.entries).toHaveLength(3);
      // Another user's records are not the auditor's; another branch's user sees none of them.
      const others = await auditLog(`&userId=${financePtsId}&entity=SUPPLIER_PAYMENT`);
      expect(others.entries.some((e) => e.reference === numbers.payment)).toBe(false);
      await get(`/reports/audit-log?${period}&branchId=${pts}`, cookies.managerJed).expect(403);
      const jedView = await auditLog(`&userId=${auditorId}`, cookies.managerJed);
      expect(jedView.entries).toEqual([]);
      const jedBranch = await auditLog(`&branchId=${jed}&entity=EXPENSE`, cookies.managerJed);
      expect(jedBranch.entries.some((e) => e.reference === numbers.expense)).toBe(false);
      // Sales, operations and finance users do not read the audit log.
      await get(`/reports/audit-log?${period}`, cookies.financePts).expect(403);
    });

    it('the records are in the Excel export too', async () => {
      const res = await get(
        `/reports/audit-log/export?${period}&userId=${auditorId}&locale=en`,
        cookies.auditor,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      const values = await workbookValues(res);
      for (const value of [
        numbers.creditNote,
        numbers.bill,
        numbers.payment,
        numbers.expense,
        'Credit note',
        'Supplier bill',
        'Supplier payment',
        'Expense',
        'Billed twice',
        'Cancelled',
        'Posted',
      ]) {
        expect(values).toContain(value);
      }
      const ar = await get(
        `/reports/audit-log/export?${period}&userId=${auditorId}&entity=CREDIT_NOTE&locale=ar`,
        cookies.auditor,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      const arValues = await workbookValues(ar);
      expect(arValues).toContain('إشعار دائن');
      expect(arValues).toContain(numbers.creditNote);
      expect(arValues).not.toContain(numbers.bill);
    });
  });
});
