import { randomInt, randomUUID } from 'node:crypto';
import type {
  AgentClientCreatedDto,
  CustomerDto,
  DraftPreCheckDto,
  LocationDto,
  Page,
  QuotationDto,
  RateCardDto,
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

// Pricing scope, category and source (business model plan 5.1-5.3, conditions ش2 and ش3,
// F105-1). A rate card may price a place, its city or its whole country; the narrowest wins, the
// origin first, then the destination, and a city card of any branch beats a country card of the
// document's branch. A line without a category is priced from general cards only; a line with
// one from its category's cards, else the general ones. A price is kept with its source, and an
// edit that changes the source prices the line again instead of keeping it.
//
// Every card here has at least one end on this run's own places, so no other run's card matches.

let t: TestApp;
let r: ReturnType<typeof requests>;
let pts: string;
let jed: string;
let customer: CustomerDto;
let client: AgentClientCreatedDto;
let salesId = '';
const cookies = { admin: '', sales: '', pricing: '', agentSales: '' };
const tokens = { sales: '' };
const ids = {
  country: '',
  city: '',
  port: '',
  lonePort: '',
  dest: '',
  otherDest: '',
  kgDest: '',
  dest2: '',
};
const cards: Record<string, string> = {};
let countryCode = '';

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
const params = (res: { body: unknown }) =>
  (res.body as { params?: Record<string, string> }).params ?? {};
const fields = (res: { body: unknown }) => (res.body as { fields?: string[] }).fields;

/** An approved card on `from` → `to`, ROAD, general cargo, FREIGHT per shipment. */
async function card(
  key: string,
  from: string,
  to: string,
  price: string,
  extra: {
    branchId?: string;
    priceCategoryCode?: string;
    currency?: string;
    unit?: 'PER_SHIPMENT' | 'PER_KG';
  } = {},
): Promise<void> {
  const created = await t.prisma.rateCard.create({
    data: {
      branchId: extra.branchId ?? pts,
      originLocationId: from,
      destinationLocationId: to,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      chargeTypeCode: 'FREIGHT',
      priceCategoryCode: extra.priceCategoryCode ?? null,
      unit: extra.unit ?? 'PER_SHIPMENT',
      price,
      currency: extra.currency ?? 'USD',
      validFrom: new Date(`${day(-30)}T00:00:00Z`),
      status: 'APPROVED',
      createdById: salesId,
      approvedById: salesId,
      approvedAt: new Date(),
    },
  });
  cards[key] = created.id;
}

const quotationBody = (from: string, to: string, lines: object[], extra: object = {}) => ({
  customerId: customer.id,
  originLocationId: from,
  destinationLocationId: to,
  mode: 'ROAD',
  cargoType: 'GENERAL',
  currency: 'USD',
  validUntil: day(10),
  lines,
  ...extra,
});

/** A system-priced line (no card, no price), with a category when given. */
const systemLine = (priceCategoryCode?: string) => ({
  chargeTypeCode: 'FREIGHT',
  unit: 'PER_SHIPMENT',
  quantity: '1',
  ...(priceCategoryCode ? { priceCategoryCode } : {}),
});

const quote = (from: string, to: string, lines: object[], extra: object = {}) =>
  r.post('/quotations', cookies.sales, quotationBody(from, to, lines, extra));

async function quoted(from: string, to: string, lines: object[]): Promise<QuotationDto> {
  return (await quote(from, to, lines).expect(201)).body as QuotationDto;
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  pts = await branchId(t.prisma, 'PTS');
  jed = await branchId(t.prisma, 'JED');
  const sales = await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
  salesId = sales.id;
  cookies.sales = await signIn(t, sales.email);
  // Rate cards are created by the Sales & Marketing Manager (NOLON #90).
  cookies.pricing = await signIn(
    t,
    (await createUser(t.prisma, ['SALES_MARKETING_MANAGER'], ['PTS'], LEDGER_PREFIX)).email,
  );
  cookies.admin = await signIn(
    t,
    (await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX)).email,
  );
  client = await registerClient(t, cookies.admin, 'Pricing scope platform');
  const agentSales = await createUser(t.prisma, ['SALES'], ['PTS'], AGENT_PREFIX);
  cookies.agentSales = await signIn(t, agentSales.email);
  tokens.sales = await tokenFor(t, cookies.agentSales, client);

  const tag = `PS${randomUUID().slice(0, 5).toUpperCase()}`;
  // A country of this run only (X + a letter pair, never a real ISO code with the X prefix).
  countryCode = `X${String.fromCharCode(65 + randomInt(26))}`;
  const place = async (suffix: string, kind: 'CITY' | 'PORT', extra: object = {}) =>
    (
      await t.prisma.location.create({
        data: {
          code: `${tag}${suffix}`,
          kind,
          nameEn: `Scope ${tag}${suffix}`,
          nameAr: 'مكان اختبار النطاق',
          countryCode,
          ...extra,
        },
      })
    ).id;
  ids.city = await place('C', 'CITY');
  ids.port = await place('P', 'PORT', { cityId: ids.city });
  ids.lonePort = await place('L', 'PORT');
  ids.dest = await place('D', 'CITY', { countryCode: 'SD' });
  ids.otherDest = await place('E', 'CITY', { countryCode: 'SD' });
  ids.kgDest = await place('K', 'CITY', { countryCode: 'SD' });
  ids.dest2 = await place('F', 'CITY', { countryCode: 'SD' });
  // The country scope, through the screen's API (the old one of a past run, if any, is reused).
  const existing = await t.prisma.location.findFirst({ where: { kind: 'COUNTRY', countryCode } });
  ids.country =
    existing?.id ??
    (
      (
        await r
          .post('/master-data/locations', cookies.admin, {
            code: `${tag}X`,
            kind: 'COUNTRY',
            nameEn: `Country ${tag}`,
            nameAr: 'دولة اختبار',
            countryCode,
          })
          .expect(201)
      ).body as LocationDto
    ).id;

  customer = (
    await r
      .post('/customers', cookies.sales, {
        branchId: pts,
        kind: 'COMPANY',
        name: `ZZ scope customer ${tag}`,
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;

  // Country (PTS, own branch), city (JED, another branch), the port itself (PTS).
  await card('country', ids.country, ids.dest, '100');
  await card('city', ids.city, ids.dest, '90', { branchId: jed });
  await card('port', ids.port, ids.dest, '80');
  // Categories (seeded CARTON and SPECIAL price general cargo).
  await card('countryCarton', ids.country, ids.dest, '60', { priceCategoryCode: 'CARTON' });
  await card('loneCarton', ids.lonePort, ids.dest, '70', { priceCategoryCode: 'CARTON' });
  await card('onlyCarton', ids.lonePort, ids.otherDest, '50', { priceCategoryCode: 'CARTON' });
  // A route priced per kilogram only, and a second destination for the country alone.
  await card('portKg', ids.port, ids.kgDest, '2', { unit: 'PER_KG' });
  await card('country2', ids.country, ids.dest2, '100');
});

afterAll(async () => {
  await t.close();
});

describe('country pricing scope (master data)', () => {
  it('is one per country, has no city, and keeps its kind and country', async () => {
    const again = await r
      .post('/master-data/locations', cookies.admin, {
        code: `ZQ${randomInt(1e6)}`,
        kind: 'COUNTRY',
        nameEn: 'Second',
        nameAr: 'ثانية',
        countryCode,
      })
      .expect(409);
    expect(code(again)).toBe('COUNTRY_SCOPE_TAKEN');
    await r
      .post('/master-data/locations', cookies.admin, {
        code: `ZQ${randomInt(1e6)}`,
        kind: 'COUNTRY',
        nameEn: 'With a city',
        nameAr: 'بمدينة',
        countryCode: 'XQ',
        cityId: ids.city,
      })
      .expect(400);
    const kind = await r
      .patch(`/master-data/locations/${ids.country}`, cookies.admin, { kind: 'CITY' })
      .expect(400);
    expect(code(kind)).toBe('COUNTRY_KIND_FIXED');
    const toCountry = await r
      .patch(`/master-data/locations/${ids.lonePort}`, cookies.admin, { kind: 'COUNTRY' })
      .expect(400);
    expect(code(toCountry)).toBe('COUNTRY_KIND_FIXED');
    const moved = await r
      .patch(`/master-data/locations/${ids.country}`, cookies.admin, { countryCode: 'SD' })
      .expect(400);
    expect(code(moved)).toBe('COUNTRY_KIND_FIXED');
  });

  it('is never a document place, only a rate card end', async () => {
    const refused = await quote(ids.country, ids.dest, [systemLine()]).expect(400);
    expect(fields(refused)).toEqual(['originLocationId', 'destinationLocationId']);
    await r
      .post('/bookings', cookies.sales, {
        customerId: customer.id,
        originLocationId: ids.dest,
        destinationLocationId: ids.country,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
      })
      .expect(400);
  });
});

describe('scope priority (plan 5.3)', () => {
  it('prices from the narrowest scope: place, then city, then country', async () => {
    const atPort = await quoted(ids.port, ids.dest, [systemLine()]);
    expect(atPort.lines[0]).toMatchObject({
      rateCardId: cards.port,
      unitPrice: '80',
      priceSource: 'RATE_CARD',
      priceSourceDetail: { originScope: 'PLACE', destinationScope: 'CITY', price: '80' },
    });
    // The city itself: the city card (of another branch) beats the country card of this branch.
    const atCity = await quoted(ids.city, ids.dest, [systemLine()]);
    expect(atCity.lines[0]).toMatchObject({
      rateCardId: cards.city,
      unitPrice: '90',
      priceSourceDetail: { originLocationId: ids.city, originScope: 'CITY' },
    });
    // A port without a city: its country.
    const lone = await quoted(ids.lonePort, ids.dest, [systemLine()]);
    expect(lone.lines[0]).toMatchObject({
      rateCardId: cards.country,
      unitPrice: '100',
      priceSourceDetail: { originLocationId: ids.country, originScope: 'COUNTRY' },
    });
  });

  it('refuses a broader card chosen by hand while a narrower one matches', async () => {
    const refused = await quote(ids.port, ids.dest, [
      { rateCardId: cards.country, quantity: '1' },
    ]).expect(400);
    expect(code(refused)).toBe('RATE_SUPERSEDED');
    expect(params(refused)).toEqual({ rate: cards.port });
    expect(fields(refused)).toEqual(['lines.0.rateCardId']);
    // Where the country is the narrowest, it is the right card.
    const lone = await quoted(ids.lonePort, ids.dest, [
      { rateCardId: cards.country, quantity: '1' },
    ]);
    expect(lone.lines[0]?.unitPrice).toBe('100');
    // A card that does not cover the place is not usable at all.
    const other = await quote(ids.lonePort, ids.dest, [
      { rateCardId: cards.city, quantity: '1' },
    ]).expect(400);
    expect(code(other)).toBe('RATE_NOT_USABLE');
  });

  it('lists the cards covering a place for the quotation screen', async () => {
    const page = (
      await r
        .get(
          `/rates?status=APPROVED&originLocationId=${ids.port}&destinationLocationId=${ids.dest}&covering=true&pageSize=100`,
          cookies.sales,
        )
        .expect(200)
    ).body as Page<RateCardDto>;
    expect(page.items.map((c) => c.id).sort()).toEqual(
      [cards.port, cards.city, cards.country, cards.countryCarton].sort(),
    );
    expect(page.items.find((c) => c.id === cards.countryCarton)?.priceCategoryCode).toBe('CARTON');
    // Without the flag the list is as before: a place finds its own cards.
    const plain = (
      await r
        .get(
          `/rates?status=APPROVED&originLocationId=${ids.port}&destinationLocationId=${ids.dest}&pageSize=100`,
          cookies.sales,
        )
        .expect(200)
    ).body as Page<RateCardDto>;
    expect(plain.items.map((c) => c.id)).toEqual([cards.port]);
  });
});

describe('price categories (F105-1)', () => {
  it('prices a line without a category from general cards only', async () => {
    // A general card and a category card on the same route: no RATE_SEVERAL.
    const lone = await quoted(ids.lonePort, ids.dest, [systemLine()]);
    expect(lone.lines[0]).toMatchObject({ rateCardId: cards.country, priceCategoryCode: null });
    // Only a category card: nothing for a line without a category.
    const none = await quote(ids.lonePort, ids.otherDest, [systemLine()]).expect(400);
    expect(code(none)).toBe('RATE_NO_MATCH');
    // Choosing it by hand needs the category first.
    const byHand = await quote(ids.lonePort, ids.otherDest, [
      { rateCardId: cards.onlyCarton, quantity: '1' },
    ]).expect(400);
    expect(code(byHand)).toBe('RATE_CATEGORY_REQUIRED');
    expect(params(byHand)).toEqual({ category: 'CARTON' });
  });

  it('prices a line with a category from its cards first, else the general ones', async () => {
    const carton = await quoted(ids.lonePort, ids.dest, [systemLine('CARTON')]);
    expect(carton.lines[0]).toMatchObject({
      rateCardId: cards.loneCarton,
      unitPrice: '70',
      priceCategoryCode: 'CARTON',
      priceSourceDetail: { priceCategoryCode: 'CARTON' },
    });
    // Another category falls back to the general card, never to the carton card.
    const special = await quoted(ids.lonePort, ids.dest, [systemLine('SPECIAL')]);
    expect(special.lines[0]).toMatchObject({ rateCardId: cards.country, unitPrice: '100' });
    await quote(ids.lonePort, ids.otherDest, [systemLine('SPECIAL')]).expect(400);
    // The scope comes first: the port's general card beats the country's carton card.
    const atPort = await quoted(ids.port, ids.dest, [systemLine('CARTON')]);
    expect(atPort.lines[0]).toMatchObject({ rateCardId: cards.port, unitPrice: '80' });
    // A card of another category is not usable for the line.
    const wrong = await quote(ids.lonePort, ids.dest, [
      { rateCardId: cards.loneCarton, priceCategoryCode: 'SPECIAL', quantity: '1' },
    ]).expect(400);
    expect(code(wrong)).toBe('RATE_NOT_USABLE');
  });

  it('refuses a category of another cargo type or an unknown one', async () => {
    const pallet = await quote(ids.lonePort, ids.dest, [systemLine('PALLET')]).expect(400);
    expect(code(pallet)).toBe('PRICE_CATEGORY_NOT_USABLE');
    expect(fields(pallet)).toEqual(['lines.0.priceCategoryCode']);
    const unknown = await quote(ids.lonePort, ids.dest, [systemLine('NOPE')]).expect(400);
    expect(code(unknown)).toBe('PRICE_CATEGORY_NOT_USABLE');
  });

  it('keeps a rate card category to its cargo type', async () => {
    const body = {
      branchId: pts,
      originLocationId: ids.lonePort,
      destinationLocationId: ids.dest,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      chargeTypeCode: 'FREIGHT',
      unit: 'PER_PIECE',
      price: '5',
      currency: 'USD',
      validFrom: day(400 + randomInt(1000)),
    };
    const created = (
      await r.post('/rates', cookies.pricing, { ...body, priceCategoryCode: 'CARTON' }).expect(201)
    ).body as RateCardDto;
    expect(created.priceCategoryCode).toBe('CARTON');
    await r.post('/rates', cookies.pricing, { ...body, priceCategoryCode: 'PALLET' }).expect(400);
    // The same offer with another category (or none) is another card, not a duplicate.
    await r.post('/rates', cookies.pricing, body).expect(201);
    await r.post('/rates', cookies.pricing, { ...body, priceCategoryCode: 'CARTON' }).expect(409);
    // A rate card may name a country; documents may not.
    await r
      .post('/rates', cookies.pricing, { ...body, originLocationId: ids.country, unit: 'PER_KG' })
      .expect(201);
  });
});

describe('price source and its invalidation (plan 5.2)', () => {
  const edit = (q: QuotationDto, from: string, to: string, lines: object[], extra: object = {}) => {
    const { customerId: _omitted, ...body } = quotationBody(from, to, lines, extra);
    void _omitted;
    return r.patch(`/quotations/${q.id}`, cookies.sales, body);
  };

  it('keeps a price whose source did not change', async () => {
    const q = await quoted(ids.port, ids.dest, [systemLine()]);
    const kept = (
      await edit(q, ids.port, ids.dest, [{ rateCardId: cards.port, quantity: '2' }]).expect(200)
    ).body as QuotationDto;
    expect(kept.lines[0]).toMatchObject({ rateCardId: cards.port, unitPrice: '80', quantity: '2' });
  });

  it('prices the line again when the route changes, never keeping the old price', async () => {
    const q = await quoted(ids.port, ids.dest, [systemLine()]);
    // The screen sends the card back; the origin moved to a port priced by its country only.
    const moved = (
      await edit(q, ids.lonePort, ids.dest, [{ rateCardId: cards.port, quantity: '1' }]).expect(200)
    ).body as QuotationDto;
    expect(moved.lines[0]).toMatchObject({
      rateCardId: cards.country,
      unitPrice: '100',
      priceSourceDetail: { originScope: 'COUNTRY' },
    });
    // A currency no card prices: the line needs a price, the old one is not kept.
    const fresh = await quoted(ids.port, ids.dest, [systemLine()]);
    const eur = await edit(fresh, ids.port, ids.dest, [{ rateCardId: cards.port, quantity: '1' }], {
      currency: 'EUR',
    });
    expect(eur.status).toBe(400);
    expect(code(eur)).toBe('RATE_NO_MATCH');
    expect(fields(eur)).toEqual(['lines.0.unitPrice']);
  });

  it('prices the line again when its category changes', async () => {
    const q = await quoted(ids.lonePort, ids.dest, [systemLine()]);
    expect(q.lines[0]?.rateCardId).toBe(cards.country);
    const carton = (
      await edit(q, ids.lonePort, ids.dest, [
        { rateCardId: cards.country, priceCategoryCode: 'CARTON', quantity: '1' },
      ]).expect(200)
    ).body as QuotationDto;
    expect(carton.lines[0]).toMatchObject({ rateCardId: cards.loneCarton, unitPrice: '70' });
  });

  it('prices the line again in its saved unit, never reading its quantity in another (F120-2)', async () => {
    const q = await quoted(ids.port, ids.dest, [systemLine()]);
    expect(q.lines[0]).toMatchObject({ unit: 'PER_SHIPMENT', quantity: '1' });
    // The new route has a card per kilogram only: the line keeps its unit, so no card matches.
    const moved = await edit(q, ids.port, ids.kgDest, [{ rateCardId: cards.port, quantity: '1' }]);
    expect(moved.status).toBe(400);
    expect(code(moved)).toBe('RATE_NO_MATCH');
    expect(fields(moved)).toEqual(['lines.0.unitPrice']);
    // Naming the unit is how the person moves the line to kilograms.
    const perKg = (
      await edit(q, ids.port, ids.kgDest, [
        { rateCardId: cards.port, unit: 'PER_KG', quantity: '250' },
      ]).expect(200)
    ).body as QuotationDto;
    expect(perKg.lines[0]).toMatchObject({ rateCardId: cards.portKg, unit: 'PER_KG' });
  });

  it('keeps a saved broader card for its own line only, never for a line added later (F120-4)', async () => {
    const q = await quoted(ids.lonePort, ids.dest2, [
      { rateCardId: cards.country2, quantity: '1' },
    ]);
    // A narrower card arrives after the quotation was saved.
    await card('lone2', ids.lonePort, ids.dest2, '75');
    const added = await edit(q, ids.lonePort, ids.dest2, [
      { rateCardId: cards.country2, quantity: '1' },
      { rateCardId: cards.country2, quantity: '2' },
    ]);
    expect(added.status).toBe(400);
    expect(code(added)).toBe('RATE_SUPERSEDED');
    expect(fields(added)).toEqual(['lines.1.rateCardId']);
    // The saved line alone keeps its card and price.
    const kept = (
      await edit(q, ids.lonePort, ids.dest2, [
        { rateCardId: cards.country2, quantity: '3' },
      ]).expect(200)
    ).body as QuotationDto;
    expect(kept.lines[0]).toMatchObject({ rateCardId: cards.country2, unitPrice: '100' });
  });

  it('leaves a typed price alone, and a line saved before sources were kept', async () => {
    const typed = await quoted(ids.port, ids.dest, [
      { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', unitPrice: '55', quantity: '1' },
    ]);
    expect(typed.lines[0]).toMatchObject({
      priceSource: 'TYPED',
      priceSourceDetail: null,
      rateCardId: null,
    });
    const moved = (
      await edit(typed, ids.lonePort, ids.dest, [
        { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', unitPrice: '55', quantity: '1' },
      ]).expect(200)
    ).body as QuotationDto;
    expect(moved.lines[0]?.unitPrice).toBe('55');

    const old = await quoted(ids.port, ids.dest, [{ rateCardId: cards.port, quantity: '1' }]);
    await t.prisma.quotationLine.updateMany({
      where: { quotationId: old.id },
      data: { priceSource: null },
    });
    await t.prisma.$executeRaw`
      UPDATE "quotation_lines" SET "price_source_snapshot" = NULL WHERE "quotation_id" = ${old.id}::uuid`;
    const before = (await r.get(`/quotations/${old.id}`, cookies.sales).expect(200))
      .body as QuotationDto;
    expect(before.lines[0]).toMatchObject({ priceSource: null, priceSourceDetail: null });
    const resaved = (
      await edit(old, ids.port, ids.dest, [{ rateCardId: cards.port, quantity: '1' }]).expect(200)
    ).body as QuotationDto;
    expect(resaved.lines[0]).toMatchObject({ rateCardId: cards.port, unitPrice: '80' });
  });
});

describe('assistant compatibility (plan 7.2)', () => {
  it('shows the assistant general cards only: it has no category to show (F120-3)', async () => {
    const query = `/rates?originLocationId=${ids.lonePort}&destinationLocationId=${ids.otherDest}`;
    const onScreen = (await r.get(query, cookies.agentSales).expect(200)).body as Page<RateCardDto>;
    expect(onScreen.items.map((c) => c.id)).toContain(cards.onlyCarton);
    const forAgent = (await r.agentGet(query, tokens.sales).expect(200)).body as Page<RateCardDto>;
    expect(forAgent.items.map((c) => c.id)).not.toContain(cards.onlyCarton);
    expect(forAgent.items.every((c) => c.priceCategoryCode === null)).toBe(true);
    await r.agentGet(`/rates/${cards.onlyCarton}`, tokens.sales).expect(404);
    await r.agentGet(`/rates/${cards.port}`, tokens.sales).expect(200);
    await r.get(`/rates/${cards.onlyCarton}`, cookies.agentSales).expect(200);
  });

  it('keeps quotation draft shapes, and refuses a category from the assistant', async () => {
    const request = {
      idempotencyKey: draftKey(),
      customerId: customer.id,
      originLocationId: ids.port,
      destinationLocationId: ids.dest,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      currency: 'USD',
      validUntil: day(10),
      lines: [systemLine()],
    };
    const check = (await r.agentPost('/quotation-drafts/check', tokens.sales, request).expect(200))
      .body as DraftPreCheckDto;
    expect(Object.keys(check).sort()).toEqual(
      ['computed', 'currency', 'missingFields', 'ok', 'priceSources', 'total', 'valuesHash'].sort(),
    );
    if (!check.ok) throw new Error('refused');
    expect(check.priceSources).toEqual([{ source: 'RATE_CARD', rateCardId: cards.port }]);
    expect(check.computed).toEqual([
      { field: 'lines.0.unitPrice', value: '80', source: 'RATE_CARD', rateCardId: cards.port },
    ]);
    const created = (await r.agentPost('/quotation-drafts', tokens.sales, request).expect(201))
      .body as { id: string };
    const draft = (await r.get(`/quotation-drafts/${created.id}`, cookies.agentSales).expect(200))
      .body as {
      request: { lines: object[] };
      pricing: { lines: object[] } & Record<string, unknown>;
      priceSources: object[];
    };
    expect(Object.keys(draft.pricing).sort()).toEqual(
      ['discountTotal', 'key', 'lines', 'subtotal', 'total'].sort(),
    );
    expect(Object.keys(draft.pricing.lines[0] ?? {}).sort()).toEqual(
      [
        'chargeTypeCode',
        'discount',
        'lineTotal',
        'minimumCharge',
        'quantity',
        'unit',
        'unitPrice',
      ].sort(),
    );
    expect(draft.priceSources).toEqual([{ source: 'RATE_CARD', rateCardId: cards.port }]);
    expect(Object.keys(draft.request.lines[0] ?? {})).not.toContain('priceCategoryCode');
    // The new field is for NOLON's screens only.
    await r
      .agentPost('/quotation-drafts', tokens.sales, {
        ...request,
        idempotencyKey: draftKey(),
        lines: [systemLine('CARTON')],
      })
      .expect(400);
    // A category card chosen by the assistant for a line without one is refused, as on screen.
    const byHand = await r
      .agentPost('/quotation-drafts/check', tokens.sales, {
        ...request,
        originLocationId: ids.lonePort,
        destinationLocationId: ids.otherDest,
        lines: [{ rateCardId: cards.onlyCarton, quantity: '1' }],
      })
      .expect(200);
    expect(JSON.stringify(byHand.body)).toContain('RATE_CATEGORY_REQUIRED');
  });
});
