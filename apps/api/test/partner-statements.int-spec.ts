import { randomInt, randomUUID } from 'node:crypto';
import type {
  BookingDto,
  CommissionsDueDto,
  CreditNoteDto,
  CustomerDto,
  CustomerInvoiceDto,
  PartnerCommissionsDto,
  PartnerDto,
  PartnerStatementDto,
  SupplierBillDto,
  SupplierDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { requests } from './agent-drafts-helpers.js';
import {
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

// Plan 07, PR-7c (rule 16a): a partner's open commissions of one branch and currency taken into a
// statement, and the one supplier bill made from it that settles them, in the currency and in USD.
// The route, charge type, partners, supplier and currency are this run's own. Entries are never
// deleted, so the people and the records they post keep the ledger prefix.

const today = () => new Date().toISOString().slice(0, 10);

let t: TestApp;
let r: ReturnType<typeof requests>;
let pts: string;
let from: string;
let to: string;
let freight: string;
let customer: CustomerDto;
let tag: string;
// A currency of this run only, so its exchange rates are the test's.
const currency = `Q${String.fromCharCode(65 + randomInt(26))}${String.fromCharCode(65 + randomInt(26))}`;
const cookies = {
  admin: '',
  salesPts: '',
  financePts: '',
  managerPts: '',
  financeJed: '',
};

const dec = (v: string | number) => new Prisma.Decimal(v);
const sum = (values: readonly Prisma.Decimal[]) => values.reduce((a, b) => a.plus(b), dec(0));

async function supplier(): Promise<SupplierDto> {
  return (
    await r
      .post('/suppliers', cookies.financePts, { name: `${tag} partner ${randomInt(1e9)}` })
      .expect(201)
  ).body as SupplierDto;
}

/** A sales outlet on 10% when invoiced, linked to a supplier of its own unless told otherwise. */
async function outlet(linked = true): Promise<PartnerDto> {
  const made = (
    await r
      .post('/partners', cookies.admin, {
        kind: 'SALES_OUTLET',
        branchId: pts,
        name: `${tag} outlet ${randomInt(1e9)}`,
        countryCode: 'SA',
        currency: 'USD',
        ...(linked ? { supplierId: (await supplier()).id } : {}),
      })
      .expect(201)
  ).body as PartnerDto;
  const contract = (
    await r
      .post(`/partners/${made.id}/contracts`, cookies.admin, {
        validFrom: '2020-01-01',
        basis: 'PERCENT_OF_PRICE',
        value: '10',
      })
      .expect(201)
  ).body as { id: string };
  await r.post(`/partner-contracts/${contract.id}/approve`, cookies.admin).expect(200);
  return made;
}

async function shipment(salesOutletId: string): Promise<string> {
  const booking = (
    await r
      .post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 2, weightKg: '10' }],
        salesOutletId,
      })
      .expect(201)
  ).body as BookingDto;
  const confirmed = (await r.post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
    .body as BookingDto;
  if (!confirmed.shipmentId) throw new Error('No shipment');
  return confirmed.shipmentId;
}

/** An approved invoice of 300 freight: a commission of 30 in its currency. */
async function invoice(
  shipmentId: string,
  money: { currency: string; fxRate?: string; price?: string } = { currency: 'USD' },
): Promise<string> {
  const { price = '300', ...priced } = money;
  const draft = (
    await r
      .post('/customer-invoices', cookies.financePts, { shipmentId, acknowledgedInvoiceIds: [] })
      .expect(201)
  ).body as CustomerInvoiceDto;
  await r
    .patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      ...priced,
      repriced: true,
      invoiceDate: today(),
      dueDate: today(),
      lines: [{ chargeTypeCode: freight, quantity: '1', unitPrice: price }],
    })
    .expect(200);
  await r.post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200);
  return draft.id;
}

