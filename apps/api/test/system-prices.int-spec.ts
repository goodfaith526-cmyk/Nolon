import { randomUUID } from 'node:crypto';
import type {
  DraftPreCheckDto,
  AgentClientCreatedDto,
  AssistantDraftDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  EntryDraftSummaryDto,
  InvoiceDraftDto,
  QuotationDraftDto,
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

// The system price (owner, 2026-10-13: "the price should come from the system, I priced the
// lines; a button for a different price"). A quotation line with no rate card and no price takes
// the one approved rate card that matches; an invoice draft line with no price takes the
// shipment's quotation price for that charge, else the matching rate card. The rates here are on
// a route of this run's own two locations, so no other suite's rate can match. Confirmed bookings
// make shipments and approved invoice drafts make invoices, which are never deleted, so the
// people keep the ledger prefix (outside the usual cleanup).

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let pts: string;
let jed: string;
let from: string;
let to: string;
let customer: CustomerDto;
let ratesBy: string;

const cookies = { admin: '', salesPts: '', financePts: '' };
const tokens = { sales: '', finance: '', financeJed: '' };
const rates: Record<string, string> = {};

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day(0);
const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
const fields = (res: { body: unknown }) => (res.body as { fields?: string[] }).fields;
const message = (res: { body: unknown }) => (res.body as { message?: string }).message ?? '';

/** An approved (or other) rate card of PTS on this run's route, ROAD, general cargo. */
async function rate(
  key: string,
  values: {
    chargeTypeCode: string;
    unit: 'PER_SHIPMENT' | 'PER_KG' | 'PER_CBM';
    price: string;
    minimumCharge?: string;
    currency?: string;
    validFrom?: string;
    branchId?: string;
    status?: 'APPROVED' | 'DRAFT';
  },
  createdById: string,
): Promise<void> {
  const created = await t.prisma.rateCard.create({
    data: {
      branchId: values.branchId ?? pts,
      originLocationId: from,
      destinationLocationId: to,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      chargeTypeCode: values.chargeTypeCode,
      unit: values.unit,
      price: values.price,
      minimumCharge: values.minimumCharge ?? '0',
      currency: values.currency ?? 'USD',
      validFrom: new Date(`${values.validFrom ?? day(-30)}T00:00:00Z`),
      validTo: null,
      status: values.status ?? 'APPROVED',
      createdById,
      ...(values.status === 'DRAFT' ? {} : { approvedById: createdById, approvedAt: new Date() }),
    },
  });
  rates[key] = created.id;
}

function quotationRequest(lines: object[], extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    customerId: customer.id,
    originLocationId: from,
    destinationLocationId: to,
    mode: 'ROAD',
    cargoType: 'GENERAL',
    currency: 'USD',
    validUntil: day(10),
    lines,
    ...extra,
  };
}

const createQuotationDraft = (body: object) => r.agentPost('/quotation-drafts', tokens.sales, body);

async function quotationDraft(lines: object[], extra: object = {}): Promise<QuotationDraftDto> {
  const created = (await createQuotationDraft(quotationRequest(lines, extra)).expect(201))
    .body as EntryDraftSummaryDto;
  return (await r.get(`/quotation-drafts/${created.id}`, cookies.salesPts).expect(200))
    .body as QuotationDraftDto;
}

/** A shipment of this run's route, booked from an approved quotation with these lines. */
async function quotedShipment(lines: object[], currency = 'USD'): Promise<string> {
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
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
      })
      .expect(201)
  ).body as BookingDto;
  return confirmed(booking);
}

/** A shipment of this run's route booked directly (no quotation). */
async function directShipment(): Promise<string> {
  const booking = (
    await r
      .post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
      })
      .expect(201)
  ).body as BookingDto;
  return confirmed(booking);
}

