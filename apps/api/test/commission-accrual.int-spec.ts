import { randomInt, randomUUID } from 'node:crypto';
import type {
  BookingDto,
  CreditNoteDto,
  CustomerDto,
  CustomerInvoiceDto,
  PartnerCommissionsDto,
  PartnerContractDto,
  PartnerDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { requests } from './agent-drafts-helpers.js';
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

// Plan 07, PR-7b (rule 16): a partner's commission on a shipment, kept equal by difference to what
// its contract earns now, in its currency and in USD, through every write that changes it. The
// route, charge types, partners and currency are this run's own. Entries are never deleted, so
// the people and the records they post keep the ledger prefix.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const today = () => new Date().toISOString().slice(0, 10);

let t: TestApp;
let r: ReturnType<typeof requests>;
let pts: string;
let from: string;
let to: string;
let freight: string;
let duties: string;
let customer: CustomerDto;
let tag: string;
// A currency of this run only: no exchange rate until the test adds one.
const currency = `Q${String.fromCharCode(65 + randomInt(26))}${String.fromCharCode(65 + randomInt(26))}`;
const cookies = {
  admin: '',
  salesPts: '',
  financePts: '',
  opsPts: '',
  managerPts: '',
  managerJed: '',
};
const partners = {} as Record<'outlet' | 'consolidator' | 'distributor' | 'other', PartnerDto>;

const dec = (v: string | number) => new Prisma.Decimal(v);
const sum = (values: readonly Prisma.Decimal[]) => values.reduce((a, b) => a.plus(b), dec(0));

async function partner(kind: string): Promise<PartnerDto> {
  return (
    await r
      .post('/partners', cookies.admin, {
        kind,
        branchId: pts,
        name: `${tag} ${kind} ${randomInt(1e9)}`,
        countryCode: 'SA',
        currency: 'USD',
      })
      .expect(201)
  ).body as PartnerDto;
}

async function contract(p: PartnerDto, body: object): Promise<PartnerContractDto> {
  const made = (
    await r
      .post(`/partners/${p.id}/contracts`, cookies.admin, { validFrom: '2020-01-01', ...body })
      .expect(201)
  ).body as PartnerContractDto;
  return (await r.post(`/partner-contracts/${made.id}/approve`, cookies.admin).expect(200))
    .body as PartnerContractDto;
}

async function shipment(
  quantity = 4,
  salesOutletId = partners.outlet.id,
  items: object[] = [{ cargoType: 'GENERAL', quantity, weightKg: '10' }],
): Promise<string> {
  const booking = (
    await r
      .post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items,
        salesOutletId,
      })
      .expect(201)
  ).body as BookingDto;
  const confirmed = (await r.post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
    .body as BookingDto;
  if (!confirmed.shipmentId) throw new Error('No shipment');
  return confirmed.shipmentId;
}

/** An approved invoice of 300 freight and 100 reimbursable duties (USD unless given). */
async function invoice(
  shipmentId: string,
  acknowledged: string[] = [],
  money: { currency: string; fxRate?: string } = { currency: 'USD' },
): Promise<string> {
  const draft = (
    await r
      .post('/customer-invoices', cookies.financePts, {
        shipmentId,
        acknowledgedInvoiceIds: acknowledged,
      })
      .expect(201)
  ).body as CustomerInvoiceDto;
  await r
    .patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      ...money,
      repriced: true,
      invoiceDate: today(),
      dueDate: today(),
      lines: [
        { chargeTypeCode: freight, quantity: '1', unitPrice: '300' },
        { chargeTypeCode: duties, quantity: '1', unitPrice: '100' },
      ],
    })
    .expect(200);
  await r.post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200);
  return draft.id;
}

