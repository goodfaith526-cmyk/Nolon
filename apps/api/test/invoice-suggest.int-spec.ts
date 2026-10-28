import { randomUUID } from 'node:crypto';
import type {
  AgentClientCreatedDto,
  AuthMeResponse,
  BookingDto,
  BookingItemInput,
  BookingService,
  CustomerDto,
  CustomerInvoiceDto,
  DraftPreCheckDto,
  EntryDraftSummaryDto,
  InvoiceDraftDto,
  InvoiceSuggestionDto,
  QuotationDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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

// POST /invoice-drafts/suggest (docs/trial-2026-10-18-fixes.md, fix D): what NOLON would put on
// an invoice for a shipment, read-only. The charge types, route and rates here are this run's
// own, so no other suite's master data or rates can match, and setting a charge's service here
// changes no other suite. Shipments and invoices are never deleted, so the people keep the ledger
// prefix (outside the usual cleanup).

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let pts: string;
let jed: string;
let from: string;
let to: string;
let customer: CustomerDto;

const cookies = { admin: '', salesPts: '', financePts: '' };
const tokens = { sales: '', finance: '', financeJed: '' };
const rates: Record<string, string> = {};
/** This run's charge types, by role: their codes. */
const charge: Record<'freight' | 'pickup' | 'docs' | 'delivery' | 'thc' | 'customs', string> = {
  freight: '',
  pickup: '',
  docs: '',
  delivery: '',
  thc: '',
  customs: '',
};

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const PAYMENT_TERMS = 15;

const suggest = (body: object, token = tokens.finance) =>
  r.agentPost('/invoice-drafts/suggest', token, body);

async function suggestion(body: object): Promise<InvoiceSuggestionDto> {
  return (await suggest(body).expect(200)).body as InvoiceSuggestionDto;
}

/** An approved (or other) rate card of PTS on this run's route, ROAD, general cargo. */
async function rate(
  key: string,
  values: {
    chargeTypeCode: string;
    unit: 'PER_SHIPMENT' | 'PER_KG' | 'PER_CBM';
    price: string;
    minimumCharge?: string;
    currency?: string;
    status?: 'APPROVED' | 'DRAFT';
  },
  createdById: string,
): Promise<void> {
  const created = await t.prisma.rateCard.create({
    data: {
      branchId: pts,
      originLocationId: from,
      destinationLocationId: to,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      chargeTypeCode: values.chargeTypeCode,
      unit: values.unit,
      price: values.price,
      minimumCharge: values.minimumCharge ?? '0',
      currency: values.currency ?? 'USD',
      validFrom: new Date(`${day(-30)}T00:00:00Z`),
      validTo: null,
      status: values.status ?? 'APPROVED',
      createdById,
      ...(values.status === 'DRAFT' ? {} : { approvedById: createdById, approvedAt: new Date() }),
    },
  });
  rates[key] = created.id;
}

async function confirmed(booking: BookingDto): Promise<string> {
  const done = (await r.post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
    .body as BookingDto;
  if (!done.shipmentId) throw new Error('No shipment');
  return done.shipmentId;
}

/** A shipment of this run's route booked directly (no quotation). */
async function directShipment(
  items: BookingItemInput[] = [{ cargoType: 'GENERAL', quantity: 1, weightKg: '10' }],
  services: BookingService[] = ['MAIN_FREIGHT'],
): Promise<string> {
  const booking = (
    await r
      .post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services,
        items,
      })
      .expect(201)
  ).body as BookingDto;
  return confirmed(booking);
}

/** A shipment of this run's route, booked from an approved quotation with these lines. */
async function quotedShipment(
  lines: object[],
  currency = 'USD',
  items: BookingItemInput[] = [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
): Promise<string> {
  const quotation = (
    await r
      .post('/quotations', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        currency,
        validUntil: day(10),
        lines,
      })
      .expect(201)
  ).body as QuotationDto;
  await r.post(`/quotations/${quotation.id}/send`, cookies.salesPts).expect(200);
  await r.post(`/quotations/${quotation.id}/approve`, cookies.salesPts).expect(200);
  const booking = (
    await r
      .post(`/bookings/from-quotation/${quotation.id}`, cookies.salesPts, {
        services: ['MAIN_FREIGHT'],
        items,
      })
      .expect(201)
  ).body as BookingDto;
  return confirmed(booking);
}

