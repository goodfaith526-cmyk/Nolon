import { randomInt, randomUUID } from 'node:crypto';
import type { ApiClientCreatedDto, CsCatalogDto, LocationDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';

/** The Customer Service catalog (R1, docs/plans/04 section 4) and the locations' other names. */
describe('Customer Service catalog (R1)', () => {
  let t: TestApp;
  let pts = '';
  let salesId = '';
  const cookies = { admin: '', sales: '' };
  const ids = { country: '', city: '', port: '', lonePort: '', dest: '', draftOnly: '', off: '' };
  const PRICE = '987.6543';
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const catalog = (key: string) =>
    t.http().get('/api/v1/cs/catalog').set('Authorization', `Bearer ${key}`);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
  let bot: ApiClientCreatedDto;
  let readKey: ApiClientCreatedDto;

  async function card(
    from: string,
    to: string,
    status: 'APPROVED' | 'DRAFT',
    validTo: Date | null = null,
  ) {
    await t.prisma.rateCard.create({
      data: {
        branchId: pts,
        originLocationId: from,
        destinationLocationId: to,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_SHIPMENT',
        price: PRICE,
        currency: 'USD',
        validFrom: day(-30),
        validTo,
        status,
        createdById: salesId,
        ...(status === 'APPROVED' ? { approvedById: salesId, approvedAt: new Date() } : {}),
      },
    });
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    const sales = await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    salesId = sales.id;
    cookies.sales = await signIn(t, sales.email);
    cookies.admin = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX)).email,
    );
    const make = async (scopes: string[]) =>
      (
        await post('/api-clients', cookies.admin, {
          name: 'Catalog',
          branchIds: [pts],
          scopes,
        }).expect(201)
      ).body as ApiClientCreatedDto;
    bot = await make(['cs:catalog:read']);
    readKey = await make(['cs:customers:read']);

    const tag = `CT${randomUUID().slice(0, 5).toUpperCase()}`;
    // Countries of this run only (X + a letter pair): no other run's card covers them.
    const countryCode = `X${String.fromCharCode(65 + randomInt(26))}`;
    const otherCountry = `Y${String.fromCharCode(65 + randomInt(26))}`;
    const place = async (suffix: string, kind: 'CITY' | 'PORT', extra: object = {}) =>
      (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind,
            nameEn: `Catalog ${tag}${suffix}`,
            nameAr: 'مكان اختبار الكتالوج',
            countryCode,
            ...extra,
          },
        })
      ).id;
    ids.city = await place('C', 'CITY');
    ids.port = await place('P', 'PORT', { cityId: ids.city });
    ids.lonePort = await place('L', 'PORT');
    ids.off = await place('O', 'PORT', { isActive: false });
    ids.dest = await place('D', 'CITY', { countryCode: otherCountry });
    ids.draftOnly = await place('R', 'CITY', { countryCode: otherCountry });
    const existing = await t.prisma.location.findFirst({ where: { kind: 'COUNTRY', countryCode } });
    ids.country =
      existing?.id ??
      (
        (
          await post('/master-data/locations', cookies.admin, {
            code: `${tag}X`,
            kind: 'COUNTRY',
            nameEn: `Country ${tag}`,
            nameAr: 'دولة اختبار',
            countryCode,
          }).expect(201)
        ).body as LocationDto
      ).id;

    // The whole country to dest; a draft and an ended card name draftOnly.
    await card(ids.country, ids.dest, 'APPROVED');
    await card(ids.dest, ids.draftOnly, 'DRAFT');
    await card(ids.draftOnly, ids.dest, 'APPROVED', day(-1));
  });

  afterAll(async () => {
    await t.close();
  });

  it('is read only by a key with the catalog scope', async () => {
    const refused = await catalog(readKey.key).expect(403);
    expect(refused.body).toMatchObject({ code: 'SCOPE_REQUIRED' });
    await t.http().get('/api/v1/cs/catalog').expect(401);
    await catalog(bot.key).expect(200);
  });

  it('lists the active places an approved card valid today covers, by place, city or country', async () => {
    const body = (await catalog(bot.key).expect(200)).body as CsCatalogDto;
    const origins = new Set(body.origins.map((p) => p.id));
    const destinations = new Set(body.destinations.map((p) => p.id));
    // The country card covers the country itself, its city, the city's port and a lone port.
    for (const id of [ids.country, ids.city, ids.port, ids.lonePort]) expect(origins).toContain(id);
    expect(origins).not.toContain(ids.off);
    expect(destinations).toContain(ids.dest);
    // A draft card and an ended one cover nothing.
    expect(origins).not.toContain(ids.draftOnly);
    expect(destinations).not.toContain(ids.draftOnly);
    expect(origins).not.toContain(ids.dest);

    const city = body.origins.find((p) => p.id === ids.city);
    expect(city).toMatchObject({ kind: 'CITY', nameAr: 'مكان اختبار الكتالوج', aliases: [] });
    expect(body.services.map((s) => s.code)).toEqual(['PICKUP', 'LAST_MILE']);
    expect(body.categories.length).toBeGreaterThan(0);
    for (const c of body.categories) expect(c.unit).toBeTruthy();
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
    // No price, cost or staff in it.
    const text = JSON.stringify(body);
    expect(text).not.toContain(PRICE);
    expect(text).not.toContain('987.65');
    expect(text).not.toMatch(/price"|cost|margin|createdBy|approvedBy/i);
  });

  it("carries the places' other names, set by the Administrator only", async () => {
    const path = `/master-data/locations/${ids.city}/aliases`;
    await put(path, cookies.sales, { aliases: ['x'] }).expect(403);
    await put(`/master-data/locations/${randomUUID()}/aliases`, cookies.admin, {
      aliases: ['x'],
    }).expect(404);
    await put(path, cookies.admin, { aliases: ['a'.repeat(101)] }).expect(400);
    const before = ((await catalog(bot.key).expect(200)).body as CsCatalogDto).version;

    const saved = (
      await put(path, cookies.admin, { aliases: ['  Jedda  City ', 'جده', 'JEDDA CITY'] }).expect(
        200,
      )
    ).body as string[];
    expect(saved).toEqual(['Jedda City', 'جده'].sort());
    const after = (await catalog(bot.key).expect(200)).body as CsCatalogDto;
    expect(after.origins.find((p) => p.id === ids.city)?.aliases).toEqual(saved);
    expect(after.version).not.toBe(before);
    const listed = (
      await t.http().get('/api/v1/master-data/location-aliases').set('Cookie', cookies.sales)
    ).body as Record<string, string[]>;
    expect(listed[ids.city]).toEqual(saved);

    await put(path, cookies.admin, { aliases: [] }).expect(200);
    const cleared = (await catalog(bot.key).expect(200)).body as CsCatalogDto;
    expect(cleared.origins.find((p) => p.id === ids.city)?.aliases).toEqual([]);
  });
});