const rows = (shipmentId: string, role?: string) =>
  t.prisma.commissionAccrual.findMany({
    where: { shipmentId, ...(role ? { role: role as 'SALES_OUTLET' } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const brief = async (shipmentId: string, role: string) =>
  (await rows(shipmentId, role)).map((row) => [
    row.kind,
    row.currency,
    row.amount.toFixed(),
    row.amountUsd.toFixed(),
  ]);
const hold = (shipmentId: string, role: string) =>
  t.prisma.commissionHold.findUnique({
    where: { shipmentId_role: { shipmentId, role: role as 'SALES_OUTLET' } },
  });

const status = (id: string, next: string, extra: object = {}) =>
  r.post(`/shipments/${id}/status`, cookies.opsPts, { status: next, ...extra });

async function revert(id: string) {
  const last = await t.prisma.shipmentEvent.findFirstOrThrow({
    where: { shipmentId: id },
    orderBy: { id: 'desc' },
  });
  await r
    .post(`/shipments/${id}/revert`, cookies.opsPts, {
      reason: 'Entered by mistake',
      undoEventId: last.id.toString(),
    })
    .expect(200);
}

/** The entry of each row posts its amounts: cost on the shipment against accrued commissions. */
async function expectLedgerMatches(shipmentId: string) {
  const all = await rows(shipmentId);
  const accrued = await t.prisma.accountMapping.findUniqueOrThrow({
    where: { role: 'ACCRUED_COMMISSIONS' },
  });
  const cost = await t.prisma.accountMapping.findUniqueOrThrow({
    where: { role: 'COMMISSION_COST' },
  });
  const lines = await t.prisma.journalLine.findMany({
    where: { entryId: { in: all.map((row) => row.entryId) } },
  });
  const net = (accountId: string, field: 'Usd' | '') =>
    sum(
      lines
        .filter((l) => l.accountId === accountId)
        .map((l) => (field === 'Usd' ? l.creditUsd.minus(l.debitUsd) : l.credit.minus(l.debit))),
    );
  expect(net(accrued.accountId, 'Usd').toFixed()).toBe(sum(all.map((x) => x.amountUsd)).toFixed());
  expect(net(cost.accountId, 'Usd').negated().toFixed()).toBe(
    sum(all.map((x) => x.amountUsd)).toFixed(),
  );
  for (const line of lines.filter((l) => l.accountId === cost.accountId)) {
    expect(line.shipmentId).toBe(shipmentId);
  }
  const entries = await t.prisma.journalEntry.findMany({
    where: { id: { in: all.map((row) => row.entryId) } },
  });
  for (const entry of entries) {
    expect(entry).toMatchObject({ source: 'COMMISSION_ACCRUAL', status: 'POSTED', branchId: pts });
  }
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  pts = await branchId(t.prisma, 'PTS');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
    salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
    opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
    managerPts: await createUser(t.prisma, ['BRANCH_MANAGER'], ['PTS'], LEDGER_PREFIX),
    managerJed: await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  tag = `CA${randomUUID().slice(0, 6).toUpperCase()}`;
  const location = async (suffix: string) =>
    (
      await t.prisma.location.create({
        data: {
          code: `${tag}${suffix}`,
          kind: 'CITY',
          nameEn: `Commission test ${tag}${suffix}`,
          nameAr: 'مدينة اختبار العمولات',
          countryCode: 'SD',
        },
      })
    ).id;
  from = await location('A');
  to = await location('B');
  freight = `${tag}F`;
  duties = `${tag}D`;
  await t.prisma.chargeType.create({
    data: { code: freight, nameEn: 'Commission freight', nameAr: 'نولون', service: 'MAIN_FREIGHT' },
  });
  await t.prisma.chargeType.create({
    data: { code: duties, nameEn: 'Duties paid', nameAr: 'رسوم مستردة', service: 'CUSTOMS' },
  });
  await t.prisma.chargeTypePosting.create({
    data: { chargeTypeCode: duties, isReimbursable: true },
  });
  await t.prisma.currency.create({
    data: { code: currency, nameEn: 'ZZ test', nameAr: 'ZZ test', decimalPlaces: 2 },
  });
  customer = (
    await r
      .post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Commission ${tag}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      })
      .expect(201)
  ).body as CustomerDto;
  partners.outlet = await partner('SALES_OUTLET');
  partners.consolidator = await partner('ORIGIN_CONSOLIDATOR');
  partners.distributor = await partner('DISTRIBUTOR');
  partners.other = await partner('ORIGIN_CONSOLIDATOR');
  // The outlet: 10% when invoiced. The consolidator: 5 of the test currency per piece on
  // departure. The distributor: 2% on a full delivery. The other consolidator: 1 USD a shipment.
  await contract(partners.outlet, { basis: 'PERCENT_OF_PRICE', value: '10' });
  await contract(partners.consolidator, {
    basis: 'FIXED_PER_UNIT',
    value: '5',
    unit: 'PER_PIECE',
    currency,
    accrualEvent: 'DEPARTED',
  });
  await contract(partners.distributor, { basis: 'PERCENT_OF_PRICE', value: '2' });
  await contract(partners.other, {
    basis: 'FIXED_PER_UNIT',
    value: '1',
    unit: 'PER_SHIPMENT',
    currency: 'USD',
    accrualEvent: 'DEPARTED',
  });
});

afterAll(async () => {
  await t.close();
});

describe('partner commissions, rule 16 (plan 07, PR-7b)', () => {
  it('accrues a percentage on approval, on the lines that are not reimbursable', async () => {
    const id = await shipment();
    expect(await rows(id)).toEqual([]);
    await invoice(id);
    // 10% of 300: the 100 of duties is passed through at cost, not earned.
    expect(await brief(id, 'SALES_OUTLET')).toEqual([['ACCRUAL', 'USD', '30', '30']]);
    expect((await rows(id, 'SALES_OUTLET'))[0]).toMatchObject({
      partnerId: partners.outlet.id,
      branchId: pts,
      statementId: null,
    });
    await expectLedgerMatches(id);
  });

  it('a credit note reduces it, a second invoice raises it, and syncing again changes nothing', async () => {
    const id = await shipment();
    const first = await invoice(id);
    const note = (
      await r
        .post('/credit-notes', cookies.financePts, {
          requestId: randomUUID(),
          invoiceId: first,
          creditDate: today(),
          amount: '100',
          reason: 'Allowance',
        })
        .expect(201)
    ).body as CreditNoteDto;
    await r.post(`/credit-notes/${note.id}/approve`, cookies.admin).expect(200);
    // A quarter of the invoice credited: a quarter of the base, 300 x 3/4 x 10% = 22.5.
    expect(await brief(id, 'SALES_OUTLET')).toEqual([
      ['ACCRUAL', 'USD', '30', '30'],
      ['ADJUSTMENT', 'USD', '-7.5', '-7.5'],
    ]);
    await invoice(id, [first]);
    expect((await brief(id, 'SALES_OUTLET')).at(-1)).toEqual(['ADJUSTMENT', 'USD', '30', '30']);
    await r.post(`/shipments/${id}/commissions/recompute`, cookies.managerPts).expect(200);
    expect(await rows(id, 'SALES_OUTLET')).toHaveLength(3);
    await expectLedgerMatches(id);
  });

  it('takes each invoice at its own rate, and a full credit gives back exactly what it booked', async () => {
    const id = await shipment();
    const first = await invoice(id, [], { currency: 'SAR', fxRate: '3.75' });
    await invoice(id, [first], { currency: 'SAR', fxRate: '4' });
    // 30 SAR on each: 8 USD at 3.75 and 7.5 at 4. Two rates: the row names none.
    const [accrual, raised] = await rows(id, 'SALES_OUTLET');
    expect([accrual?.amount.toFixed(), accrual?.amountUsd.toFixed()]).toEqual(['30', '8']);
    expect([raised?.amount.toFixed(), raised?.amountUsd.toFixed(), raised?.fxRate]).toEqual([
      '30',
      '7.5',
      null,
    ]);
    const note = (
      await r
        .post('/credit-notes', cookies.financePts, {
          requestId: randomUUID(),
          invoiceId: first,
          creditDate: today(),
          amount: '400',
          reason: 'Cancelled sale',
        })
        .expect(201)
    ).body as CreditNoteDto;
    await r.post(`/credit-notes/${note.id}/approve`, cookies.admin).expect(200);
    // The first invoice's share comes back at its own rate: 30 SAR and 8 USD, not 30 / 4.
    expect((await brief(id, 'SALES_OUTLET')).at(-1)).toEqual(['ADJUSTMENT', 'SAR', '-30', '-8']);
    await expectLedgerMatches(id);
  });

  it('holds a shipment of several categories when the partner has only category contracts', async () => {
    const codes = [`${tag}1`, `${tag}2`];
    for (const code of codes) {
      await t.prisma.priceCategory.create({
        data: { code, nameEn: code, nameAr: code, cargoType: 'GENERAL', defaultUnit: 'PER_PIECE' },
      });
    }
    const picky = await partner('SALES_OUTLET');
    await contract(picky, { basis: 'PERCENT_OF_PRICE', value: '5', priceCategoryCode: codes[0] });
    const id = await shipment(
      1,
      picky.id,
      codes.map((code) => ({
        cargoType: 'GENERAL',
        quantity: 1,
        weightKg: '5',
        priceCategoryCode: code,
      })),
    );
    await invoice(id);
    expect(await rows(id, 'SALES_OUTLET')).toEqual([]);
    expect(await hold(id, 'SALES_OUTLET')).toMatchObject({ code: 'COMMISSION_MIXED_CATEGORIES' });
    // A contract for every category settles it on the next sync.
    await contract(picky, { basis: 'PERCENT_OF_PRICE', value: '4' });
    await r.post(`/shipments/${id}/commissions/recompute`, cookies.managerPts).expect(200);
    expect(await brief(id, 'SALES_OUTLET')).toEqual([['ACCRUAL', 'USD', '12', '12']]);
    expect(await hold(id, 'SALES_OUTLET')).toBeNull();
  });

  it('a fixed amount waits for an exchange rate, accrues on departure and follows the cargo', async () => {
    const id = await shipment(4);
    await r
      .patch(`/shipments/${id}`, cookies.opsPts, { originConsolidatorId: partners.consolidator.id })
      .expect(200);
    await status(id, 'TRIP_SCHEDULED').expect(200);
    expect(await rows(id, 'ORIGIN_CONSOLIDATOR')).toEqual([]);
    await status(id, 'ROAD_DEPARTED').expect(200);
    // No rate for the test currency: the departure stands, the commission is held.
    expect(await rows(id, 'ORIGIN_CONSOLIDATOR')).toEqual([]);
    expect(await hold(id, 'ORIGIN_CONSOLIDATOR')).toMatchObject({
      code: 'COMMISSION_NO_FX_RATE',
      partnerId: partners.consolidator.id,
    });
    await r
      .put('/accounting/fx-rates', cookies.financePts, { currency, rateDate: today(), rate: '4' })
      .expect(200);
    await r.post(`/shipments/${id}/commissions/recompute`, cookies.financePts).expect(403);
    await r.post(`/shipments/${id}/commissions/recompute`, cookies.managerJed).expect(404);
    expect(
      (await r.post(`/shipments/${id}/commissions/recompute`, cookies.managerPts).expect(200)).body,
    ).toEqual({ holds: 0 });
    // 4 pieces x 5 = 20 at 4 to the dollar.
    expect(await brief(id, 'ORIGIN_CONSOLIDATOR')).toEqual([['ACCRUAL', currency, '20', '5']]);
    expect(await hold(id, 'ORIGIN_CONSOLIDATOR')).toBeNull();
    // A new rate does not move the slot: it keeps the rate of its first accrual.
    await r
      .put('/accounting/fx-rates', cookies.financePts, { currency, rateDate: today(), rate: '5' })
      .expect(200);
    const revision = await t.prisma.shipmentCargoCorrection.count({ where: { shipmentId: id } });
    await r
      .put(`/shipments/${id}/items`, cookies.opsPts, {
        requestId: randomUUID(),
        expectedRevision: revision,
        reason: 'Counted again',
        items: [{ cargoType: 'GENERAL', quantity: 6, weightKg: '10' }],
      })
      .expect(200);
    expect((await brief(id, 'ORIGIN_CONSOLIDATOR')).at(-1)).toEqual([
      'ADJUSTMENT',
      currency,
      '10',
      '2.5',
    ]);
    // Taking the departure back reverses all of it, at the value it was booked at.
    await revert(id);
    expect((await brief(id, 'ORIGIN_CONSOLIDATOR')).at(-1)).toEqual([
      'REVERSAL',
      currency,
      '-30',
      '-7.5',
    ]);
    await expectLedgerMatches(id);
  });

  it('a partner replaced gives back what it accrued; the new one starts from zero', async () => {
    const id = await shipment();
    await r
      .patch(`/shipments/${id}`, cookies.opsPts, { originConsolidatorId: partners.other.id })
      .expect(200);
    await status(id, 'TRIP_SCHEDULED').expect(200);
    await status(id, 'ROAD_DEPARTED').expect(200);
    expect(await brief(id, 'ORIGIN_CONSOLIDATOR')).toEqual([['ACCRUAL', 'USD', '1', '1']]);
    await r
      .patch(`/shipments/${id}`, cookies.opsPts, { originConsolidatorId: partners.consolidator.id })
      .expect(200);
    const after = await rows(id, 'ORIGIN_CONSOLIDATOR');
    expect(after.map((x) => [x.partnerId, x.kind, x.amount.toFixed()])).toEqual([
      [partners.other.id, 'ACCRUAL', '1'],
      [partners.other.id, 'REVERSAL', '-1'],
      [partners.consolidator.id, 'ACCRUAL', '20'],
    ]);
    await expectLedgerMatches(id);
  });

  it('a distributor earns on a full proof of delivery only, and gives it back when it is cancelled', async () => {
    const id = await shipment();
    await r
      .patch(`/shipments/${id}`, cookies.opsPts, { distributorId: partners.distributor.id })
      .expect(200);
    await invoice(id);
    expect(await rows(id, 'DISTRIBUTOR')).toEqual([]);
    await status(id, 'TRIP_SCHEDULED').expect(200);
    await status(id, 'ROAD_DEPARTED').expect(200);
    await status(id, 'ROAD_ARRIVED').expect(200);
    const pod = (fields: Record<string, string>) => {
      let req = t
        .http()
        .post(`/api/v1/shipments/${id}/pods`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.opsPts);
      for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
      return req.attach('signature', PNG, 'signature.png');
    };
    const base = { recipientName: 'Ahmed Ali', recipientCapacity: 'Consignee' };
    // A partial delivery is not the event.
    await pod({ ...base, shipmentStatus: 'PARTIALLY_DELIVERED' }).expect(201);
    expect(await rows(id, 'DISTRIBUTOR')).toEqual([]);
    const full = (await pod({ ...base, shipmentStatus: 'DELIVERED' }).expect(201)).body as {
      id: string;
    };
    expect(await brief(id, 'DISTRIBUTOR')).toEqual([['ACCRUAL', 'USD', '6', '6']]);
    await r
      .post(`/shipments/${id}/pods/${full.id}/cancel`, cookies.opsPts, {
        reason: 'Wrong recipient',
      })
      .expect(201);
    expect((await brief(id, 'DISTRIBUTOR')).at(-1)).toEqual(['REVERSAL', 'USD', '-6', '-6']);
    await expectLedgerMatches(id);
  });

  it('a DELIVERED status set by hand, without a proof of delivery, earns nothing', async () => {
    const id = await shipment();
    await r
      .patch(`/shipments/${id}`, cookies.opsPts, { distributorId: partners.distributor.id })
      .expect(200);
    await invoice(id);
    await status(id, 'TRIP_SCHEDULED').expect(200);
    await status(id, 'ROAD_DEPARTED').expect(200);
    await status(id, 'ROAD_ARRIVED').expect(200);
    await status(id, 'DELIVERED').expect(200);
    expect(await rows(id, 'DISTRIBUTOR')).toEqual([]);
  });

  describe('manual adjustments and the partner page', () => {
    let id: string;
    beforeAll(async () => {
      id = await shipment();
      await invoice(id);
    });
    const adjust = (cookie: string, body: object, partnerId = partners.outlet.id) =>
      r.post(`/partners/${partnerId}/commissions/adjustments`, cookie, {
        shipmentId: id,
        role: 'SALES_OUTLET',
        currency: 'USD',
        amount: '-2.5',
        reason: 'Agreed discount',
        ...body,
      });

    it('needs the permission, a reason, the partner in that role, and stays through a sync', async () => {
      await adjust(cookies.financePts, {}).expect(403);
      await adjust(cookies.managerJed, {}).expect(404);
      await adjust(cookies.managerPts, { reason: '  ' }).expect(400);
      await adjust(cookies.managerPts, { amount: '0' }).expect(400);
      await adjust(cookies.managerPts, {}, partners.distributor.id).expect(409);
      const page = (await adjust(cookies.managerPts, {}).expect(201)).body as PartnerCommissionsDto;
      expect(page.rows[0]).toMatchObject({
        kind: 'MANUAL',
        amount: '-2.5',
        amountUsd: '-2.5',
        reason: 'Agreed discount',
      });
      await r.post(`/shipments/${id}/commissions/recompute`, cookies.managerPts).expect(200);
      expect(await brief(id, 'SALES_OUTLET')).toEqual([
        ['ACCRUAL', 'USD', '30', '30'],
        ['MANUAL', 'USD', '-2.5', '-2.5'],
      ]);
      await expectLedgerMatches(id);
      const audit = await t.prisma.auditEvent.findFirst({
        where: { entityId: partners.outlet.id },
        orderBy: { occurredAt: 'desc' },
      });
      expect(JSON.stringify(audit?.changes)).toContain('Agreed discount');
    });

    it('shows open balances, rows and holds in the user’s branches only', async () => {
      const page = (
        await r.get(`/partners/${partners.outlet.id}/commissions`, cookies.financePts).expect(200)
      ).body as PartnerCommissionsDto;
      const rowsNow = await t.prisma.commissionAccrual.findMany({
        where: { partnerId: partners.outlet.id, statementId: null },
      });
      const open = (code: string) =>
        sum(rowsNow.filter((x) => x.currency === code).map((x) => x.amount)).toFixed();
      expect(page.balances).toEqual([
        expect.objectContaining({ branchId: pts, currency: 'SAR', open: open('SAR') }),
        expect.objectContaining({ branchId: pts, currency: 'USD', open: open('USD') }),
      ]);
      expect(page.rows.every((x) => x.branchCode === 'PTS')).toBe(true);
      expect(page.canAdjust).toBe(false);
      await r.get(`/partners/${partners.outlet.id}/commissions`, cookies.managerJed).expect(404);
      await r.get(`/partners/${partners.outlet.id}/commissions`, cookies.salesPts).expect(403);
    });
  });
});