const written = async () => ({
  invoices: await t.prisma.customerInvoice.count(),
  drafts: await t.prisma.invoiceDraft.count(),
});

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  pts = await branchId(t.prisma, 'PTS');
  jed = await branchId(t.prisma, 'JED');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
    financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const agents = {
    sales: await createUser(t.prisma, ['SALES'], ['PTS'], AGENT_PREFIX),
    finance: await createUser(t.prisma, ['FINANCE'], ['PTS'], AGENT_PREFIX),
    financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], AGENT_PREFIX),
  };
  client = await registerClient(t, cookies.admin, 'Invoice suggestion platform');
  for (const key of Object.keys(agents) as (keyof typeof agents)[]) {
    tokens[key] = await tokenFor(t, await signIn(t, agents[key].email), client);
  }

  const tag = `IS${randomUUID().slice(0, 6).toUpperCase()}`;
  const location = async (suffix: string) =>
    (
      await t.prisma.location.create({
        data: {
          code: `${tag}${suffix}`,
          kind: 'CITY',
          nameEn: `Suggestion test ${tag}${suffix}`,
          nameAr: 'مدينة اختبار الاقتراح',
          countryCode: 'SD',
        },
      })
    ).id;
  from = await location('A');
  to = await location('B');
  const services: Record<keyof typeof charge, BookingService | null> = {
    freight: 'MAIN_FREIGHT',
    pickup: 'PICKUP',
    docs: null,
    delivery: 'MAIN_FREIGHT',
    thc: 'MAIN_FREIGHT',
    customs: 'CUSTOMS',
  };
  for (const key of Object.keys(services) as (keyof typeof charge)[]) {
    charge[key] = `${tag}${key.slice(0, 3).toUpperCase()}`;
    await t.prisma.chargeType.create({
      data: {
        code: charge[key],
        nameEn: `Suggestion ${key}`,
        nameAr: 'رسم اختبار',
        service: services[key],
      },
    });
  }
  customer = (
    await r
      .post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Invoice Suggestion ${tag}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
        paymentTermsDays: PAYMENT_TERMS,
      })
      .expect(201)
  ).body as CustomerDto;

  const by = people.salesPts.id;
  await rate('freight', { chargeTypeCode: charge.freight, unit: 'PER_SHIPMENT', price: '300' }, by);
  await rate(
    'freightEur',
    { chargeTypeCode: charge.freight, unit: 'PER_SHIPMENT', price: '280', currency: 'EUR' },
    by,
  );
  // PICKUP is not a service of the shipments here; DOCS belongs to no service.
  await rate('pickup', { chargeTypeCode: charge.pickup, unit: 'PER_SHIPMENT', price: '40' }, by);
  await rate('docs', { chargeTypeCode: charge.docs, unit: 'PER_SHIPMENT', price: '15' }, by);
  // DELIVERY: 1 per kg, at least 50.
  await rate(
    'delivery',
    { chargeTypeCode: charge.delivery, unit: 'PER_KG', price: '1', minimumCharge: '50' },
    by,
  );
  // THC: two units match, so no line is suggested for it.
  await rate('thcKg', { chargeTypeCode: charge.thc, unit: 'PER_KG', price: '0.5' }, by);
  await rate('thcCbm', { chargeTypeCode: charge.thc, unit: 'PER_CBM', price: '20' }, by);
  // CUSTOMS only as a draft: never suggested.
  await rate(
    'customsDraft',
    { chargeTypeCode: charge.customs, unit: 'PER_SHIPMENT', price: '70', status: 'DRAFT' },
    by,
  );
});

afterAll(async () => {
  await t.close();
});