async function credit(invoiceId: string, amount: string): Promise<void> {
  const note = (
    await r
      .post('/credit-notes', cookies.financePts, {
        requestId: randomUUID(),
        invoiceId,
        creditDate: today(),
        amount,
        reason: 'Allowance',
      })
      .expect(201)
  ).body as CreditNoteDto;
  await r.post(`/credit-notes/${note.id}/approve`, cookies.admin).expect(200);
}

const makeStatement = (partnerId: string, cookie = cookies.financePts, money = 'USD') =>
  r.post(`/partners/${partnerId}/statements`, cookie, {
    branchId: pts,
    currency: money,
    periodTo: today(),
  });

const bill = (statementId: string, requestId: string = randomUUID(), over: object = {}) =>
  r.post(`/partner-statements/${statementId}/bill`, cookies.financePts, {
    requestId,
    billDate: today(),
    dueDate: today(),
    ...over,
  });

/**
 * What the partner's supplier carries on the accrued commissions account, in the currency and in
 * USD (credit - debit): every rule 16 and 16a line of the partner names it.
 */
async function accrued(supplierId: string | null, money: string, shipmentIds?: string[]) {
  const mapping = await t.prisma.accountMapping.findUniqueOrThrow({
    where: { role: 'ACCRUED_COMMISSIONS' },
  });
  // Optionally only the rule 16 entries of some shipments (lines without a supplier are shared).
  const lines = await t.prisma.journalLine.findMany({
    where: {
      accountId: mapping.accountId,
      supplierId,
      currency: money,
      branchId: pts,
      ...(shipmentIds
        ? { entry: { source: 'COMMISSION_ACCRUAL', sourceId: { in: shipmentIds } } }
        : {}),
    },
  });
  return [
    sum(lines.map((l) => l.credit.minus(l.debit))).toFixed(),
    sum(lines.map((l) => l.creditUsd.minus(l.debitUsd))).toFixed(),
  ];
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  pts = await branchId(t.prisma, 'PTS');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
    salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
    managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
    financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  tag = `PS${randomUUID().slice(0, 6).toUpperCase()}`;
  const location = async (suffix: string) =>
    (
      await t.prisma.location.create({
        data: {
          code: `${tag}${suffix}`,
          kind: 'CITY',
          nameEn: `Statement test ${tag}${suffix}`,
          nameAr: 'مدينة اختبار الكشوف',
          countryCode: 'SD',
        },
      })
    ).id;
  from = await location('A');
  to = await location('B');
  freight = `${tag}F`;
  await t.prisma.chargeType.create({
    data: { code: freight, nameEn: 'Statement freight', nameAr: 'نولون', service: 'MAIN_FREIGHT' },
  });
  await t.prisma.currency.create({
    data: { code: currency, nameEn: 'ZZ test', nameAr: 'ZZ test', decimalPlaces: 2 },
  });
  customer = (
    await r
      .post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Statement ${tag}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      })
      .expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await t.close();
});

