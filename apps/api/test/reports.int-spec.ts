import type {
  AccountDto,
  ArAgingDto,
  BalanceSheetDto,
  BookingDto,
  CarrierDto,
  CashMovementDto,
  CustomerDto,
  CustomerInvoiceDto,
  GeneralLedgerDto,
  IncomeStatementDto,
  InvoicesReceiptsDto,
  JournalEntryDto,
  OpenAccrualsDto,
  ReceiptDto,
  ReportAccountOptionDto,
  ShipmentProfitabilityDto,
  TripDto,
} from '@nolon/shared';
import ExcelJS from 'exceljs';
import { randomInt, randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
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
import { uniquePhone } from './test-data.js';

/**
 * Financial reports (annex D section 4) against PostgreSQL. Posted entries are never deleted, so
 * the users are LEDGER users and everything is dated in a random year of its own range (1000-1799:
 * the accounting suites use 1901-2000), with its own customer and cash accounts, so the figures
 * of this run are exact. Balance sheet figures are compared year over year for the same reason.
 */
describe('financial reports', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let customer: CustomerDto;
  /** A customer whose only dealing is an unallocated receipt (an advance). */
  let advanceCustomer: CustomerDto;
  let cashAdvance: AccountDto;
  let cashUsd: AccountDto;
  let cashSdg: AccountDto;
  let accounts: Map<string, AccountDto>;
  let carrier: CarrierDto;
  let trip: TripDto;
  const shipments = { s1: '', s2: '', s3: '' };
  const invoices: Record<'i1' | 'i2' | 'i3', CustomerInvoiceDto> = {} as Record<
    'i1' | 'i2' | 'i3',
    CustomerInvoiceDto
  >;
  const receipts: Record<'r1' | 'r2' | 'r3', ReceiptDto> = {} as Record<
    'r1' | 'r2' | 'r3',
    ReceiptDto
  >;
  const year = randomInt(1000, 1800);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const yearQuery = () => `from=${d('01-01')}&to=${d('12-31')}`;
  const cookies = {
    admin: '',
    financePts: '',
    financeJed: '',
    managerPts: '',
    salesPts: '',
    opsPts: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  const account = (code: string): AccountDto => {
    const found = accounts.get(code);
    if (!found) throw new Error(`No account ${code}`);
    return found;
  };

  async function report<T>(path: string, cookie = cookies.financePts): Promise<T> {
    return (await get(path, cookie).expect(200)).body as T;
  }

  async function shipment(destination: string, volumeCbm: string): Promise<string> {
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: await loc('SDPZU'),
        destinationLocationId: await loc(destination),
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm, weightKg: '100' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    return confirmed.shipmentId;
  }

  async function invoice(
    shipmentId: string,
    fields: { currency: string; fxRate?: string; invoiceDate: string; dueDate: string },
    lines: { chargeTypeCode: string; quantity: string; unitPrice: string }[],
    approve = true,
  ): Promise<CustomerInvoiceDto> {
    const draft = (await post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201))
      .body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, { ...fields, lines }).expect(
      200,
    );
    if (!approve) return draft;
    return (await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as CustomerInvoiceDto;
  }

  /** A manual entry in a branch: debit one account, credit another, in USD. */
  async function manualEntry(
    cookie: string,
    branch: string,
    entryDate: string,
    debit: string,
    credit: string,
    amount: string,
    postIt = true,
  ): Promise<JournalEntryDto> {
    const draft = (
      await post('/accounting/journals', cookie, {
        branchId: branch,
        entryDate,
        description: `Report test ${amount}`,
        lines: [
          { accountId: debit, currency: 'USD', debit: amount },
          { accountId: credit, currency: 'USD', credit: amount },
        ],
      }).expect(201)
    ).body as JournalEntryDto;
    if (!postIt) return draft;
    return (await post(`/accounting/journals/${draft.id}/post`, cookie).expect(200))
      .body as JournalEntryDto;
  }

  /** Reads an exported workbook back: every non-empty cell value of every sheet. */
  async function workbookValues(res: Response): Promise<unknown[]> {
    const workbook = new ExcelJS.Workbook();
    // A copy as a plain ArrayBuffer, the type exceljs reads.
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

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger Reports ${year} ${randomUUID().slice(0, 4)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const cash = async (code: string, currency: string) =>
      (
        await post('/accounting/accounts', cookies.admin, {
          code,
          nameEn: `Report test cash ${currency}`,
          nameAr: 'نقدية اختبار التقارير',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency,
          branchId: pts,
        }).expect(201)
      ).body as AccountDto;
    cashUsd = await cash(`R${suffix}U`, 'USD');
    cashSdg = await cash(`R${suffix}S`, 'SDG');
    cashAdvance = await cash(`R${suffix}A`, 'USD');
    const list = (await get('/accounting/accounts', cookies.financePts).expect(200))
      .body as AccountDto[];
    accounts = new Map(list.map((a) => [a.code, a]));
    carrier = (
      await post('/transport/carriers', cookies.opsPts, {
        name: `LG Report Carrier ${suffix}`,
      }).expect(201)
    ).body as CarrierDto;

    // Three shipments of one customer: two to Khartoum (on one carrier trip), one to Atbara.
    shipments.s1 = await shipment('SDKRT', '5');
    shipments.s2 = await shipment('SDKRT', '3');
    shipments.s3 = await shipment('SDATB', '1');

    // Revenue: 1000 + 300 USD, and 600,000 SDG at 600 (1000 USD). A draft invoice posts nothing.
    invoices.i1 = await invoice(
      shipments.s1,
      { currency: 'USD', invoiceDate: d('01-10'), dueDate: d('01-10') },
      [{ chargeTypeCode: 'FREIGHT', quantity: '2', unitPrice: '500' }],
    );
    invoices.i2 = await invoice(
      shipments.s2,
      { currency: 'USD', invoiceDate: d('02-01'), dueDate: d('03-01') },
      [{ chargeTypeCode: 'CUSTOMS', quantity: '1', unitPrice: '300' }],
    );
    invoices.i3 = await invoice(
      shipments.s3,
      { currency: 'SDG', fxRate: '600', invoiceDate: d('02-10'), dueDate: d('02-10') },
      [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '600000' }],
    );
    await invoice(
      shipments.s3,
      { currency: 'USD', invoiceDate: d('02-11'), dueDate: d('02-11') },
      [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '5555' }],
      false,
    );

    // Receipts: 400 USD on I1; 300,000 SDG at 500 (600 USD) on I3, clearing 500 USD at the
    // invoice rate: a realized gain of 100; 100 USD on I2, cancelled later (today).
    const receipt = async (body: object) =>
      (
        await post('/receipts', cookies.financePts, { customerId: customer.id, ...body }).expect(
          201,
        )
      ).body as ReceiptDto;
    receipts.r1 = await receipt({
      receiptDate: d('02-15'),
      currency: 'USD',
      amount: '400',
      cashAccountId: cashUsd.id,
      allocations: [{ invoiceId: invoices.i1.id, amount: '400' }],
    });
    receipts.r2 = await receipt({
      receiptDate: d('03-05'),
      currency: 'SDG',
      fxRate: '500',
      amount: '300000',
      cashAccountId: cashSdg.id,
      allocations: [{ invoiceId: invoices.i3.id, amount: '300000' }],
    });
    receipts.r3 = await receipt({
      receiptDate: d('03-20'),
      currency: 'USD',
      amount: '100',
      cashAccountId: cashUsd.id,
      allocations: [{ invoiceId: invoices.i2.id, amount: '100' }],
    });
    await post(`/receipts/${receipts.r3.id}/cancel`, cookies.financePts, {
      reason: 'Bounced',
    }).expect(200);

    // An advance: 70 USD received from another customer, allocated to nothing.
    advanceCustomer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger Advance ${year} ${randomUUID().slice(0, 4)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    await post('/receipts', cookies.financePts, {
      customerId: advanceCustomer.id,
      receiptDate: d('03-25'),
      currency: 'USD',
      amount: '70',
      cashAccountId: cashAdvance.id,
      allocations: [],
    }).expect(201);

    // Cost: an external carrier trip of 400 USD for S1 and S2, shared by volume (250 / 150),
    // completed on 20 February: accrued transport costs (rule 11).
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    trip = (
      await post('/trips', cookies.opsPts, {
        branchId: pts,
        kind: 'EXTERNAL',
        carrierId: carrier.id,
        agreedCost: '400',
        currency: 'USD',
        originLocationId: await loc('SDPZU'),
        destinationLocationId: await loc('SDKRT'),
        shipmentIds: [shipments.s1, shipments.s2],
      }).expect(201)
    ).body as TripDto;
    const planned = new Date(`${d('02-17')}T08:00:00+03:00`);
    await t.prisma.trip.update({ where: { id: trip.id }, data: { createdAt: planned } });
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: { in: [shipments.s1, shipments.s2] } },
      data: { occurredAt: planned },
    });
    for (const [status, day] of [
      ['DEPARTED', '02-18'],
      ['ARRIVED', '02-19'],
      ['COMPLETED', '02-20'],
    ] as const) {
      trip = (
        await post(`/trips/${trip.id}/status`, cookies.opsPts, {
          status,
          occurredAt: `${d(day)}T08:00:00+03:00`,
        }).expect(200)
      ).body as TripDto;
    }

    // A posted general expense of 50 from the USD cash; a draft of 999 that must not count.
    await manualEntry(cookies.financePts, pts, d('03-10'), account('6100').id, cashUsd.id, '50');
    await manualEntry(
      cookies.financePts,
      pts,
      d('03-11'),
      account('6100').id,
      cashUsd.id,
      '999',
      false,
    );
    // Another branch's revenue, which PTS reports never show.
    await manualEntry(
      cookies.financeJed,
      jed,
      d('03-01'),
      account('6100').id,
      account('4100').id,
      '777',
    );
  });

  afterAll(async () => {
    await t.close();
  });

  describe('income statement', () => {
    it('adds posted revenue and expenses of the period, per account, in the branch', async () => {
      const r = await report<IncomeStatementDto>(
        `/reports/income-statement?${yearQuery()}&branchId=${pts}`,
      );
      expect(r.branches.map((b) => b.id)).toEqual([pts]);
      const byCode = (rows: IncomeStatementDto['revenue']) =>
        Object.fromEntries(rows.map((row) => [row.code, row.total]));
      expect(byCode(r.revenue)).toEqual({ '4100': '2000', '4200': '300', '4900': '100' });
      // 5100: the accrued trip cost; 6100: the posted manual entry (not the draft, not JED's).
      expect(byCode(r.expenses)).toEqual({ '5100': '400', '6100': '50' });
      expect(r.totalRevenue).toEqual({ byBranch: ['2400'], total: '2400' });
      expect(r.totalExpenses).toEqual({ byBranch: ['450'], total: '450' });
      expect(r.netIncome).toEqual({ byBranch: ['1950'], total: '1950' });
    });

    it('a period before the entries is empty; all branches show one column each', async () => {
      const early = await report<IncomeStatementDto>(
        `/reports/income-statement?from=${d('01-01')}&to=${d('01-09')}&branchId=${pts}`,
      );
      expect(early.revenue).toEqual([]);
      expect(early.netIncome.total).toBe('0');

      const all = await report<IncomeStatementDto>(
        `/reports/income-statement?${yearQuery()}`,
        cookies.admin,
      );
      const ptsColumn = all.branches.findIndex((b) => b.id === pts);
      const jedColumn = all.branches.findIndex((b) => b.id === jed);
      const freight = all.revenue.find((row) => row.code === '4100');
      expect(freight?.byBranch[ptsColumn]).toBe('2000');
      expect(freight?.byBranch[jedColumn]).toBe('777');
    });

    it('JED finance sees JED only; another branch is 403; Sales has no access', async () => {
      const own = await report<IncomeStatementDto>(
        `/reports/income-statement?${yearQuery()}`,
        cookies.financeJed,
      );
      expect(own.branches.map((b) => b.id)).toEqual([jed]);
      expect(own.revenue.map((row) => [row.code, row.total])).toEqual([['4100', '777']]);
      await get(
        `/reports/income-statement?${yearQuery()}&branchId=${pts}`,
        cookies.financeJed,
      ).expect(403);
      await get(`/reports/income-statement?${yearQuery()}`, cookies.salesPts).expect(403);
      await get(
        `/reports/income-statement?from=${d('02-01')}&to=${d('01-01')}`,
        cookies.financePts,
      ).expect(400);
    });
  });

  describe('balance sheet', () => {
    it('moves by the year’s entries and balances', async () => {
      const at = async (asOf: string) =>
        report<BalanceSheetDto>(`/reports/balance-sheet?asOf=${asOf}&branchId=${pts}`);
      const [before, after] = await Promise.all([at(`${year - 1}-12-31`), at(d('12-31'))]);
      expect(after.balanced).toBe(true);
      const change = (pick: (r: BalanceSheetDto) => string) =>
        new Prisma.Decimal(pick(after)).minus(pick(before)).toFixed();
      const row = (rows: BalanceSheetDto['assets'], code: string) =>
        rows.find((x) => x.code === code)?.balanceUsd ?? '0';
      expect(change((r) => row(r.assets, '1200'))).toBe('1300');
      expect(row(after.assets, cashUsd.code)).toBe('450');
      expect(row(after.assets, cashSdg.code)).toBe('600');
      expect(change((r) => row(r.liabilities, '2300'))).toBe('400');
      expect(change((r) => r.totalAssetsUsd)).toBe('2420');
      expect(change((r) => r.totalLiabilitiesUsd)).toBe('470');
      expect(change((r) => row(r.liabilities, '2200'))).toBe('70');
      expect(change((r) => r.unclosedEarningsUsd)).toBe('1950');
      expect(change((r) => r.totalEquityUsd)).toBe('1950');
    });

    it('is scoped to the user’s branches', async () => {
      const jedView = await report<BalanceSheetDto>(
        `/reports/balance-sheet?asOf=${d('12-31')}`,
        cookies.financeJed,
      );
      expect(jedView.assets.map((r) => r.code)).not.toContain(cashUsd.code);
      await get(
        `/reports/balance-sheet?asOf=${d('12-31')}&branchId=${pts}`,
        cookies.financeJed,
      ).expect(403);
      await get(`/reports/balance-sheet?asOf=${d('12-31')}`, cookies.opsPts).expect(403);
    });
  });

  describe('general ledger', () => {
    it('opening balance, posted lines and a running balance per account', async () => {
      const r = await report<GeneralLedgerDto>(
        `/reports/general-ledger?from=${d('02-16')}&to=${d('12-31')}&branchId=${pts}` +
          `&accountIds=${cashUsd.id},${cashSdg.id}`,
      );
      const usd = r.accounts.find((a) => a.accountId === cashUsd.id);
      const sdg = r.accounts.find((a) => a.accountId === cashSdg.id);
      expect(usd).toMatchObject({ code: cashUsd.code, openingUsd: '400', closingUsd: '450' });
      // R3 in, the manual 50 out; the 999 draft is not a line.
      expect(usd?.lines.map((l) => [l.entryDate, l.debitUsd, l.creditUsd, l.balanceUsd])).toEqual([
        [d('03-10'), '0', '50', '350'],
        [d('03-20'), '100', '0', '450'],
      ]);
      expect(sdg).toMatchObject({ code: cashSdg.code, openingUsd: '0', closingUsd: '600' });
      expect(sdg?.lines).toHaveLength(1);
      expect(sdg?.lines[0]).toMatchObject({
        entryDate: d('03-05'),
        currency: 'SDG',
        debit: '300000',
        debitUsd: '600',
        balanceUsd: '600',
        source: 'RECEIPT',
        branchCode: 'PTS',
      });
    });

    it('offers the postable accounts to report users who cannot read the chart', async () => {
      const options = await report<ReportAccountOptionDto[]>(
        '/reports/accounts',
        cookies.managerPts,
      );
      expect(options.find((a) => a.accountId === cashUsd.id)).toMatchObject({
        code: cashUsd.code,
        isCash: true,
        type: 'ASSET',
      });
      expect(options.map((a) => a.code)).not.toContain('1000');
      await get('/accounting/accounts', cookies.managerPts).expect(403);
      await get('/reports/accounts', cookies.salesPts).expect(403);
    });

    it('another branch sees no lines; unknown accounts are 404; Sales is 403', async () => {
      // A PTS cash account is PTS's: for JED it is as unknown as a random id.
      await get(
        `/reports/general-ledger?${yearQuery()}&accountIds=${cashUsd.id}`,
        cookies.financeJed,
      ).expect(404);
      const jedView = await report<GeneralLedgerDto>(
        `/reports/general-ledger?${yearQuery()}&accountIds=${account('1200').id}`,
        cookies.financeJed,
      );
      expect(jedView.accounts[0]?.lines.map((l) => l.branchCode)).not.toContain('PTS');
      await get(
        `/reports/general-ledger?${yearQuery()}&accountIds=${randomUUID()}`,
        cookies.financePts,
      ).expect(404);
      await get(`/reports/general-ledger?${yearQuery()}&accountIds=x`, cookies.financePts).expect(
        400,
      );
      await get(
        `/reports/general-ledger?${yearQuery()}&accountIds=${cashUsd.id}`,
        cookies.salesPts,
      ).expect(403);
    });
  });

  describe('AR aging', () => {
    it('buckets what each invoice still owes as of the date', async () => {
      const r = await report<ArAgingDto>(
        `/reports/ar-aging?asOf=${d('03-31')}&branchId=${pts}&customerId=${customer.id}`,
      );
      expect(r.invoices.map((i) => [i.number, i.outstanding, i.outstandingUsd, i.bucket])).toEqual([
        [invoices.i1.number, '600', '600', 'days61to90'],
        [invoices.i3.number, '300000', '500', 'days31to60'],
        [invoices.i2.number, '200', '200', 'days1to30'],
      ]);
      expect(r.invoices.find((i) => i.number === invoices.i2.number)?.daysPastDue).toBe(30);
      expect(r.customers).toHaveLength(1);
      expect(r.totals).toEqual({
        current: '0',
        days1to30: '200',
        days31to60: '500',
        days61to90: '600',
        over90: '0',
        total: '1300',
      });
      expect(r.customers[0]).toMatchObject({ advancesUsd: '0', netUsd: '1300' });
      expect(r).toMatchObject({ totalAdvancesUsd: '0', netUsd: '1300' });
    });

    it('shows unapplied advances and nets them, also for a customer with only an advance', async () => {
      const before = await report<ArAgingDto>(
        `/reports/ar-aging?asOf=${d('03-24')}&customerId=${advanceCustomer.id}`,
      );
      expect(before.customers).toEqual([]);
      const r = await report<ArAgingDto>(
        `/reports/ar-aging?asOf=${d('03-31')}&branchId=${pts}&customerId=${advanceCustomer.id}`,
      );
      expect(r.invoices).toEqual([]);
      expect(r.customers).toEqual([
        {
          customerId: advanceCustomer.id,
          customerName: advanceCustomer.name,
          amounts: {
            current: '0',
            days1to30: '0',
            days31to60: '0',
            days61to90: '0',
            over90: '0',
            total: '0',
          },
          advancesUsd: '70',
          netUsd: '-70',
        },
      ]);
      expect(r).toMatchObject({ totalAdvancesUsd: '70', netUsd: '-70' });
      const jedView = await report<ArAgingDto>(
        `/reports/ar-aging?asOf=${d('03-31')}&customerId=${advanceCustomer.id}`,
        cookies.financeJed,
      );
      expect(jedView.customers).toEqual([]);
    });

    it('receipts count from their date and stop counting once cancelled', async () => {
      const early = await report<ArAgingDto>(
        `/reports/ar-aging?asOf=${d('02-28')}&customerId=${customer.id}`,
      );
      expect(early.invoices.map((i) => [i.number, i.outstandingUsd, i.bucket])).toEqual([
        [invoices.i1.number, '600', 'days31to60'],
        [invoices.i3.number, '1000', 'days1to30'],
        [invoices.i2.number, '300', 'current'],
      ]);
      // Far in the future, R3's cancellation (dated today) has given I2 its 100 back.
      const later = await report<ArAgingDto>(
        `/reports/ar-aging?asOf=2999-12-31&customerId=${customer.id}`,
      );
      expect(later.invoices.find((i) => i.number === invoices.i2.number)?.outstandingUsd).toBe(
        '300',
      );
      expect(later.totals).toMatchObject({ over90: '1400', total: '1400' });
    });

    it('is empty for another branch; 403 for its branch or without permission', async () => {
      const jedView = await report<ArAgingDto>(
        `/reports/ar-aging?asOf=${d('12-31')}&customerId=${customer.id}`,
        cookies.financeJed,
      );
      expect(jedView.invoices).toEqual([]);
      expect(jedView.totals.total).toBe('0');
      await get(`/reports/ar-aging?asOf=${d('12-31')}&branchId=${pts}`, cookies.financeJed).expect(
        403,
      );
      await get(`/reports/ar-aging?asOf=${d('12-31')}`, cookies.salesPts).expect(403);
    });
  });

  describe('shipment profitability', () => {
    it('revenue, cost and margin per shipment, customer and route', async () => {
      const r = await report<ShipmentProfitabilityDto>(
        `/reports/shipment-profitability?${yearQuery()}&branchId=${pts}&customerId=${customer.id}`,
        cookies.managerPts,
      );
      const byId = Object.fromEntries(
        r.shipments.map((s) => [
          s.shipmentId,
          [s.revenueUsd, s.costUsd, s.marginUsd, s.marginPercent],
        ]),
      );
      expect(byId).toEqual({
        [shipments.s1]: ['1000', '250', '750', '75'],
        [shipments.s2]: ['300', '150', '150', '50'],
        [shipments.s3]: ['1000', '0', '1000', '100'],
      });
      expect(r.customers).toEqual([
        {
          customerId: customer.id,
          customerName: customer.name,
          shipments: 3,
          revenueUsd: '2300',
          costUsd: '400',
          marginUsd: '1900',
          marginPercent: '82.61',
        },
      ]);
      expect(
        r.routes.map((x) => [x.origin.code, x.destination.code, x.shipments, x.marginUsd]),
      ).toEqual([
        ['SDPZU', 'SDATB', 1, '1000'],
        ['SDPZU', 'SDKRT', 2, '900'],
      ]);
      expect(r.totals).toEqual({
        revenueUsd: '2300',
        costUsd: '400',
        marginUsd: '1900',
        marginPercent: '82.61',
      });
    });

    it('is empty for another branch; needs its own permission', async () => {
      const jedView = await report<ShipmentProfitabilityDto>(
        `/reports/shipment-profitability?${yearQuery()}&customerId=${customer.id}`,
        cookies.financeJed,
      );
      expect(jedView.shipments).toEqual([]);
      await get(
        `/reports/shipment-profitability?${yearQuery()}&branchId=${pts}`,
        cookies.financeJed,
      ).expect(403);
      await get(`/reports/shipment-profitability?${yearQuery()}`, cookies.opsPts).expect(403);
      await get(`/reports/shipment-profitability?${yearQuery()}`, cookies.salesPts).expect(403);
    });
  });

  describe('invoices and receipts', () => {
    it('lists approved invoices and receipts of the period', async () => {
      const r = await report<InvoicesReceiptsDto>(
        `/reports/invoices-receipts?${yearQuery()}&customerId=${customer.id}`,
      );
      expect(r.invoices.map((i) => [i.number, i.currency, i.total, i.totalUsd])).toEqual([
        [invoices.i1.number, 'USD', '1000', '1000'],
        [invoices.i2.number, 'USD', '300', '300'],
        [invoices.i3.number, 'SDG', '600000', '1000'],
      ]);
      expect(r.receipts.map((x) => [x.number, x.amount, x.amountUsd, x.status])).toEqual([
        [receipts.r1.number, '400', '400', 'POSTED'],
        [receipts.r2.number, '300000', '600', 'POSTED'],
        // Cancelled today, after this period: it still counts in it.
        [receipts.r3.number, '100', '100', 'POSTED'],
      ]);
      expect(r.totalInvoicedUsd).toBe('2300');
      expect(r.totalReceivedUsd).toBe('1100');
    });

    it('a receipt cancelled within the period is marked and left out of the total', async () => {
      const r = await report<InvoicesReceiptsDto>(
        `/reports/invoices-receipts?from=${d('01-01')}&to=2999-12-31&customerId=${customer.id}`,
      );
      expect(r.receipts.find((x) => x.receiptId === receipts.r3.id)?.status).toBe('CANCELLED');
      expect(r.totalReceivedUsd).toBe('1000');
    });

    it('is empty for another branch; 403 for its branch or without permission', async () => {
      const jedView = await report<InvoicesReceiptsDto>(
        `/reports/invoices-receipts?${yearQuery()}&customerId=${customer.id}`,
        cookies.financeJed,
      );
      expect(jedView).toMatchObject({ invoices: [], receipts: [], totalInvoicedUsd: '0' });
      await get(
        `/reports/invoices-receipts?${yearQuery()}&branchId=${pts}`,
        cookies.financeJed,
      ).expect(403);
      await get(`/reports/invoices-receipts?${yearQuery()}`, cookies.salesPts).expect(403);
    });
  });

  describe('cash and bank movement', () => {
    it('opening, in, out and closing per cash account, and the realized FX', async () => {
      const usd = await report<CashMovementDto>(
        `/reports/cash-movement?${yearQuery()}&branchId=${pts}&accountId=${cashUsd.id}`,
      );
      expect(usd.accounts).toEqual([
        expect.objectContaining({
          code: cashUsd.code,
          currency: 'USD',
          opening: '0',
          inflow: '500',
          outflow: '50',
          closing: '450',
          closingUsd: '450',
        }),
      ]);
      const sdg = await report<CashMovementDto>(
        `/reports/cash-movement?from=${d('03-01')}&to=${d('12-31')}&accountId=${cashSdg.id}`,
      );
      expect(sdg.accounts[0]).toMatchObject({
        opening: '0',
        inflow: '300000',
        closing: '300000',
        inflowUsd: '600',
        closingUsd: '600',
      });
      expect(sdg.fx).toMatchObject({ gainUsd: '100', lossUsd: '0', netUsd: '100' });
      // The FX section follows the chosen account: no difference on receipts into the USD cash.
      expect(usd.fx).toEqual({ gainUsd: '0', lossUsd: '0', netUsd: '0', lines: [] });
      expect(sdg.fx.lines).toEqual([
        expect.objectContaining({ entryDate: d('03-05'), amountUsd: '100', branchCode: 'PTS' }),
      ]);
      // Not a cash account: 404.
      await get(
        `/reports/cash-movement?${yearQuery()}&accountId=${account('1200').id}`,
        cookies.financePts,
      ).expect(404);
    });

    it('another branch sees nothing of PTS cash; 403 for its branch or without permission', async () => {
      await get(
        `/reports/cash-movement?${yearQuery()}&accountId=${cashUsd.id}`,
        cookies.financeJed,
      ).expect(404);
      const jedView = await report<CashMovementDto>(
        `/reports/cash-movement?${yearQuery()}`,
        cookies.financeJed,
      );
      expect(jedView.accounts.map((a) => a.accountId)).not.toContain(cashUsd.id);
      expect(jedView.fx.lines.map((l) => l.branchCode)).not.toContain('PTS');
      await get(`/reports/cash-movement?${yearQuery()}&branchId=${pts}`, cookies.financeJed).expect(
        403,
      );
      await get(`/reports/cash-movement?${yearQuery()}`, cookies.salesPts).expect(403);
    });
  });

  describe('open accruals', () => {
    it('lists the completed carrier trip until its accrual is cleared', async () => {
      const before = await report<OpenAccrualsDto>(
        `/reports/open-accruals?asOf=${d('02-19')}&branchId=${pts}`,
      );
      expect(before.trips.map((x) => x.tripId)).not.toContain(trip.id);
      const after = await report<OpenAccrualsDto>(
        `/reports/open-accruals?asOf=${d('12-31')}&branchId=${pts}`,
      );
      expect(after.accruedAccount?.code).toBe('2300');
      expect(after.clearingAccount?.code).toBe('1400');
      expect(after.trips.find((x) => x.tripId === trip.id)).toEqual({
        tripId: trip.id,
        tripNumber: trip.number,
        branchCode: 'PTS',
        carrierName: carrier.name,
        completedAt: d('02-20'),
        currency: 'USD',
        balance: '400',
        balanceUsd: '400',
      });
      expect(new Prisma.Decimal(after.tripsTotalUsd).plus(after.otherAccruedUsd).toFixed()).toBe(
        after.accruedTotalUsd,
      );
    });

    it('another branch does not see the trip; 403 for its branch or without permission', async () => {
      const jedView = await report<OpenAccrualsDto>(
        `/reports/open-accruals?asOf=${d('12-31')}`,
        cookies.financeJed,
      );
      expect(jedView.trips.map((x) => x.tripId)).not.toContain(trip.id);
      await get(
        `/reports/open-accruals?asOf=${d('12-31')}&branchId=${pts}`,
        cookies.financeJed,
      ).expect(403);
      await get(`/reports/open-accruals?asOf=${d('12-31')}`, cookies.salesPts).expect(403);
    });
  });

  describe('accounts of other branches', () => {
    it('another branch’s cash account is not offered and is 404 in the reports', async () => {
      const dxbCash = (
        await post('/accounting/accounts', cookies.admin, {
          code: `R${randomUUID().slice(0, 6).toUpperCase()}D`,
          nameEn: 'Report test cash DXB',
          nameAr: 'نقدية اختبار دبي',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency: 'AED',
          branchId: await branchId(t.prisma, 'DXB'),
        }).expect(201)
      ).body as AccountDto;
      const jedList = await report<ReportAccountOptionDto[]>(
        '/reports/accounts',
        cookies.financeJed,
      );
      const ids = jedList.map((a) => a.accountId);
      expect(ids).not.toContain(dxbCash.id);
      expect(ids).toContain(account('1200').id);
      const adminList = await report<ReportAccountOptionDto[]>('/reports/accounts', cookies.admin);
      expect(adminList.map((a) => a.accountId)).toContain(dxbCash.id);
      await get(
        `/reports/cash-movement?${yearQuery()}&accountId=${dxbCash.id}`,
        cookies.financeJed,
      ).expect(404);
      await get(
        `/reports/general-ledger?${yearQuery()}&accountIds=${dxbCash.id}`,
        cookies.financeJed,
      ).expect(404);
      await get(
        `/reports/cash-movement?${yearQuery()}&accountId=${dxbCash.id}`,
        cookies.admin,
      ).expect(200);
    });
  });

  describe('history survives a remap of the posting roles', () => {
    it('open accruals and realized FX keep the accounts they were posted to', async () => {
      const suffix = randomUUID().slice(0, 6).toUpperCase();
      const newAccount = async (code: string, type: string) =>
        (
          await post('/accounting/accounts', cookies.admin, {
            code,
            nameEn: `Report remap ${type}`,
            nameAr: 'حساب اختبار إعادة الربط',
            type,
            isPostable: true,
          }).expect(201)
        ).body as AccountDto;
      const accrued = await newAccount(`R${suffix}L`, 'LIABILITY');
      const gain = await newAccount(`R${suffix}G`, 'REVENUE');
      const map = (role: string, accountId: string) =>
        t
          .http()
          .put(`/api/v1/accounting/settings/mappings/${role}`)
          .set('Origin', APP_ORIGIN)
          .set('Cookie', cookies.admin)
          .send({ accountId })
          .expect(200);
      await map('ACCRUED_TRANSPORT', accrued.id);
      await map('FX_GAIN', gain.id);
      try {
        const accruals = await report<OpenAccrualsDto>(
          `/reports/open-accruals?asOf=${d('12-31')}&branchId=${pts}`,
        );
        expect(accruals.accruedAccount?.code).toBe(accrued.code);
        expect(accruals.trips.find((x) => x.tripId === trip.id)?.balanceUsd).toBe('400');
        const cash = await report<CashMovementDto>(
          `/reports/cash-movement?${yearQuery()}&accountId=${cashSdg.id}`,
        );
        expect(cash.fx).toMatchObject({ gainUsd: '100', netUsd: '100' });
      } finally {
        await map('ACCRUED_TRANSPORT', account('2300').id);
        await map('FX_GAIN', account('4900').id);
      }
    });
  });

  describe('Excel export', () => {
    it('downloads an .xlsx with the request language’s headers and numeric amounts', async () => {
      const res = await get(
        `/reports/income-statement/export?${yearQuery()}&branchId=${pts}&locale=en`,
        cookies.financePts,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(res.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="income-statement-${d('01-01')}_${d('12-31')}.xlsx"`,
      );
      const values = await workbookValues(res);
      expect(values).toContain('Income statement');
      expect(values).toContain('Net income');
      expect(values).toContain('PTS');
      expect(values).toContain(2000);
      expect(values).toContain(1950);

      const arabic = await get(
        `/reports/income-statement/export?${yearQuery()}&branchId=${pts}&locale=ar`,
        cookies.financePts,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      const arabicValues = await workbookValues(arabic);
      expect(arabicValues).toContain('قائمة الدخل');
      expect(arabicValues).toContain('صافي الدخل');
      expect(arabicValues).toContain(1950);
    });

    it('exports every report', async () => {
      const paths = [
        `/reports/trial-balance/export?asOf=${d('12-31')}&branchId=${pts}`,
        `/reports/balance-sheet/export?asOf=${d('12-31')}&branchId=${pts}`,
        `/reports/general-ledger/export?${yearQuery()}&accountIds=${cashSdg.id}`,
        `/reports/ar-aging/export?asOf=${d('03-31')}&customerId=${customer.id}`,
        `/reports/shipment-profitability/export?${yearQuery()}&customerId=${customer.id}`,
        `/reports/invoices-receipts/export?${yearQuery()}&customerId=${customer.id}`,
        `/reports/cash-movement/export?${yearQuery()}&accountId=${cashSdg.id}`,
        `/reports/open-accruals/export?asOf=${d('12-31')}&branchId=${pts}`,
      ];
      const expected = [null, 600, 300000, 1300, 750, 2300, 300000, 400];
      for (const [i, path] of paths.entries()) {
        const res = await get(`${path}&locale=en`, cookies.admin)
          .buffer(true)
          .parse(binary)
          .expect(200);
        expect(res.headers['content-type']).toContain('spreadsheetml');
        const amount = expected[i];
        if (amount !== null && amount !== undefined) {
          expect(await workbookValues(res)).toContain(amount);
        }
      }
    });

    it('exports are scoped and permissioned like the reports', async () => {
      await get(
        `/reports/income-statement/export?${yearQuery()}&branchId=${pts}`,
        cookies.financeJed,
      ).expect(403);
      await get(`/reports/income-statement/export?${yearQuery()}`, cookies.salesPts).expect(403);
      await get(`/reports/shipment-profitability/export?${yearQuery()}`, cookies.opsPts).expect(
        403,
      );
      const jedExport = await get(
        `/reports/ar-aging/export?asOf=${d('03-31')}&customerId=${customer.id}&locale=en`,
        cookies.financeJed,
      )
        .buffer(true)
        .parse(binary)
        .expect(200);
      const values = await workbookValues(jedExport);
      expect(values).not.toContain(invoices.i1.number);
      expect(values).not.toContain(1300);
    });
  });
});