describe('invoice suggestion: a shipment without a quotation', () => {
  it('suggests one line per charge with one approved rate, filling only what the shipment shows', async () => {
    const shipmentId = await directShipment();
    const before = await written();
    const result = await suggestion({ shipmentId });
    const today = (
      (await r.agentGet('/auth/me', tokens.finance).expect(200)).body as AuthMeResponse
    ).branches.find((b) => b.id === pts)?.today;
    expect(result).toMatchObject({
      shipmentId,
      branchId: pts,
      currency: 'USD',
      currencySource: 'CUSTOMER',
      invoiceDate: today,
    });
    const due = new Date(`${today}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + PAYMENT_TERMS);
    expect(result.dueDate).toBe(due.toISOString().slice(0, 10));
    expect(
      result.lines.map((l) => [l.chargeTypeCode, l.quantity, l.unitPrice, l.rateCardId, l.use]),
    ).toEqual(
      [
        // 10 kg × 1 < 50: the minimum, as one unit.
        [charge.delivery, '1', '50', rates.delivery, 'FILL'],
        [charge.docs, '1', '15', rates.docs, 'OFFER'],
        [charge.freight, '1', '300', rates.freight, 'FILL'],
        [charge.pickup, '1', '40', rates.pickup, 'OFFER'],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(result.lines.every((l) => l.priceSource === 'RATE_CARD')).toBe(true);
    const at = (code: string) => result.lines.findIndex((l) => l.chargeTypeCode === code);
    expect(result.unresolved.map((u) => [u.path, u.code]).sort()).toEqual(
      [
        [`lines.${at(charge.docs)}`, 'SERVICE_NOT_MAPPED'],
        [`lines.${at(charge.pickup)}`, 'SERVICE_NOT_ON_SHIPMENT'],
        ['lines', 'RATE_SEVERAL'],
      ].sort(),
    );
    expect(result.unresolved.find((u) => u.code === 'RATE_SEVERAL')?.message).toContain(charge.thc);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Read-only: nothing is written, and the same request gives the same fingerprint.
    expect(await written()).toEqual(before);
    expect((await suggestion({ shipmentId })).fingerprint).toBe(result.fingerprint);
  });

  it('derives for the currency and invoice date asked for', async () => {
    const shipmentId = await directShipment();
    const usd = await suggestion({ shipmentId });
    const eur = await suggestion({ shipmentId, currency: 'EUR', invoiceDate: day(-3) });
    expect(eur).toMatchObject({
      currency: 'EUR',
      currencySource: 'REQUESTED',
      invoiceDate: day(-3),
    });
    expect(eur.lines.map((l) => [l.chargeTypeCode, l.unitPrice, l.rateCardId])).toEqual([
      [charge.freight, '280', rates.freightEur],
    ]);
    expect(eur.fingerprint).not.toBe(usd.fingerprint);
    const dated = await suggestion({ shipmentId, invoiceDate: day(-3) });
    expect(dated.fingerprint).not.toBe(usd.fingerprint);
    // Before any rate started, nothing matches.
    expect((await suggestion({ shipmentId, invoiceDate: day(-60) })).lines).toEqual([]);
  });

  it('leaves the quantity empty when one cargo line has no weight, and so does not fill it', async () => {
    const shipmentId = await directShipment([
      { cargoType: 'GENERAL', quantity: 2, weightKg: '100' },
      { cargoType: 'GENERAL', quantity: 1 },
    ]);
    const result = await suggestion({ shipmentId });
    const index = result.lines.findIndex((l) => l.chargeTypeCode === charge.delivery);
    expect(result.lines[index]).toMatchObject({ quantity: null, unitPrice: '1', use: 'OFFER' });
    expect(result.unresolved).toContainEqual(
      expect.objectContaining({ path: `lines.${index}.quantity`, code: 'QUANTITY_UNKNOWN' }),
    );
  });

  it('fills a rate card line once the shipment has its service', async () => {
    const shipmentId = await directShipment(undefined, ['MAIN_FREIGHT', 'PICKUP']);
    const result = await suggestion({ shipmentId });
    expect(result.lines.find((l) => l.chargeTypeCode === charge.pickup)).toMatchObject({
      service: 'PICKUP',
      use: 'FILL',
    });
  });

  it('creates the invoice from the same derivation: only the lines it fills', async () => {
    const shipmentId = await directShipment();
    const suggested = await suggestion({ shipmentId });
    const invoice = (
      await r.post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    expect(invoice.currency).toBe(suggested.currency);
    expect([invoice.invoiceDate, invoice.dueDate]).toEqual([
      suggested.invoiceDate,
      suggested.dueDate,
    ]);
    expect(invoice.lines.map((l) => [l.chargeTypeCode, l.quantity, l.unitPrice])).toEqual(
      suggested.lines
        .filter((l) => l.use === 'FILL')
        .map((l) => [l.chargeTypeCode, l.quantity, l.unitPrice]),
    );
    expect(invoice.total).toBe('350');
  });
});

describe('invoice suggestion: a minimum charge above the price per unit (Codex N89-1, N89-3)', () => {
  it('fills 0.25 kg at 100 per kg with a minimum of 60 as 1 × 60 with its price, and prices 1 unit with no price as 100', async () => {
    // Its own route and charge, so the other cases' rates are untouched.
    const tag = `MN${randomUUID().slice(0, 6).toUpperCase()}`;
    const place = async (suffix: string) =>
      (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Minimum test ${tag}${suffix}`,
            nameAr: 'مدينة اختبار الحد الأدنى',
            countryCode: 'SD',
          },
        })
      ).id;
    const [origin, destination] = [await place('A'), await place('B')];
    const code = `${tag}KG`;
    await t.prisma.chargeType.create({
      data: { code, nameEn: 'Minimum test', nameAr: 'رسم اختبار', service: 'MAIN_FREIGHT' },
    });
    const by = (await t.prisma.user.findFirstOrThrow({ select: { id: true } })).id;
    await t.prisma.rateCard.create({
      data: {
        branchId: pts,
        originLocationId: origin,
        destinationLocationId: destination,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        chargeTypeCode: code,
        unit: 'PER_KG',
        price: '100',
        minimumCharge: '60',
        currency: 'USD',
        validFrom: new Date(`${day(-30)}T00:00:00Z`),
        validTo: null,
        status: 'APPROVED',
        createdById: by,
        approvedById: by,
        approvedAt: new Date(),
      },
    });
    const booking = (
      await r
        .post('/bookings', cookies.salesPts, {
          customerId: customer.id,
          originLocationId: origin,
          destinationLocationId: destination,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          services: ['MAIN_FREIGHT'],
          items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '0.25' }],
        })
        .expect(201)
    ).body as BookingDto;
    const shipmentId = await confirmed(booking);
    const suggested = await suggestion({ shipmentId });
    // 1 × 60 is what the tariff gives, but 1 unit with no price is 1 × 100: filled with its
    // price, marked so the price is sent with the line (owner 2026-10-18).
    expect(suggested.lines).toEqual([
      expect.objectContaining({
        chargeTypeCode: code,
        quantity: '1',
        unitPrice: '60',
        use: 'FILL',
        fillPrice: true,
      }),
    ]);
    expect(suggested.unresolved).toEqual([]);
    const body = (lines: object[]) => ({
      idempotencyKey: draftKey(),
      shipmentId,
      currency: suggested.currency,
      invoiceDate: suggested.invoiceDate,
      dueDate: suggested.dueDate,
      notes: null,
      lines,
    });
    const check = async (lines: object[]) =>
      (await r.agentPost('/invoice-drafts/check', tokens.finance, body(lines)).expect(200))
        .body as DraftPreCheckDto;
    // A caller's 1 unit with no price stays quantity × the system price (Codex N89-3): 100.
    expect(await check([{ chargeTypeCode: code, quantity: '1' }])).toMatchObject({
      ok: true,
      total: '100',
      computed: [{ field: 'lines.0.unitPrice', value: '100', source: 'RATE_CARD' }],
    });
    // The line as the suggestion fills it, its price sent: 60, in the check and in the draft made.
    const minimum = [{ chargeTypeCode: code, quantity: '1', unitPrice: '60' }];
    expect(await check(minimum)).toMatchObject({ ok: true, total: '60' });
    const created = (
      await r.agentPost('/invoice-drafts', tokens.finance, body(minimum)).expect(201)
    ).body as EntryDraftSummaryDto;
    const draft = (await r.get(`/invoice-drafts/${created.id}`, cookies.financePts).expect(200))
      .body as InvoiceDraftDto;
    expect(draft.check).toMatchObject({ ok: true, total: '60' });
    // A quantity other than one below the minimum is still asked as one unit, never priced.
    const asked = await check([{ chargeTypeCode: code, quantity: '0.25' }]);
    expect(!asked.ok && asked.refusals.map((x) => x.code)).toEqual(['PRICE_AS_ONE_UNIT']);
    // The direct create fills the same line: 1 × 60.
    const invoice = (
      await r.post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    expect(invoice.lines).toEqual([
      expect.objectContaining({ chargeTypeCode: code, quantity: '1', unitPrice: '60' }),
    ]);
    expect(invoice.total).toBe('60');
  });
});

