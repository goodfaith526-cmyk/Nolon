import type {
  AccountDto,
  ArAgingDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  CustomerStatementDto,
  JournalEntryDto,
  ReceiptApplicableInvoiceDto,
  ReceiptDto,
} from '@nolon/shared';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dec } from '../src/common/money.js';
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
 * Applying a receipt's advance to a later invoice, and reversing that (decision z6), against
 * PostgreSQL. Posted entries are never deleted, so the users are LEDGER users, the customers and
 * cash accounts are this run's own, and documents are dated in a random year of this suite's
 * range (1001-1800, shared only with suites that close no period). Reversals are dated today
 * (the API dates them so).
 */
describe('receipt advance applications', () => {
  let t: TestApp;
  let pts: string;
  let customer: CustomerDto;
  let other: CustomerDto;
  let cashUsd: AccountDto;
  let cashSdg: AccountDto;
  const year = String(randomInt(1001, 1801)).padStart(4, '0');
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const cookies = { admin: '', financePts: '', financeJed: '', salesPts: '' };

  const get = (path: string, cookie = cookies.financePts) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  async function shipment(customerId: string): Promise<string> {
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId,
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
    customerId = customer.id,
  ): Promise<CustomerInvoiceDto> {
    const draft = (
      await post('/customer-invoices', cookies.financePts, {
        shipmentId: await shipment(customerId),
      }).expect(201)
    ).body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      ...fields,
      repriced: true,
      dueDate: fields.invoiceDate,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice }],
    }).expect(200);
    return (await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as CustomerInvoiceDto;
  }

  async function newCustomer(name: string): Promise<CustomerDto> {
    return (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `${name} ${year} ${randomUUID().slice(0, 6)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
  }

  /** A receipt with nothing allocated: all of it is held as an advance. */
  async function advance(
    amount: string,
    receiptDate: string,
    currency = 'USD',
    fxRate?: string,
  ): Promise<ReceiptDto> {
    return (
      await post('/receipts', cookies.financePts, {
        customerId: customer.id,
        receiptDate,
        currency,
        ...(fxRate ? { fxRate } : {}),
        amount,
        cashAccountId: currency === 'USD' ? cashUsd.id : cashSdg.id,
        allocations: [],
      }).expect(201)
    ).body as ReceiptDto;
  }

  const applyBody = (invoiceId: string, amount: string, applicationDate: string) => ({
    requestId: randomUUID(),
    invoiceId,
    amount,
    applicationDate,
  });

  async function apply(receiptId: string, body: object, cookie = cookies.financePts) {
    return (await post(`/receipts/${receiptId}/applications`, cookie, body).expect(200))
      .body as ReceiptDto;
  }

  const journal = async (id: string) =>
    (await get(`/accounting/journals/${id}`).expect(200)).body as JournalEntryDto;
  const invoiceNow = async (id: string) =>
    (await get(`/customer-invoices/${id}`).expect(200)).body as CustomerInvoiceDto;
  const aging = async (asOf: string) =>
    (await get(`/reports/ar-aging?asOf=${asOf}&customerId=${customer.id}`).expect(200))
      .body as ArAgingDto;
  const balanced = (e: JournalEntryDto) => {
    const debit = e.lines.reduce((s, l) => s.plus(l.debitUsd), dec(0));
    const credit = e.lines.reduce((s, l) => s.plus(l.creditUsd), dec(0));
    return debit.eq(credit);
  };
  /** USD advances of the customer as of a date, less `minus`, as the API writes it. */
  const advancesLess = (r: ArAgingDto, minus: string) =>
    dec(r.totalAdvancesUsd).minus(minus).toFixed();

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    customer = await newCustomer('Advance');
    other = await newCustomer('Advance Other');
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const cash = async (code: string, currency: string) =>
      (
        await post('/accounting/accounts', cookies.admin, {
          code,
          nameEn: `Advance test cash ${currency}`,
          nameAr: 'نقدية اختبار الدفعة المقدمة',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency,
          branchId: pts,
        }).expect(201)
      ).body as AccountDto;
    cashUsd = await cash(`A${suffix}U`, 'USD');
    cashSdg = await cash(`A${suffix}S`, 'SDG');
  });

  afterAll(async () => {
    await t.close();
  });

  describe('a USD advance applied to a later USD invoice', () => {
    let receipt: ReceiptDto;
    let inv: CustomerInvoiceDto;
    let firstBody: ReturnType<typeof applyBody>;
    let applied: ReceiptDto;

    beforeAll(async () => {
      receipt = await advance('500', d('01-05'));
      inv = await invoice({ currency: 'USD', invoiceDate: d('01-20') }, '1000');
      firstBody = applyBody(inv.id, '400', d('02-10'));
    });

    it('lists the open invoices of the same customer, branch and currency', async () => {
      const elsewhere = [
        (await invoice({ currency: 'USD', invoiceDate: d('01-21') }, '50', other.id)).id,
        (await invoice({ currency: 'SDG', fxRate: '600', invoiceDate: d('01-21') }, '600')).id,
      ];
      const list = (await get(`/receipts/${receipt.id}/applicable-invoices`).expect(200))
        .body as ReceiptApplicableInvoiceDto[];
      expect(list.map((i) => [i.invoiceId, i.balance])).toContainEqual([inv.id, '1000']);
      expect(list.filter((i) => elsewhere.includes(i.invoiceId))).toEqual([]);
      expect(receipt.actions).toMatchObject({ canApply: true, canCancel: true });
    });

    it('posts a balanced reclass entry and pays the invoice by the amount', async () => {
      const before = await aging(d('02-09'));
      applied = await apply(receipt.id, firstBody);
      expect(applied).toMatchObject({ allocated: '0', applied: '400', unallocated: '100' });
      expect(applied.applications).toHaveLength(1);
      const [a] = applied.applications;
      expect(a).toMatchObject({
        id: firstBody.requestId,
        invoiceId: inv.id,
        amount: '400',
        advanceUsd: '400',
        relievedUsd: '400',
        status: 'ACTIVE',
        applicationDate: d('02-10'),
      });
      const entry = await journal(a?.journalEntryId ?? '');
      expect(entry).toMatchObject({
        status: 'POSTED',
        source: 'RECEIPT_APPLICATION',
        sourceId: firstBody.requestId,
        sourceNumber: receipt.number,
        entryDate: d('02-10'),
      });
      expect(balanced(entry)).toBe(true);
      expect(entry.lines.map((l) => [l.description, l.debit, l.credit, l.customerId])).toEqual([
        [receipt.number, '400', '0', customer.id],
        [inv.number, '0', '400', customer.id],
      ]);
      // The advance is debited on the account the receipt credited; the receivable credited is
      // the one the invoice debited.
      const receiptEntry = await journal(receipt.journalEntryId);
      const advanceLine = receiptEntry.lines.find((l) => l.description === 'Advance');
      expect(entry.lines[0]?.accountId).toBe(advanceLine?.accountId);
      const invoiceEntry = await journal(inv.journalEntryId ?? '');
      expect(entry.lines[1]?.accountId).toBe(invoiceEntry.lines[0]?.accountId);

      const after = await invoiceNow(inv.id);
      expect(after).toMatchObject({ paidAmount: '400', balance: '600', paymentStatus: 'PARTIAL' });
      expect(after.payments).toContainEqual(
        expect.objectContaining({
          receiptId: receipt.id,
          applicationId: firstBody.requestId,
          amount: '400',
          cancelled: false,
        }),
      );

      // Reports: the advance drops and the invoice's aging drops, from the application's date.
      const now = await aging(d('02-10'));
      expect(now.totalAdvancesUsd).toBe(advancesLess(before, '400'));
      const owed = (r: ArAgingDto) => r.invoices.find((i) => i.invoiceId === inv.id)?.outstanding;
      expect(owed(before)).toBe('1000');
      expect(owed(now)).toBe('600');
    });

    it('returns the same receipt for a retry with the same request id, posting nothing more', async () => {
      const entries = await t.prisma.journalEntry.count({
        where: { source: 'RECEIPT_APPLICATION' },
      });
      const again = await apply(receipt.id, firstBody);
      expect(again.applications).toHaveLength(1);
      expect(again.unallocated).toBe('100');
      expect(await t.prisma.journalEntry.count({ where: { source: 'RECEIPT_APPLICATION' } })).toBe(
        entries,
      );
      await post(`/receipts/${receipt.id}/applications`, cookies.financePts, {
        ...firstBody,
        amount: '50',
      }).expect(409);
    });

    it('refuses more than the advance still held', async () => {
      const res = await post(
        `/receipts/${receipt.id}/applications`,
        cookies.financePts,
        applyBody(inv.id, '100.01', d('02-11')),
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain('Only 100 USD');
    });

    it('is refused without the receipts write permission, or outside the branch', async () => {
      await post(
        `/receipts/${receipt.id}/applications`,
        cookies.salesPts,
        applyBody(inv.id, '10', d('02-11')),
      ).expect(403);
      await get(`/receipts/${receipt.id}/applicable-invoices`, cookies.salesPts).expect(403);
      await post(
        `/receipts/${receipt.id}/applications`,
        cookies.financeJed,
        applyBody(inv.id, '10', d('02-11')),
      ).expect(404);
      await get(`/receipts/${receipt.id}/applicable-invoices`, cookies.financeJed).expect(404);
      const id = applied.applications[0]?.id ?? '';
      await post(`/receipts/${receipt.id}/applications/${id}/reverse`, cookies.salesPts, {
        reason: 'No',
      }).expect(403);
      await post(`/receipts/${receipt.id}/applications/${id}/reverse`, cookies.financeJed, {
        reason: 'No',
      }).expect(404);
    });

    it("refuses another customer's invoice and an invoice in another currency", async () => {
      const otherInvoice = await invoice(
        { currency: 'USD', invoiceDate: d('01-25') },
        '80',
        other.id,
      );
      const foreign = await post(
        `/receipts/${receipt.id}/applications`,
        cookies.financePts,
        applyBody(otherInvoice.id, '10', d('02-11')),
      ).expect(400);
      expect(JSON.stringify(foreign.body)).toContain('another customer');
      const sdgInvoice = await invoice(
        { currency: 'SDG', fxRate: '600', invoiceDate: d('01-25') },
        '6000',
      );
      const currency = await post(
        `/receipts/${receipt.id}/applications`,
        cookies.financePts,
        applyBody(sdgInvoice.id, '10', d('02-11')),
      ).expect(400);
      expect(JSON.stringify(currency.body)).toContain('is in SDG');
    });

    it('cannot be edited or deleted in the database; neither can its posted entry', async () => {
      const id = firstBody.requestId;
      await expect(
        t.prisma.receiptApplication.update({ where: { id }, data: { amount: '1' } }),
      ).rejects.toThrow();
      await expect(t.prisma.receiptApplication.delete({ where: { id } })).rejects.toThrow();
      const entryId = applied.applications[0]?.journalEntryId ?? '';
      await expect(
        t.prisma.journalEntry.update({ where: { id: entryId }, data: { description: 'x' } }),
      ).rejects.toThrow();
    });

    it('blocks cancelling the receipt while an application is active', async () => {
      const current = (await get(`/receipts/${receipt.id}`).expect(200)).body as ReceiptDto;
      expect(current.actions.canCancel).toBe(false);
      const res = await post(`/receipts/${receipt.id}/cancel`, cookies.financePts, {
        reason: 'Bounced',
      }).expect(409);
      expect(JSON.stringify(res.body)).toContain('reverse those applications first');
    });

    it('reverses with a reversing entry, leaving the original untouched and reopening the invoice', async () => {
      const a = applied.applications[0];
      if (!a) throw new Error('No application');
      const original = await journal(a.journalEntryId);
      await post(`/receipts/${receipt.id}/applications/${a.id}/reverse`, cookies.financePts, {
        reason: '',
      }).expect(400);
      const reversed = (
        await post(`/receipts/${receipt.id}/applications/${a.id}/reverse`, cookies.financePts, {
          reason: 'Applied to the wrong invoice',
        }).expect(200)
      ).body as ReceiptDto;
      expect(reversed).toMatchObject({ applied: '0', unallocated: '500' });
      const r = reversed.applications[0];
      expect(r).toMatchObject({
        status: 'REVERSED',
        reverseReason: 'Applied to the wrong invoice',
      });
      const reversal = await journal(r?.reverseJournalEntryId ?? '');
      expect(reversal).toMatchObject({
        status: 'POSTED',
        source: 'REVERSAL',
        reversalOfId: a.journalEntryId,
      });
      expect(balanced(reversal)).toBe(true);
      expect(reversal.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual(
        original.lines.map((l) => [l.accountId, l.credit, l.debit]),
      );
      const after = await journal(a.journalEntryId);
      expect(after.lines).toEqual(original.lines);
      expect(after).toMatchObject({ status: 'POSTED', reversedById: reversal.id });
      expect(await invoiceNow(inv.id)).toMatchObject({ paidAmount: '0', balance: '1000' });
      await post(`/receipts/${receipt.id}/applications/${a.id}/reverse`, cookies.financePts, {
        reason: 'Again',
      }).expect(409);
    });

    it('can then be cancelled, and a cancelled receipt has nothing to apply', async () => {
      await post(`/receipts/${receipt.id}/cancel`, cookies.financePts, {
        reason: 'Bounced',
      }).expect(200);
      const res = await post(
        `/receipts/${receipt.id}/applications`,
        cookies.financePts,
        applyBody(inv.id, '10', d('02-12')),
      ).expect(409);
      expect(JSON.stringify(res.body)).toContain('cancelled');
    });
  });

  it('applies the same advance only once when two applications run at the same time', async () => {
    const receipt = await advance('150', d('03-01'));
    const inv = await invoice({ currency: 'USD', invoiceDate: d('03-02') }, '1000');
    const results = await Promise.all(
      [1, 2].map(() =>
        post(
          `/receipts/${receipt.id}/applications`,
          cookies.financePts,
          applyBody(inv.id, '100', d('03-03')),
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const after = (await get(`/receipts/${receipt.id}`).expect(200)).body as ReceiptDto;
    expect(after).toMatchObject({ applied: '100', unallocated: '50' });
    expect(await invoiceNow(inv.id)).toMatchObject({ paidAmount: '100' });
  });

  it.each([
    ['the whole advance', '100', '0'],
    ["the invoice's whole balance", '250', '150'],
  ])(
    'replays the same request twice in flight once, when it used up %s',
    async (_, amount, left) => {
      const receipt = await advance(amount, d('03-05'));
      const inv = await invoice({ currency: 'USD', invoiceDate: d('03-06') }, '100');
      const body = applyBody(inv.id, '100', d('03-07'));
      // Hold the receipt so both copies of the request pass the first lookup and queue on its lock.
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let held = () => {};
      const holding = new Promise<void>((resolve) => (held = resolve));
      const hold = t.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "receipts" WHERE "id" = ${receipt.id}::uuid FOR UPDATE`;
          held();
          await released;
        },
        { timeout: 20_000 },
      );
      await holding;
      const requests = [1, 2].map(() =>
        post(`/receipts/${receipt.id}/applications`, cookies.financePts, body).then((r) => r),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await hold;
      const results = await Promise.all(requests);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const after = (await get(`/receipts/${receipt.id}`).expect(200)).body as ReceiptDto;
      expect(after).toMatchObject({ applied: '100', unallocated: left });
      expect(after.applications).toHaveLength(1);
      expect(await invoiceNow(inv.id)).toMatchObject({ paidAmount: '100' });
    },
  );

  it('refuses a receipt that allocated all of its amount', async () => {
    const inv = await invoice({ currency: 'USD', invoiceDate: d('04-01') }, '100');
    const full = (
      await post('/receipts', cookies.financePts, {
        customerId: customer.id,
        receiptDate: d('04-02'),
        currency: 'USD',
        amount: '60',
        cashAccountId: cashUsd.id,
        allocations: [{ invoiceId: inv.id, amount: '60' }],
      }).expect(201)
    ).body as ReceiptDto;
    expect(full.actions.canApply).toBe(false);
    await post(
      `/receipts/${full.id}/applications`,
      cookies.financePts,
      applyBody(inv.id, '10', d('04-03')),
    ).expect(400);
  });

  it('books the exchange difference between the receipt and invoice rates, and shows it on the statement', async () => {
    // 300,000 SDG received at 500 (600 USD), applied to an invoice at 600 (clears 500 USD).
    const receipt = await advance('300000', d('05-01'), 'SDG', '500');
    const inv = await invoice(
      { currency: 'SDG', fxRate: '600', invoiceDate: d('05-02') },
      '600000',
    );
    const before = await aging(d('05-09'));
    const applied = await apply(receipt.id, applyBody(inv.id, '300000', d('05-10')));
    const a = applied.applications[0];
    expect(a).toMatchObject({ advanceUsd: '600', relievedUsd: '500' });
    const entry = await journal(a?.journalEntryId ?? '');
    expect(balanced(entry)).toBe(true);
    expect(entry.lines.map((l) => [l.currency, l.debitUsd, l.creditUsd, l.description])).toEqual([
      ['SDG', '600', '0', receipt.number],
      ['SDG', '0', '500', inv.number],
      ['USD', '0', '100', 'Realized exchange difference'],
    ]);
    const after = await aging(d('05-10'));
    expect(after.totalAdvancesUsd).toBe(advancesLess(before, '600'));
    const owedUsd = (r: ArAgingDto) =>
      r.invoices.find((i) => i.invoiceId === inv.id)?.outstandingUsd;
    expect(owedUsd(before)).toBe('1000');
    expect(owedUsd(after)).toBe('500');

    const statement = (
      await get(`/customer-statements/${customer.id}?from=${d('05-10')}&to=${d('05-10')}`).expect(
        200,
      )
    ).body as CustomerStatementDto;
    const sdg = statement.sections.find((s) => s.currency === 'SDG');
    expect(
      sdg?.lines.map((l) => [l.kind, l.documentId, l.documentNumber, l.debit, l.credit]),
    ).toEqual([['ADVANCE_APPLICATION', receipt.id, receipt.number, '300000', '300000']]);
  });
});