describe('partner statements and their supplier bill, rule 16a (plan 07, PR-7c)', () => {
  it('takes the open rows once, and refuses what has nothing to settle or no supplier', async () => {
    const partner = await outlet();
    const first = await shipment(partner.id);
    const second = await shipment(partner.id);
    await invoice(first);
    await invoice(second);
    // Branch Manager and Sales make no statement, Finance of another branch neither (F149-2).
    await makeStatement(partner.id, cookies.managerPts).expect(403);
    await makeStatement(partner.id, cookies.salesPts).expect(403);
    await makeStatement(partner.id, cookies.financeJed).expect(403);
    const statement = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    expect(statement).toMatchObject({
      status: 'DRAFT',
      currency: 'USD',
      total: '60',
      totalUsd: '60',
      billId: null,
      actions: { canBill: true, canCancel: true },
    });
    expect(statement.number).toMatch(/^NOL-PST-\d{4}-\d{6}$/);
    // A line per row, by shipment number.
    expect(statement.lines.map((l) => [l.shipmentId, l.amount, l.event, l.basis])).toEqual([
      [first, '30', 'INVOICED', 'PERCENT_OF_PRICE'],
      [second, '30', 'INVOICED', 'PERCENT_OF_PRICE'],
    ]);
    // The rows are taken: nothing open is left to settle.
    expect(
      (await makeStatement(partner.id).expect(409)).body as { code: string; params: object },
    ).toMatchObject({ code: 'STATEMENT_NOT_POSITIVE' });
    const page = (
      await r.get(`/partners/${partner.id}/commissions`, cookies.financePts).expect(200)
    ).body as PartnerCommissionsDto;
    expect(page.balances).toEqual([]);
    expect(page.statements.map((s) => s.id)).toEqual([statement.id]);
    expect(page.rows.every((row) => row.statementId === statement.id)).toBe(true);

    const unlinked = await outlet(false);
    expect((await makeStatement(unlinked.id).expect(409)).body).toMatchObject({
      code: 'PARTNER_NO_SUPPLIER',
    });
  });

  it('two statements made at once take each row once', async () => {
    const partner = await outlet();
    await invoice(await shipment(partner.id));
    const results = await Promise.all([makeStatement(partner.id), makeStatement(partner.id)]);
    expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
    const taken = await t.prisma.commissionAccrual.findMany({ where: { partnerId: partner.id } });
    expect(taken).toHaveLength(1);
    expect(taken[0]?.statementId).not.toBeNull();
  });

  it('makes one live bill, settles the accrual on approval, and gives it back on cancellation', async () => {
    const partner = await outlet();
    const id = await shipment(partner.id);
    await invoice(id);
    const statement = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    const supplierId = partner.supplierId ?? '';
    expect(await accrued(supplierId, 'USD')).toEqual(['30', '30']);

    // Two presses at once with different request ids: one bill, and a 409 that names it.
    const presses = await Promise.all([bill(statement.id), bill(statement.id)]);
    expect(presses.map((x) => x.status).sort()).toEqual([200, 409]);
    const billed = presses.find((x) => x.status === 200)?.body as PartnerStatementDto;
    const refused = presses.find((x) => x.status === 409)?.body as { code: string; params: object };
    expect(refused).toMatchObject({
      code: 'STATEMENT_ALREADY_BILLED',
      params: { billId: billed.billId },
    });
    expect(billed).toMatchObject({
      status: 'BILLED',
      actions: { canBill: false, canCancel: false },
    });
    const billId = billed.billId ?? '';
    // The same request again returns the same statement and bill.
    expect(
      ((await bill(statement.id, billId).expect(200)).body as PartnerStatementDto).billId,
    ).toBe(billId);
    // The same request id with other content is refused, not reported as saved (F168-2).
    for (const over of [
      { supplierReference: 'DIFFERENT' },
      { dueDate: '2099-12-31' },
      { billDate: '2020-01-01', dueDate: '2020-01-01' },
    ]) {
      await bill(statement.id, billId, over).expect(409);
    }
    expect(await t.prisma.supplierBill.count({ where: { supplierId } })).toBe(1);
    const draft = (await r.get(`/supplier-bills/${billId}`, cookies.financePts).expect(200))
      .body as SupplierBillDto;
    expect(draft).toMatchObject({
      status: 'DRAFT',
      supplierId,
      branchId: pts,
      currency: 'USD',
      total: '30',
      actions: { canEdit: false },
    });
    expect(draft.lines).toEqual([
      expect.objectContaining({ kind: 'COMMISSION', amount: '30', statementId: statement.id }),
    ]);
    // The general route edits no bill of a statement, and takes no statement line (F149-3).
    expect(
      (
        await r
          .patch(`/supplier-bills/${billId}`, cookies.financePts, {
            branchId: pts,
            currency: 'USD',
            billDate: today(),
            lines: [{ kind: 'EXPENSE', expenseCategoryCode: 'OFFICE', amount: '30' }],
          })
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'BILL_FROM_STATEMENT' });
    await r
      .post('/supplier-bills', cookies.financePts, {
        requestId: randomUUID(),
        supplierId,
        branchId: pts,
        currency: 'USD',
        billDate: today(),
        dueDate: today(),
        lines: [
          {
            kind: 'EXPENSE',
            expenseCategoryCode: 'OFFICE',
            amount: '1',
            statementId: statement.id,
          },
        ],
      })
      .expect(400);
    // A billed statement is cancelled only after its bill.
    expect(
      (await r.post(`/partner-statements/${statement.id}/cancel`, cookies.financePts).expect(409))
        .body,
    ).toMatchObject({ code: 'STATEMENT_BILLED' });

    await r.post(`/supplier-bills/${billId}/approve`, cookies.financePts, {}).expect(200);
    const settled = (
      await r.get(`/partner-statements/${statement.id}`, cookies.financePts).expect(200)
    ).body as PartnerStatementDto;
    expect(settled).toMatchObject({ status: 'SETTLED', billStatus: 'APPROVED' });
    // Rule 16a cleared exactly what rule 16 accrued, and the payable is the partner's.
    expect(await accrued(supplierId, 'USD')).toEqual(['0', '0']);
    const approved = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } });
    const entry = await t.prisma.journalEntry.findUniqueOrThrow({
      where: { id: approved.journalEntryId ?? '' },
      include: { lines: true },
    });
    expect(entry).toMatchObject({ source: 'SUPPLIER_BILL', branchId: pts, status: 'POSTED' });
    expect(entry.lines).toHaveLength(2);

    // Cancelling the approved bill gives the accrual back and the statement can be billed again.
    await r
      .post(`/supplier-bills/${billId}/cancel`, cookies.financePts, { reason: 'Wrong period' })
      .expect(200);
    expect(await accrued(supplierId, 'USD')).toEqual(['30', '30']);
    const reopened = (
      await r.get(`/partner-statements/${statement.id}`, cookies.financePts).expect(200)
    ).body as PartnerStatementDto;
    expect(reopened).toMatchObject({ status: 'DRAFT', billId: null });
    // A new bill, then the old one's cancellation again leaves the statement alone.
    const again = (await bill(statement.id).expect(200)).body as PartnerStatementDto;
    expect(again.billId).not.toBe(billId);
    await r
      .post(`/supplier-bills/${again.billId ?? ''}/cancel`, cookies.financePts, {
        reason: 'Not needed',
      })
      .expect(200);
    const cancelled = (
      await r.post(`/partner-statements/${statement.id}/cancel`, cookies.financePts).expect(200)
    ).body as PartnerStatementDto;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', lines: [] });
    // Its rows are open again, for the next statement.
    const next = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    expect(next.total).toBe('30');
  });

  it('refuses the approval when the partner changed supplier after the bill was made', async () => {
    const partner = await outlet();
    await invoice(await shipment(partner.id));
    const statement = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    const billed = (await bill(statement.id).expect(200)).body as PartnerStatementDto;
    await r
      .patch(`/partners/${partner.id}`, cookies.admin, { supplierId: (await supplier()).id })
      .expect(200);
    expect(
      (
        await r
          .post(`/supplier-bills/${billed.billId ?? ''}/approve`, cookies.financePts, {})
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'STATEMENT_BILL_MISMATCH' });
  });

  it('clears each row on the supplier its entry named, after the partner changed supplier (F168-1)', async () => {
    // Accrued under supplier A, then the partner is linked to B: the bill is B's payable, and A's
    // accrued balance is cleared on A.
    const partner = await outlet();
    const a = partner.supplierId ?? '';
    const first = await shipment(partner.id);
    await invoice(first);
    const b = (await supplier()).id;
    await r.patch(`/partners/${partner.id}`, cookies.admin, { supplierId: b }).expect(200);
    const second = await shipment(partner.id);
    await invoice(second);
    expect(await accrued(a, 'USD')).toEqual(['30', '30']);
    expect(await accrued(b, 'USD')).toEqual(['30', '30']);
    const statement = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    expect(statement).toMatchObject({ total: '60', partnerSupplierId: b });
    const billId =
      ((await bill(statement.id).expect(200)).body as PartnerStatementDto).billId ?? '';
    await r.post(`/supplier-bills/${billId}/approve`, cookies.financePts, {}).expect(200);
    expect(await accrued(a, 'USD')).toEqual(['0', '0']);
    expect(await accrued(b, 'USD')).toEqual(['0', '0']);
    const approved = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } });
    const lines = await t.prisma.journalLine.findMany({
      where: { entryId: approved.journalEntryId ?? '' },
    });
    const payable = lines.filter((l) => l.credit.gt(0));
    expect(payable.map((l) => [l.supplierId, l.credit.toFixed()])).toEqual([[b, '60']]);
    // Cancelling the bill gives each supplier back what it carried.
    await r
      .post(`/supplier-bills/${billId}/cancel`, cookies.financePts, { reason: 'Wrong period' })
      .expect(200);
    expect(await accrued(a, 'USD')).toEqual(['30', '30']);
    expect(await accrued(b, 'USD')).toEqual(['30', '30']);
  });

  it('settles a positive statement whose old supplier nets below zero (F168-3)', async () => {
    // A's 30 is settled, then a credit note takes 7.5 back from A; the partner moves to B, which
    // earns 30. The statement of 22.5 clears A's -7.5 on the credit side and B's 30 on the debit.
    const partner = await outlet();
    const a = partner.supplierId ?? '';
    const first = await shipment(partner.id);
    const firstInvoice = await invoice(first);
    const settledFirst = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    const firstBill =
      ((await bill(settledFirst.id).expect(200)).body as PartnerStatementDto).billId ?? '';
    await r.post(`/supplier-bills/${firstBill}/approve`, cookies.financePts, {}).expect(200);
    await credit(firstInvoice, '75');
    expect(await accrued(a, 'USD')).toEqual(['-7.5', '-7.5']);
    const b = (await supplier()).id;
    await r.patch(`/partners/${partner.id}`, cookies.admin, { supplierId: b }).expect(200);
    await invoice(await shipment(partner.id));
    const statement = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    expect(statement.total).toBe('22.5');
    const billId =
      ((await bill(statement.id).expect(200)).body as PartnerStatementDto).billId ?? '';
    await r.post(`/supplier-bills/${billId}/approve`, cookies.financePts, {}).expect(200);
    expect(await accrued(a, 'USD')).toEqual(['0', '0']);
    expect(await accrued(b, 'USD')).toEqual(['0', '0']);
    const approved = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } });
    const lines = await t.prisma.journalLine.findMany({
      where: { entryId: approved.journalEntryId ?? '' },
    });
    expect(lines.map((l) => [l.supplierId, l.debit.toFixed(), l.credit.toFixed()]).sort()).toEqual(
      [
        [a, '0', '7.5'],
        [b, '30', '0'],
        [b, '0', '22.5'],
      ].sort(),
    );
    // Cancelling the bill gives each supplier back what it carried.
    await r
      .post(`/supplier-bills/${billId}/cancel`, cookies.financePts, { reason: 'Wrong period' })
      .expect(200);
    expect(await accrued(a, 'USD')).toEqual(['-7.5', '-7.5']);
    expect(await accrued(b, 'USD')).toEqual(['30', '30']);
  });

  // F168-4: A's rows carry the currency and USD opposite ways (a credit at one rate, an accrual at
  // another); each supplier is cleared in the currency it carries, per currency and in USD.
  for (const [name, laterPrice, carriesA] of [
    ['opposite signs', '300', ['22.5', '-4.5']],
    ['nothing in the currency', '75', ['0', '-6.75']],
  ] as const) {
    it(`clears a supplier whose rows net to ${name} in its own currency (F168-4)`, async () => {
      const rate = (value: string) =>
        r
          .put('/accounting/fx-rates', cookies.financePts, {
            currency,
            rateDate: today(),
            rate: value,
          })
          .expect(200);
      const partner = await outlet();
      const a = partner.supplierId ?? '';
      // A: 30 at 1, settled; a quarter credited (-7.5 at 1); then 10% of the later price at 10.
      const first = await shipment(partner.id);
      const firstInvoice = await invoice(first, { currency, fxRate: '1' });
      await rate('1');
      const settled = (await makeStatement(partner.id, cookies.financePts, currency).expect(201))
        .body as PartnerStatementDto;
      const settledBill =
        ((await bill(settled.id).expect(200)).body as PartnerStatementDto).billId ?? '';
      await r.post(`/supplier-bills/${settledBill}/approve`, cookies.financePts, {}).expect(200);
      await credit(firstInvoice, '75');
      await invoice(await shipment(partner.id), { currency, fxRate: '10', price: laterPrice });
      const carried = async (supplierId: string) => {
        const [inCurrency, inUsdLines] = [
          await accrued(supplierId, currency),
          await accrued(supplierId, 'USD'),
        ];
        return {
          native: inCurrency[0],
          usd: dec(inCurrency[1] ?? '0')
            .plus(inUsdLines[1] ?? '0')
            .toFixed(),
          currencyUsd: inCurrency[1],
          usdLines: inUsdLines,
        };
      };
      const before = await carried(a);
      expect([before.native, before.usd]).toEqual(carriesA);
      // B: 30 at 1.
      const b = (await supplier()).id;
      await r.patch(`/partners/${partner.id}`, cookies.admin, { supplierId: b }).expect(200);
      await invoice(await shipment(partner.id), { currency, fxRate: '1' });
      const statement = (await makeStatement(partner.id, cookies.financePts, currency).expect(201))
        .body as PartnerStatementDto;
      const billId =
        ((await bill(statement.id).expect(200)).body as PartnerStatementDto).billId ?? '';
      await r.post(`/supplier-bills/${billId}/approve`, cookies.financePts, {}).expect(200);
      // Each supplier's balance is zero in each currency it carries, and in USD.
      for (const supplierId of [a, b]) {
        expect(await accrued(supplierId, currency)).toEqual(['0', '0']);
        expect(await accrued(supplierId, 'USD')).toEqual(
          supplierId === a ? before.usdLines : ['0', '0'],
        );
      }
      // Cancelling the bill gives each back what it carried, currency by currency.
      await r
        .post(`/supplier-bills/${billId}/cancel`, cookies.financePts, { reason: 'Wrong period' })
        .expect(200);
      expect(await carried(a)).toEqual(before);
      expect(await accrued(b, currency)).toEqual(['30', '30']);
    });
  }

  it('clears rows posted before the partner had a supplier on no supplier (F168-1)', async () => {
    const partner = await outlet(false);
    const id = await shipment(partner.id);
    await invoice(id);
    expect(await accrued(null, 'USD', [id])).toEqual(['30', '30']);
    const linked = (await supplier()).id;
    await r.patch(`/partners/${partner.id}`, cookies.admin, { supplierId: linked }).expect(200);
    const statement = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    const billId =
      ((await bill(statement.id).expect(200)).body as PartnerStatementDto).billId ?? '';
    await r.post(`/supplier-bills/${billId}/approve`, cookies.financePts, {}).expect(200);
    const approved = await t.prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } });
    const lines = await t.prisma.journalLine.findMany({
      where: { entryId: approved.journalEntryId ?? '' },
    });
    expect(lines.map((l) => [l.supplierId, l.debit.toFixed(), l.credit.toFixed()]).sort()).toEqual(
      [
        [linked, '0', '30'],
        [null, '30', '0'],
      ].sort(),
    );
    expect(await accrued(linked, 'USD')).toEqual(['0', '0']);
  });

  it('clears the USD the rows carry, and shares the rate difference over the shipments above zero (F149-5)', async () => {
    const partner = await outlet();
    const supplierId = partner.supplierId ?? '';
    // B: 30 of the test currency at 4 (7.5 USD), settled; then a quarter credited: -7.5 at 4.
    const b = await shipment(partner.id);
    const bInvoice = await invoice(b, { currency, fxRate: '4' });
    await r
      .put('/accounting/fx-rates', cookies.financePts, { currency, rateDate: today(), rate: '4' })
      .expect(200);
    const firstStatement = (
      await makeStatement(partner.id, cookies.financePts, currency).expect(201)
    ).body as PartnerStatementDto;
    const firstBill = (await bill(firstStatement.id).expect(200)).body as PartnerStatementDto;
    await r
      .post(`/supplier-bills/${firstBill.billId ?? ''}/approve`, cookies.financePts, {})
      .expect(200);
    await credit(bInvoice, '75');
    // A: 30 at 4 (7.5 USD).
    const a = await shipment(partner.id);
    await invoice(a, { currency, fxRate: '4' });
    const statement = (await makeStatement(partner.id, cookies.financePts, currency).expect(201))
      .body as PartnerStatementDto;
    // 30 - 7.5 in the currency; in USD, what the rows carry (each at the rate of 4).
    const carried = sum(
      (await t.prisma.commissionAccrual.findMany({ where: { statementId: statement.id } })).map(
        (row) => row.amountUsd,
      ),
    );
    expect([statement.total, statement.totalUsd]).toEqual(['22.5', carried.toFixed()]);
    expect(carried.gt(5.6) && carried.lt(5.65)).toBe(true);
    // The bill at today's table rate of 5: 4.5 USD, less than the rows carry.
    await r
      .put('/accounting/fx-rates', cookies.financePts, { currency, rateDate: today(), rate: '5' })
      .expect(200);
    const billed = (await bill(statement.id).expect(200)).body as PartnerStatementDto;
    await r
      .post(`/supplier-bills/${billed.billId ?? ''}/approve`, cookies.financePts, {})
      .expect(200);
    expect(await accrued(supplierId, currency)).toEqual(['0', '0']);
    const approved = await t.prisma.supplierBill.findUniqueOrThrow({
      where: { id: billed.billId ?? '' },
    });
    expect(approved.totalUsd.toFixed()).toBe('4.5');
    const cost = await t.prisma.accountMapping.findUniqueOrThrow({
      where: { role: 'COMMISSION_COST' },
    });
    const difference = await t.prisma.journalLine.findMany({
      where: { entryId: approved.journalEntryId ?? '', accountId: cost.accountId },
    });
    // All on A, whose rows net above zero; none on B, whose rows net below.
    expect(
      difference.map((l) => [l.shipmentId, l.creditUsd.toFixed(), l.debitUsd.toFixed()]),
    ).toEqual([[a, carried.minus(4.5).toFixed(), '0']]);
  });

  it('report z4: what is not settled, by partner, aged, and equal to the ledger per branch', async () => {
    const partner = await outlet();
    await invoice(await shipment(partner.id));
    await invoice(await shipment(partner.id));
    const statement = (await makeStatement(partner.id).expect(201)).body as PartnerStatementDto;
    await bill(statement.id).expect(200);
    await invoice(await shipment(partner.id));
    await r.get('/partner-commissions/due', cookies.salesPts).expect(403);
    const due = (await r.get('/partner-commissions/due', cookies.financePts).expect(200))
      .body as CommissionsDueDto;
    expect(due.rows.find((x) => x.partnerId === partner.id)).toMatchObject({
      branchId: pts,
      currency: 'USD',
      open: '30',
      inStatement: '60',
      unsettled: '90',
      unsettledUsd: '90',
      ages: ['90', '0', '0', '0'],
      owesNolon: false,
      holds: 0,
    });
    // Another branch's Finance sees none of PTS.
    const jed = (await r.get('/partner-commissions/due', cookies.financeJed).expect(200))
      .body as CommissionsDueDto;
    expect(jed.rows.some((x) => x.branchId === pts)).toBe(false);
    // The sub-ledger and the accrued commissions account agree, for this partner's supplier and
    // for the branch.
    expect(await accrued(partner.supplierId ?? '', 'USD')).toEqual(['90', '90']);
    expect(due.branches.find((b) => b.branchId === pts)).toMatchObject({ matches: true });
  });
});