describe('invoice suggestion: a shipment with a quotation', () => {
  it("takes the quotation's lines and currency, and prices none in another currency", async () => {
    const shipmentId = await quotedShipment([
      { chargeTypeCode: charge.freight, unit: 'PER_SHIPMENT', quantity: '2', unitPrice: '100' },
      {
        chargeTypeCode: charge.docs,
        unit: 'PER_SHIPMENT',
        quantity: '1',
        unitPrice: '30',
        discount: '5',
      },
    ]);
    const own = await suggestion({ shipmentId });
    expect(own).toMatchObject({ currency: 'USD', currencySource: 'QUOTATION', unresolved: [] });
    // The quotation is the agreement: its lines are filled, a discounted one as one unit.
    expect(own.lines.map((l) => [l.chargeTypeCode, l.quantity, l.unitPrice, l.use])).toEqual([
      [charge.freight, '2', '100', 'FILL'],
      [charge.docs, '1', '25', 'FILL'],
    ]);
    expect(own.lines.every((l) => l.priceSource === 'QUOTATION' && l.rateCardId === null)).toBe(
      true,
    );

    const other = await suggestion({ shipmentId, currency: 'EUR' });
    expect(other.lines.map((l) => [l.unitPrice, l.use])).toEqual([
      [null, 'OFFER'],
      [null, 'OFFER'],
    ]);
    expect(other.unresolved.map((u) => [u.path, u.code])).toEqual([
      ['lines.0.unitPrice', 'QUOTED_PRICE_OTHER_CURRENCY'],
      ['lines.1.unitPrice', 'QUOTED_PRICE_OTHER_CURRENCY'],
    ]);
    expect(other.fingerprint).not.toBe(own.fingerprint);
  });

  it('changes currency only with every price entered anew, whatever the numbers (Codex F92-1)', async () => {
    const shipmentId = await quotedShipment([
      { chargeTypeCode: charge.freight, unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '100' },
    ]);
    const invoice = (
      await r.post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    // The table's rate: none was entered.
    expect(invoice.enteredFxRate).toBeNull();
    const path = `/customer-invoices/${invoice.id}`;
    const edit = (currency: string, price: string, extra: object = {}) =>
      r.patch(path, cookies.financePts, {
        currency,
        fxRate: currency === 'USD' ? null : '1.1',
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        lines: [{ chargeTypeCode: charge.freight, quantity: '1', unitPrice: price }],
        ...extra,
      });
    // USD → EUR: refused unless the prices were entered in EUR, even a different number.
    const refused = await edit('EUR', '92').expect(400);
    expect(refused.body).toMatchObject({
      code: 'INVOICE_CURRENCY_REPRICE',
      fields: ['currency'],
      params: { from: 'USD', to: 'EUR' },
    });
    const eur = (await edit('EUR', '92', { repriced: true }).expect(200))
      .body as CustomerInvoiceDto;
    expect([eur.currency, eur.total, eur.enteredFxRate]).toEqual(['EUR', '92', '1.1']);
    // EUR → AED with the EUR prices as they stand: refused (not compared with the quotation).
    await edit('AED', '92').expect(400);
    // A price equal to the quoted number is fine when entered in the invoice's own currency.
    const same = (await edit('EUR', '100').expect(200)).body as CustomerInvoiceDto;
    expect([same.currency, same.total]).toEqual(['EUR', '100']);
    expect((await r.get(path, cookies.financePts).expect(200)).body).toMatchObject({
      currency: 'EUR',
    });
  });
});

describe('invoice suggestion: a shipment that is no longer what its quotation priced (plan 5.2)', () => {
  // A function: the charge codes are made in beforeAll.
  const quoted = (priceCategoryCode?: string) => [
    {
      chargeTypeCode: charge.freight,
      unit: 'PER_SHIPMENT',
      quantity: '2',
      unitPrice: '100',
      ...(priceCategoryCode ? { priceCategoryCode } : {}),
    },
  ];

  it('prices from the rate cards, and says why, when the categories changed', async () => {
    // The quotation priced general cargo; the booking's line is a carton.
    const shipmentId = await quotedShipment(quoted(), 'USD', [
      { cargoType: 'GENERAL', quantity: 1, weightKg: '100', priceCategoryCode: 'CARTON' },
    ]);
    const derived = await suggestion({ shipmentId });
    expect(derived.currencySource).toBe('CUSTOMER');
    expect(derived.unresolved.map((u) => [u.path, u.code])).toContainEqual([
      'lines',
      'QUOTATION_CATEGORY_CHANGED',
    ]);
    expect(derived.lines.some((l) => l.priceSource === 'QUOTATION')).toBe(false);
    // No carton card yet: the general freight card.
    expect(derived.lines.find((l) => l.chargeTypeCode === charge.freight)?.rateCardId).toBe(
      rates.freight,
    );

    // The staff member who opens the draft is told why too (Codex F139-1).
    const draft = (
      await r.post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    const notice = {
      code: 'QUOTATION_CATEGORY_CHANGED',
      quotationNumber: expect.stringMatching(/\S/) as unknown,
    };
    expect(draft.pricingNotice).toEqual(notice);
    expect(
      (await r.get(`/customer-invoices/${draft.id}`, cookies.financePts).expect(200)).body,
    ).toMatchObject({ pricingNotice: notice });
    await r
      .post(`/customer-invoices/${draft.id}/cancel`, cookies.financePts, { reason: 'test' })
      .expect(200);

    // A carton card for the freight is the one the carton shipment is priced from.
    const carton = await t.prisma.rateCard.create({
      data: {
        branchId: pts,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        priceCategoryCode: 'CARTON',
        chargeTypeCode: charge.freight,
        unit: 'PER_SHIPMENT',
        price: '250',
        minimumCharge: '0',
        currency: 'USD',
        validFrom: new Date(`${day(-30)}T00:00:00Z`),
        status: 'APPROVED',
        createdById: (await t.prisma.user.findFirstOrThrow()).id,
        approvedById: (await t.prisma.user.findFirstOrThrow()).id,
        approvedAt: new Date(),
      },
    });
    try {
      const again = await suggestion({ shipmentId });
      expect(
        again.lines
          .filter((l) => l.chargeTypeCode === charge.freight)
          .map((l) => [l.rateCardId, l.unitPrice, l.priceSource]),
      ).toEqual([[carton.id, '250', 'RATE_CARD']]);
      expect(again.fingerprint).not.toBe(derived.fingerprint);

      // A line entered without a price takes the same price, not the quotation's 100.
      const checked = (
        await r
          .agentPost('/invoice-drafts/check', tokens.finance, {
            idempotencyKey: draftKey(),
            shipmentId,
            currency: 'USD',
            invoiceDate: day(0),
            dueDate: day(30),
            notes: null,
            lines: [{ chargeTypeCode: charge.freight, quantity: '1' }],
          })
          .expect(200)
      ).body as DraftPreCheckDto;
      expect(checked.ok && checked.total).toBe('250');
    } finally {
      await t.prisma.rateCard.update({ where: { id: carton.id }, data: { status: 'CANCELLED' } });
    }
  });

  it('keeps the quotation while the categories are the same', async () => {
    const shipmentId = await quotedShipment(quoted('CARTON'), 'USD', [
      { cargoType: 'GENERAL', quantity: 1, weightKg: '60', priceCategoryCode: 'CARTON' },
      { cargoType: 'GENERAL', quantity: 2, weightKg: '40', priceCategoryCode: 'CARTON' },
    ]);
    const derived = await suggestion({ shipmentId });
    expect(derived).toMatchObject({ currencySource: 'QUOTATION', unresolved: [] });
    expect(derived.lines.map((l) => [l.quantity, l.unitPrice, l.priceSource])).toEqual([
      ['2', '100', 'QUOTATION'],
    ]);
    const draft = (
      await r.post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    expect(draft.pricingNotice).toBeNull();
  });

  it('prices from the rate cards, and says why, when the route changed', async () => {
    const shipmentId = await quotedShipment(quoted());
    // Changed after the booking (a correction of the destination): the quotation's prices
    // were for the old route.
    const elsewhere = await t.prisma.location.create({
      data: {
        code: `ISX${randomUUID().slice(0, 6).toUpperCase()}`,
        kind: 'CITY',
        nameEn: 'Another city',
        nameAr: 'مدينة أخرى',
        countryCode: 'SD',
      },
    });
    await t.prisma.shipment.update({
      where: { id: shipmentId },
      data: { destinationLocationId: elsewhere.id },
    });
    const derived = await suggestion({ shipmentId });
    expect(derived.unresolved.map((u) => u.code)).toContain('QUOTATION_ROUTE_CHANGED');
    // No rate card prices the new route, and the quotation's lines are not used.
    expect(derived.lines).toEqual([]);
    const checked = (
      await r
        .agentPost('/invoice-drafts/check', tokens.finance, {
          idempotencyKey: draftKey(),
          shipmentId,
          currency: 'USD',
          invoiceDate: day(0),
          dueDate: day(30),
          notes: null,
          lines: [{ chargeTypeCode: charge.freight, quantity: '1' }],
        })
        .expect(200)
    ).body as DraftPreCheckDto;
    expect(!checked.ok && checked.refusals.map((x) => [x.field, x.code])).toEqual([
      ['lines.0.unitPrice', 'RATE_NO_MATCH'],
    ]);
  });
});

describe('invoice suggestion: access', () => {
  it("refuses another branch's shipment, a sharing branch's, and a user without the permission", async () => {
    const shipmentId = await directShipment();
    await suggest({ shipmentId }, tokens.financeJed).expect(404);
    // A sharing branch sees the shipment, never its billing.
    await t.prisma.shipmentBranch.create({ data: { shipmentId, branchId: jed } });
    await suggest({ shipmentId }, tokens.financeJed).expect(404);
    await suggest({ shipmentId }, tokens.sales).expect(403);
    await suggest({ shipmentId: randomUUID() }).expect(404);
  });

  it('refuses a cancelled shipment and a malformed body', async () => {
    const shipmentId = await directShipment();
    await r
      .post(`/shipments/${shipmentId}/cancel`, cookies.admin, { reason: 'Customer withdrew' })
      .expect(200);
    await suggest({ shipmentId }).expect(409);
    const live = await directShipment();
    await suggest({ shipmentId: live, currency: 'usd' }).expect(400);
    await suggest({ shipmentId: live, invoiceDate: '18-10-2026' }).expect(400);
    await suggest({ shipmentId: live, lines: [] }).expect(400);
    await suggest({ shipmentId: live, currency: 'XXX' }).expect(400);
  });
});

describe('invoice draft pre-check: every line', () => {
  it('names each line that cannot be priced, not only the first', async () => {
    const shipmentId = await directShipment();
    const body = {
      idempotencyKey: draftKey(),
      shipmentId,
      currency: 'USD',
      invoiceDate: day(0),
      dueDate: day(30),
      notes: null,
      lines: [
        { chargeTypeCode: charge.thc, quantity: '1' },
        { chargeTypeCode: charge.freight, quantity: '1' },
        { chargeTypeCode: charge.customs, quantity: '1' },
      ],
    };
    const checked = (await r.agentPost('/invoice-drafts/check', tokens.finance, body).expect(200))
      .body as DraftPreCheckDto;
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.refusals.map((x) => [x.field, x.code])).toEqual([
      ['lines.0.unitPrice', 'RATE_SEVERAL'],
      ['lines.2.unitPrice', 'RATE_NO_MATCH'],
    ]);
    // A create still stops at the first refusal, and writes nothing.
    const before = await written();
    const refused = await r.agentPost('/invoice-drafts', tokens.finance, body).expect(400);
    expect((refused.body as { code?: string }).code).toBe('RATE_SEVERAL');
    expect(await written()).toEqual(before);
  });
});

describe('/auth/me: the branch default currency', () => {
  it("gives each of the user's branches its default currency", async () => {
    const me = (await r.agentGet('/auth/me', tokens.finance).expect(200)).body as AuthMeResponse;
    const branch = await t.prisma.branch.findUniqueOrThrow({ where: { id: pts } });
    expect(me.branches).toEqual([
      expect.objectContaining({ id: pts, defaultCurrency: branch.defaultCurrency }),
    ]);
  });
});