async function confirmed(booking: BookingDto): Promise<string> {
  const done = (await r.post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
    .body as BookingDto;
  if (!done.shipmentId) throw new Error('No shipment');
  return done.shipmentId;
}

function invoiceRequest(shipmentId: string, lines: object[], extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    shipmentId,
    currency: 'USD',
    invoiceDate: today,
    dueDate: day(30),
    notes: null,
    lines,
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
  client = await registerClient(t, cookies.admin, 'System price platform');
  for (const key of Object.keys(agents) as (keyof typeof agents)[]) {
    tokens[key] = await tokenFor(t, await signIn(t, agents[key].email), client);
  }

  const tag = `SP${randomUUID().slice(0, 6).toUpperCase()}`;
  const location = async (suffix: string) =>
    (
      await t.prisma.location.create({
        data: {
          code: `${tag}${suffix}`,
          kind: 'CITY',
          nameEn: `Price test ${tag}${suffix}`,
          nameAr: 'مدينة اختبار السعر',
          countryCode: 'SD',
        },
      })
    ).id;
  from = await location('A');
  to = await location('B');
  customer = (
    await r
      .post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `System Price ${tag}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      })
      .expect(201)
  ).body as CustomerDto;

  const by = people.salesPts.id;
  ratesBy = by;
  // FREIGHT: the current rate, and an older one of the same offer it replaces.
  await rate('freight', { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', price: '250.125' }, by);
  await rate(
    'freightOld',
    { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', price: '999', validFrom: day(-60) },
    by,
  );
  await rate(
    'freightSdg',
    { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', price: '600000', currency: 'SDG' },
    by,
  );
  // THC: two units, so the line must say which.
  await rate('thcKg', { chargeTypeCode: 'THC', unit: 'PER_KG', price: '0.5' }, by);
  await rate('thcCbm', { chargeTypeCode: 'THC', unit: 'PER_CBM', price: '20' }, by);
  // STORAGE only in another branch; DOCS only as a draft: neither prices a PTS line.
  await rate(
    'storageJed',
    { chargeTypeCode: 'STORAGE', unit: 'PER_SHIPMENT', price: '40', branchId: jed },
    by,
  );
  await rate(
    'docsDraft',
    { chargeTypeCode: 'DOCS', unit: 'PER_SHIPMENT', price: '15', status: 'DRAFT' },
    by,
  );
  // DELIVERY: 1 per kg, at least 50.
  await rate(
    'delivery',
    { chargeTypeCode: 'DELIVERY', unit: 'PER_KG', price: '1', minimumCharge: '50' },
    by,
  );
});

afterAll(async () => {
  await t.close();
});

describe('quotation drafts: the system price', () => {
  it('prices a line without rate card or price from the one rate card that matches', async () => {
    const lines = [
      { chargeTypeCode: 'FREIGHT', quantity: '3' },
      { chargeTypeCode: 'CUSTOMS', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '75' },
    ];
    // The pre-check finds the price NOLON fills in, before any draft is made.
    const checked = (
      await r
        .agentPost('/quotation-drafts/check', tokens.sales, quotationRequest(lines))
        .expect(200)
    ).body as DraftPreCheckDto;
    expect(checked).toMatchObject({
      ok: true,
      total: '825.38',
      currency: 'USD',
      computed: [
        {
          field: 'lines.0.unitPrice',
          value: '250.125',
          source: 'RATE_CARD',
          rateCardId: rates.freight,
        },
      ],
    });
    const draft = await quotationDraft(lines);
    // The request stays as proposed (no price); the pricing is the rate card's, newest start.
    expect(draft.request.lines[0]).not.toHaveProperty('unitPrice');
    expect(draft.check).toMatchObject({ ok: true, currency: 'USD' });
    expect(draft.pricing?.lines.map((l) => [l.chargeTypeCode, l.unit, l.unitPrice])).toEqual([
      ['FREIGHT', 'PER_SHIPMENT', '250.125'],
      ['CUSTOMS', 'PER_SHIPMENT', '75'],
    ]);
    // 3 × 250.125 = 750.375, rounded half away from zero to the currency: 750.38.
    expect(draft.pricing?.lines[0]?.lineTotal).toBe('750.38');
    expect(draft.pricing?.total).toBe('825.38');
    expect(draft.priceSources).toEqual([
      { source: 'RATE_CARD', rateCardId: rates.freight },
      { source: 'TYPED', rateCardId: null },
    ]);

    const approved = (
      await r
        .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesPts, {
          version: draft.version,
          pricingKey: draft.pricing?.key,
        })
        .expect(200)
    ).body as QuotationDraftDto;
    const quotation = (await r.get(`/quotations/${approved.quotationId}`, cookies.salesPts))
      .body as QuotationDto;
    expect(quotation.lines[0]).toMatchObject({
      rateCardId: rates.freight,
      unitPrice: '250.125',
      lineTotal: '750.38',
    });
    expect(quotation.total).toBe('825.38');
  });

  it('takes the rate card of the quotation currency, and of the line unit when given', async () => {
    const sdg = await quotationDraft([{ chargeTypeCode: 'FREIGHT', quantity: '1' }], {
      currency: 'SDG',
    });
    expect(sdg.priceSources).toEqual([{ source: 'RATE_CARD', rateCardId: rates.freightSdg }]);
    const kg = await quotationDraft([{ chargeTypeCode: 'THC', unit: 'PER_KG', quantity: '100' }]);
    expect(kg.priceSources).toEqual([{ source: 'RATE_CARD', rateCardId: rates.thcKg }]);
    expect(kg.pricing?.total).toBe('50');
  });

  it('refuses, under the line, when no rate card or several match', async () => {
    const before = await t.prisma.quotationDraft.count();
    for (const charge of ['STORAGE', 'DOCS', 'PICKUP']) {
      // Another branch's rate, a rate not approved, no rate at all.
      const res = await createQuotationDraft(
        quotationRequest([{ chargeTypeCode: charge, quantity: '1' }]),
      ).expect(400);
      expect(code(res), charge).toBe('RATE_NO_MATCH');
      expect(fields(res), charge).toEqual(['lines.0.unitPrice']);
    }
    const several = await createQuotationDraft(
      quotationRequest([{ chargeTypeCode: 'THC', quantity: '1' }]),
    ).expect(400);
    expect(code(several)).toBe('RATE_SEVERAL');
    expect(fields(several)).toEqual(['lines.0.rateCardId']);
    expect(message(several)).toContain(rates.thcKg);
    expect(message(several)).toContain(rates.thcCbm);
    // Typing the price is always possible.
    await createQuotationDraft(
      quotationRequest([{ chargeTypeCode: 'THC', unit: 'PER_KG', quantity: '1', unitPrice: '9' }]),
    ).expect(201);
    expect(await t.prisma.quotationDraft.count()).toBe(before + 1);
  });

  it('re-checks the rate card on approval: a rate cancelled since is refused', async () => {
    await rate('pickup', { chargeTypeCode: 'PICKUP', unit: 'PER_SHIPMENT', price: '30' }, ratesBy);
    const draft = await quotationDraft([{ chargeTypeCode: 'PICKUP', quantity: '1' }]);
    expect(draft.priceSources).toEqual([{ source: 'RATE_CARD', rateCardId: rates.pickup }]);
    await t.prisma.rateCard.update({
      where: { id: rates.pickup },
      data: { status: 'CANCELLED' },
    });
    const res = await r
      .post(`/quotation-drafts/${draft.id}/approve`, cookies.salesPts, {
        version: draft.version,
        pricingKey: draft.pricing?.key,
      })
      .expect(400);
    expect(code(res)).toBe('RATE_NO_MATCH');
    const after = (await r.get(`/quotation-drafts/${draft.id}`, cookies.salesPts).expect(200))
      .body as QuotationDraftDto;
    expect(after).toMatchObject({ status: 'DRAFT', quotationId: null, pricing: null });
    expect(after.check).toMatchObject({ ok: false });
  });
});

describe('invoice drafts: the system price', () => {
  it("prices lines from the shipment's quotation, then from the rate card", async () => {
    const shipmentId = await quotedShipment([
      { rateCardId: rates.freight, quantity: '2' },
      {
        chargeTypeCode: 'CUSTOMS',
        unit: 'PER_SHIPMENT',
        quantity: '1',
        unitPrice: '100',
        discount: '10',
      },
    ]);
    const body = invoiceRequest(shipmentId, [
      // The quoted unit price, at the invoice's own quantity: 3 × 250.125 = 750.375 → 750.38.
      { chargeTypeCode: 'FREIGHT', quantity: '3' },
      // Quoted with a discount: the agreed amount, as one unit.
      { chargeTypeCode: 'CUSTOMS', quantity: '1' },
      // Not on the quotation: the rate card, at its minimum (1 kg × 1 < 50).
      { chargeTypeCode: 'DELIVERY', quantity: '1' },
      // Typed by the staff member.
      { chargeTypeCode: 'STORAGE', quantity: '2', unitPrice: '12.5' },
    ]);
    const checked = (await r.agentPost('/invoice-drafts/check', tokens.finance, body).expect(200))
      .body as DraftPreCheckDto;
    expect(checked).toMatchObject({ ok: true, total: '915.38', currency: 'USD' });
    expect(checked.ok && checked.computed).toEqual([
      { field: 'lines.0.unitPrice', value: '250.125', source: 'QUOTATION', rateCardId: null },
      { field: 'lines.1.unitPrice', value: '90', source: 'QUOTATION', rateCardId: null },
      { field: 'lines.2.unitPrice', value: '50', source: 'RATE_CARD', rateCardId: rates.delivery },
    ]);
    const draft = await invoiceDraft(body);
    expect(draft.request.lines.map((l) => l.unitPrice)).toEqual(['250.125', '90', '50', '12.5']);
    expect(draft.priceSources).toEqual([
      { source: 'QUOTATION', rateCardId: null },
      { source: 'QUOTATION', rateCardId: null },
      { source: 'RATE_CARD', rateCardId: rates.delivery },
      { source: 'TYPED', rateCardId: null },
    ]);
    expect(draft.check).toMatchObject({ ok: true, total: '915.38', currency: 'USD' });
    // The assistant's chat card names the rate card it was priced from (its price in the name).
    const card = (await r.agentGet(`/invoice-drafts/${draft.id}/assistant`, tokens.finance))
      .body as AssistantDraftDto<InvoiceDraftDto>;
    expect(card.names[rates.delivery ?? '']).toBeDefined();
    // The same request under the same key is the same draft (no price is part of the request).
    const again = (await createInvoiceDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(again.id).toBe(draft.id);

    // The prices were fixed when the draft was made: the approval records them as reviewed.
    const approved = (
      await r
        .post(`/invoice-drafts/${draft.id}/approve`, cookies.financePts, { version: 1 })
        .expect(200)
    ).body as InvoiceDraftDto;
    const invoice = (await r.get(`/customer-invoices/${approved.invoiceId}`, cookies.financePts))
      .body as CustomerInvoiceDto;
    expect(invoice.lines.map((l) => [l.unitPrice, l.lineTotal])).toEqual([
      ['250.125', '750.38'],
      ['90', '90'],
      ['50', '50'],
      ['12.5', '25'],
    ]);
    expect(invoice.total).toBe('915.38');
  });

  it('prices a shipment without a quotation from the rate card valid on the invoice date', async () => {
    const shipmentId = await directShipment();
    const draft = await invoiceDraft(
      invoiceRequest(shipmentId, [{ chargeTypeCode: 'FREIGHT', quantity: '1' }]),
    );
    expect(draft.request.lines[0]?.unitPrice).toBe('250.125');
    expect(draft.priceSources).toEqual([{ source: 'RATE_CARD', rateCardId: rates.freight }]);
    // Dated before the current rate started, the older one applies; before both, none does.
    const older = await invoiceDraft(
      invoiceRequest(shipmentId, [{ chargeTypeCode: 'FREIGHT', quantity: '1' }], {
        invoiceDate: day(-45),
      }),
    );
    expect(older.priceSources).toEqual([{ source: 'RATE_CARD', rateCardId: rates.freightOld }]);
    const none = await createInvoiceDraft(
      invoiceRequest(shipmentId, [{ chargeTypeCode: 'FREIGHT', quantity: '1' }], {
        invoiceDate: day(-90),
      }),
    ).expect(400);
    expect(code(none)).toBe('RATE_NO_MATCH');
    expect(fields(none)).toEqual(['lines.0.unitPrice']);
  });

  it('refuses a system price that is not one clear value, and creates nothing', async () => {
    const usd = await quotedShipment([
      {
        chargeTypeCode: 'CUSTOMS',
        unit: 'PER_SHIPMENT',
        quantity: '1',
        unitPrice: '100',
        discount: '10',
      },
      { chargeTypeCode: 'INLAND', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '20' },
      { chargeTypeCode: 'INLAND', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '25' },
    ]);
    const sdg = await quotedShipment(
      [{ chargeTypeCode: 'CUSTOMS', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '5000' }],
      'SDG',
    );
    const direct = await directShipment();
    const before = await t.prisma.invoiceDraft.count();
    const refused = async (shipmentId: string, line: object) =>
      createInvoiceDraft(invoiceRequest(shipmentId, [line])).expect(400);

    const oneUnit = await refused(usd, { chargeTypeCode: 'CUSTOMS', quantity: '2' });
    expect([code(oneUnit), fields(oneUnit)]).toEqual(['PRICE_AS_ONE_UNIT', ['lines.0.quantity']]);
    const several = await refused(usd, { chargeTypeCode: 'INLAND', quantity: '1' });
    expect([code(several), fields(several)]).toEqual([
      'QUOTED_PRICE_SEVERAL',
      ['lines.0.unitPrice'],
    ]);
    const currency = await refused(sdg, { chargeTypeCode: 'CUSTOMS', quantity: '1' });
    expect([code(currency), fields(currency)]).toEqual([
      'QUOTED_PRICE_OTHER_CURRENCY',
      ['currency', 'lines.0.unitPrice'],
    ]);
    const minimum = await refused(direct, { chargeTypeCode: 'DELIVERY', quantity: '10' });
    expect(code(minimum)).toBe('PRICE_AS_ONE_UNIT');
    expect(message(minimum)).toContain('50.00 USD');
    const thc = await refused(direct, { chargeTypeCode: 'THC', quantity: '1' });
    expect([code(thc), fields(thc)]).toEqual(['RATE_SEVERAL', ['lines.0.unitPrice']]);
    for (const charge of ['STORAGE', 'DOCS']) {
      expect(code(await refused(direct, { chargeTypeCode: charge, quantity: '1' }))).toBe(
        'RATE_NO_MATCH',
      );
    }
    expect(await t.prisma.invoiceDraft.count()).toBe(before);
  });

  it("refuses another branch's shipment before any price is looked up", async () => {
    const shipmentId = await directShipment();
    await createInvoiceDraft(
      invoiceRequest(shipmentId, [{ chargeTypeCode: 'FREIGHT', quantity: '1' }]),
      tokens.financeJed,
    ).expect(404);
  });
});
