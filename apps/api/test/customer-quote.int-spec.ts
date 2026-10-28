import { randomInt, randomUUID } from 'node:crypto';
import type { ApiClientCreatedDto, CsQuoteChoices, CsQuoteDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dec } from '../src/common/money.js';
import { computeQuotationAmounts } from '../src/quotations/quotation-totals.js';
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
 * The Customer Service quote (R2, docs/plans/04 section 5): NOLON's own engine, the narrowest
 * card, the category before the general cards, FREIGHT only, the quotation's minimum and
 * rounding, and a refusal (never a default) where the cards differ on what the client left out.
 * Every card is on this run's own places, so no other run's card matches.
 */
describe('Customer Service quote (R2)', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let salesId = '';
  let bot: ApiClientCreatedDto;
  let catalogOnly: ApiClientCreatedDto;
  const cat = { shipment: '', kg: '' };
  const ids: Record<string, string> = {};
  const SECRET_NOTE = 'internal note never for customers';
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
  const iso = (offset: number) => day(offset).toISOString().slice(0, 10);
  const quote = (key: string, query: Record<string, string>) =>
    t.http().get('/api/v1/cs/quote').query(query).set('Authorization', `Bearer ${key}`);
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const choices = (res: { body: unknown }) => (res.body as { choices?: CsQuoteChoices }).choices;

  async function card(
    from: string,
    to: string,
    extra: {
      price?: string;
      minimumCharge?: string;
      status?: 'APPROVED' | 'DRAFT' | 'CANCELLED';
      validTo?: Date;
      mode?: 'ROAD' | 'SEA';
      currency?: string;
      unit?: 'PER_SHIPMENT' | 'PER_KG';
      branchId?: string;
      priceCategoryCode?: string | null;
      chargeTypeCode?: string;
    } = {},
  ): Promise<string> {
    const status = extra.status ?? 'APPROVED';
    const mode = extra.mode ?? 'ROAD';
    const created = await t.prisma.rateCard.create({
      data: {
        branchId: extra.branchId ?? pts,
        originLocationId: from,
        destinationLocationId: to,
        mode,
        loadType: mode === 'SEA' ? 'LCL' : null,
        cargoType: 'GENERAL',
        chargeTypeCode: extra.chargeTypeCode ?? 'FREIGHT',
        priceCategoryCode: extra.priceCategoryCode === undefined ? null : extra.priceCategoryCode,
        unit: extra.unit ?? 'PER_SHIPMENT',
        price: extra.price ?? '100',
        minimumCharge: extra.minimumCharge ?? '0',
        currency: extra.currency ?? 'USD',
        validFrom: day(-30),
        validTo: extra.validTo ?? null,
        transitDays: 9,
        notes: SECRET_NOTE,
        status,
        createdById: salesId,
        ...(status === 'APPROVED' ? { approvedById: salesId, approvedAt: new Date() } : {}),
      },
    });
    return created.id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    salesId = (await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX)).id;
    const admin = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX)).email,
    );
    const make = async (scopes: string[]) =>
      (
        await t
          .http()
          .post('/api/v1/api-clients')
          .set('Origin', APP_ORIGIN)
          .set('Cookie', admin)
          .send({ name: 'Quote', branchIds: [pts], scopes })
          .expect(201)
      ).body as ApiClientCreatedDto;
    bot = await make(['cs:quote:read']);
    catalogOnly = await make(['cs:catalog:read']);

    const tag = `Q${randomUUID().slice(0, 5).toUpperCase()}`;
    cat.shipment = `${tag}S`;
    cat.kg = `${tag}K`;
    for (const [c, unit] of [
      [cat.shipment, 'PER_SHIPMENT'],
      [cat.kg, 'PER_KG'],
    ] as const) {
      await t.prisma.priceCategory.create({
        data: { code: c, nameEn: c, nameAr: c, cargoType: 'GENERAL', defaultUnit: unit },
      });
    }
    const countryCode = `Q${String.fromCharCode(65 + randomInt(26))}`;
    const place = async (suffix: string, kind: 'CITY' | 'PORT' | 'COUNTRY', extra: object = {}) =>
      (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind,
            nameEn: `Quote ${tag}${suffix}`,
            nameAr: 'مكان اختبار السعر',
            countryCode,
            ...extra,
          },
        })
      ).id;
    for (const name of [
      'city',
      'dest',
      'none',
      'hidden',
      'modes',
      'money',
      'offers',
      'kg',
      'cat',
    ]) {
      ids[name] = await place(name.slice(0, 3).toUpperCase(), 'CITY');
    }
    ids.port = await place('PRT', 'PORT', { cityId: ids.city });
    ids.country = await place('CTY', 'COUNTRY');

    // The city's card, and a narrower one on the port to another destination.
    await card(ids.city!, ids.dest!, { price: '100' });
    await card(ids.city!, ids.money!, { price: '100' });
    await card(ids.port, ids.money!, { price: '10.3333', minimumCharge: '50' });
    // Only cards a quote never uses: draft, cancelled, ended, another charge.
    await card(ids.hidden!, ids.dest!, { status: 'DRAFT' });
    await card(ids.hidden!, ids.dest!, { status: 'CANCELLED' });
    await card(ids.hidden!, ids.dest!, { validTo: day(-1) });
    await card(ids.hidden!, ids.dest!, { chargeTypeCode: 'CUSTOMS' });
    // Two modes; on SEA two currencies.
    await card(ids.modes!, ids.dest!, { mode: 'ROAD' });
    await card(ids.modes!, ids.dest!, { mode: 'SEA', currency: 'USD' });
    await card(ids.modes!, ids.dest!, { mode: 'SEA', currency: 'AED' });
    // Two branches at the same scope.
    await card(ids.offers!, ids.dest!, { branchId: pts });
    await card(ids.offers!, ids.dest!, { branchId: jed });
    // Per kilo only.
    await card(ids.kg!, ids.dest!, { unit: 'PER_SHIPMENT' });
    // A category card and a general one.
    await card(ids.cat!, ids.dest!, { price: '70', priceCategoryCode: cat.shipment });
    await card(ids.cat!, ids.dest!, { price: '90' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('is read only by a key with the quote scope', async () => {
    const q = { originId: ids.city!, destinationId: ids.dest!, category: cat.shipment };
    expect(code(await quote(catalogOnly.key, q).expect(403))).toBe('SCOPE_REQUIRED');
    await t.http().get('/api/v1/cs/quote').query(q).expect(401);
    await quote(bot.key, q).expect(200);
  });

  it('prices a route from the narrowest approved card, with the quotation arithmetic', async () => {
    const base = { originId: ids.port!, destinationId: ids.money!, category: cat.shipment };
    const res = await quote(bot.key, { ...base, quantity: '2' }).expect(200);
    const body = res.body as CsQuoteDto;
    // The port's own card beats its city's.
    expect(body).toMatchObject({
      price: '10.3333',
      minimumCharge: '50',
      currency: 'USD',
      unit: 'PER_SHIPMENT',
      quantity: '2',
      includes: ['MAIN_FREIGHT'],
      mode: 'ROAD',
      loadType: null,
      transitDays: 9,
      validTo: null,
      scope: { origin: 'PLACE', destination: 'CITY' },
      customerNote: null,
    });
    // 2 × 10.3333 = 20.67 is under the minimum.
    expect(body.total).toBe('50.00');
    for (const q of ['7', '7.5', '12.3456']) {
      const total = computeQuotationAmounts(
        [
          {
            quantity: dec(q),
            unitPrice: dec('10.3333'),
            minimumCharge: dec('50'),
            discount: dec(0),
          },
        ],
        2,
      ).total.toFixed(2);
      const got = (await quote(bot.key, { ...base, quantity: q }).expect(200)).body as CsQuoteDto;
      expect(got.total).toBe(total);
    }
    expect(((await quote(bot.key, base).expect(200)).body as CsQuoteDto).total).toBeNull();

    // From the city: its own card, at the city scope for a port of the city too.
    const city = (
      await quote(bot.key, {
        originId: ids.port!,
        destinationId: ids.dest!,
        category: cat.shipment,
      })
    ).body as CsQuoteDto;
    expect(city).toMatchObject({ price: '100', scope: { origin: 'CITY', destination: 'CITY' } });

    // No cost, margin, staff or internal note.
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET_NOTE);
    expect(text).not.toMatch(/cost|margin|createdBy|approvedBy|notes|branch/i);
    expect(text).not.toContain(salesId);
  });

  it('keeps each answer under its quoteRef, never changed', async () => {
    const body = (
      await quote(bot.key, {
        originId: ids.port!,
        destinationId: ids.money!,
        category: cat.shipment,
        quantity: '7',
      }).expect(200)
    ).body as CsQuoteDto;
    expect(body.quoteRef).toMatch(/^q_[A-Za-z0-9_-]{32}$/);
    expect(body.source.quotedOn).toBe(iso(0));
    expect(new Date(body.quoteRefExpiresAt).toISOString()).toBe(`${iso(1)}T00:00:00.000Z`);
    const row = await t.prisma.csQuote.findUniqueOrThrow({ where: { ref: body.quoteRef } });
    expect(row).toMatchObject({
      apiClientId: bot.client.id,
      rateCardId: body.source.rateCardId,
      originLocationId: ids.port,
      destinationLocationId: ids.money,
      priceCategoryCode: cat.shipment,
      mode: 'ROAD',
      currency: 'USD',
      unit: 'PER_SHIPMENT',
      originScope: 'PLACE',
      destinationScope: 'CITY',
    });
    expect(row.quantity?.toFixed()).toBe('7');
    expect(row.total?.toFixed(2)).toBe(body.total);
    await expect(
      t.prisma.csQuote.update({ where: { ref: body.quoteRef }, data: { total: '1' } }),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('answers NO_RATE without an approved FREIGHT card valid that day', async () => {
    for (const origin of [ids.none!, ids.hidden!]) {
      const res = await quote(bot.key, {
        originId: origin,
        destinationId: ids.dest!,
        category: cat.shipment,
      }).expect(404);
      expect(code(res)).toBe('NO_RATE');
    }
    // A mode or currency no card has.
    const q = { originId: ids.city!, destinationId: ids.dest!, category: cat.shipment };
    expect(code(await quote(bot.key, { ...q, mode: 'SEA' }).expect(404))).toBe('NO_RATE');
    expect(code(await quote(bot.key, { ...q, currency: 'SAR' }).expect(404))).toBe('NO_RATE');
  });

  it('asks instead of choosing when the cards differ on what was left out', async () => {
    const q = { originId: ids.modes!, destinationId: ids.dest!, category: cat.shipment };
    const modes = await quote(bot.key, q).expect(422);
    expect(code(modes)).toBe('QUOTE_AMBIGUOUS');
    expect(choices(modes)).toEqual({ field: 'mode', values: ['ROAD', 'SEA'] });
    expect(JSON.stringify(modes.body)).not.toContain('100');

    const currencies = await quote(bot.key, { ...q, mode: 'SEA' }).expect(422);
    expect(choices(currencies)).toEqual({ field: 'currency', values: ['AED', 'USD'] });
    const sea = (await quote(bot.key, { ...q, mode: 'SEA', currency: 'AED' }).expect(200))
      .body as CsQuoteDto;
    expect(sea).toMatchObject({ mode: 'SEA', loadType: 'LCL', currency: 'AED' });
    expect(
      ((await quote(bot.key, { ...q, mode: 'ROAD' }).expect(200)).body as CsQuoteDto).mode,
    ).toBe('ROAD');

    // Two branches' cards at the same scope: staff decide.
    const offers = await quote(bot.key, {
      originId: ids.offers!,
      destinationId: ids.dest!,
      category: cat.shipment,
    }).expect(422);
    expect(choices(offers)).toEqual({ field: 'offer', values: [] });
  });

  it("refuses a card in another unit than the category's", async () => {
    const res = await quote(bot.key, {
      originId: ids.kg!,
      destinationId: ids.dest!,
      category: cat.kg,
    }).expect(422);
    expect(code(res)).toBe('UNIT_MISMATCH');
  });

  it("prices from the category's card before the general one", async () => {
    const q = { originId: ids.cat!, destinationId: ids.dest!, category: cat.shipment };
    expect(((await quote(bot.key, q).expect(200)).body as CsQuoteDto).price).toBe('70');
    // Another category of the same unit: the general card.
    const other = `${cat.shipment}2`;
    await t.prisma.priceCategory.create({
      data: {
        code: other,
        nameEn: other,
        nameAr: other,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    expect(
      ((await quote(bot.key, { ...q, category: other }).expect(200)).body as CsQuoteDto).price,
    ).toBe('90');
  });

  it('refuses a country, a past day, an unknown category and unknown fields', async () => {
    const q = { originId: ids.city!, destinationId: ids.dest!, category: cat.shipment };
    await quote(bot.key, { ...q, originId: ids.country! }).expect(400);
    await quote(bot.key, { ...q, onDate: iso(-1) }).expect(400);
    await quote(bot.key, { ...q, category: 'NOPE' }).expect(400);
    await quote(bot.key, { ...q, price: '1' }).expect(400);
    await quote(bot.key, { ...q, quantity: '0' }).expect(400);
    await quote(bot.key, { ...q, originId: ids.dest! }).expect(400);
    await quote(bot.key, { ...q, onDate: iso(1) }).expect(200);
  });
});
