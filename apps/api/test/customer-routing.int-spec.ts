import { randomInt, randomUUID } from 'node:crypto';
import type { ApiClientCreatedDto, CsCatalogDto, CsQuoteDto } from '@nolon/shared';
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

/**
 * Branch routing for customer-service requests (docs/plans/04 section 6): rules on a place, its
 * city or its country; the narrowest level with rules decides; one branch is the branch, several
 * or none no branch. The quote prices from that branch's cards first and says whether a request
 * from the origin can be made with the key (bookable). Every place is this run's own.
 */
describe('Customer Service branch routing', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let dxb = '';
  let salesId = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', sales: '' };
  const ids: Record<string, string> = {};
  let category = '';
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const route = (id: string, branchIds: string[], cookie = cookies.admin) =>
    put(`/master-data/locations/${id}/routing-branches`, cookie, { branchIds });
  const quote = (origin: string) =>
    t
      .http()
      .get('/api/v1/cs/quote')
      .query({ originId: origin, destinationId: ids.dest!, category })
      .set('Authorization', `Bearer ${bot.key}`);

  async function card(from: string, branch: string, price: string): Promise<void> {
    await t.prisma.rateCard.create({
      data: {
        branchId: branch,
        originLocationId: from,
        destinationLocationId: ids.dest!,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_SHIPMENT',
        price,
        currency: 'USD',
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        status: 'APPROVED',
        createdById: salesId,
        approvedById: salesId,
        approvedAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    dxb = await branchId(t.prisma, 'DXB');
    const sales = await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    salesId = sales.id;
    cookies.sales = await signIn(t, sales.email);
    cookies.admin = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX)).email,
    );
    bot = (
      await t
        .http()
        .post('/api/v1/api-clients')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.admin)
        .send({ name: 'Routing', branchIds: [pts], scopes: ['cs:quote:read', 'cs:catalog:read'] })
        .expect(201)
    ).body as ApiClientCreatedDto;

    const tag = `R${randomUUID().slice(0, 5).toUpperCase()}`;
    category = `${tag}S`;
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    const countryCode = `W${String.fromCharCode(65 + randomInt(26))}`;
    const place = async (suffix: string, kind: 'CITY' | 'PORT' | 'COUNTRY', extra: object = {}) =>
      (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind,
            nameEn: `Routing ${tag}${suffix}`,
            nameAr: 'مكان اختبار التوجيه',
            countryCode,
            ...extra,
          },
        })
      ).id;
    ids.country = await place('CTY', 'COUNTRY');
    ids.city = await place('CIT', 'CITY');
    ids.port = await place('PRT', 'PORT', { cityId: ids.city });
    ids.lone = await place('LON', 'PORT');
    ids.two = await place('TWO', 'PORT');
    ids.dest = await place('DES', 'CITY', { countryCode: 'SD' });
    for (const from of [ids.port, ids.city, ids.lone]) {
      await card(from, pts, '100');
      await card(from, jed, '200');
    }
    await card(ids.two, pts, '100');
  });

  afterAll(async () => {
    await t.close();
  });

  it('is set by the Administrator only, to active branches, and audited', async () => {
    await route(ids.city!, [pts], cookies.sales).expect(403);
    await route(randomUUID(), [pts]).expect(404);
    await route(ids.city!, [randomUUID()]).expect(400);
    await route(ids.city!, [pts, jed, pts]).expect(200);
    const listed = (
      await t.http().get('/api/v1/master-data/routing-branches').set('Cookie', cookies.sales)
    ).body as Record<string, string[]>;
    expect(listed[ids.city!]).toEqual([pts, jed].sort());
    const audit = await t.prisma.auditEvent.findFirst({
      where: { entity: 'LOCATION', entityId: ids.city! },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.changes).toEqual([{ field: 'routingBranches', before: null, after: 'JED, PTS' }]);
    await route(ids.city!, []).expect(200);
  });

  it('audits a place’s other names', async () => {
    await put(`/master-data/locations/${ids.lone}/aliases`, cookies.admin, {
      aliases: ['Lone'],
    }).expect(200);
    const audit = await t.prisma.auditEvent.findFirst({
      where: { entity: 'LOCATION', entityId: ids.lone! },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.changes).toEqual([{ field: 'aliases', before: null, after: 'Lone' }]);
  });

  it('prices from the one branch serving the origin, narrowest rule first', async () => {
    // No rule: two branches' cards tie, and nothing is bookable.
    expect((await quote(ids.port!).expect(422)).body).toMatchObject({ code: 'QUOTE_AMBIGUOUS' });

    // The country's rule: JED serves every place of it; its card first, but not the key's branch.
    await route(ids.country!, [jed]).expect(200);
    const viaCountry = (await quote(ids.port!).expect(200)).body as CsQuoteDto;
    expect(viaCountry).toMatchObject({ price: '200', bookable: false });

    // The city's rule beats the country's, for the city's port too.
    await route(ids.city!, [pts]).expect(200);
    const viaCity = (await quote(ids.port!).expect(200)).body as CsQuoteDto;
    expect(viaCity).toMatchObject({ price: '100', bookable: true });
    // A lone port still follows the country.
    expect((await quote(ids.lone!).expect(200)).body).toMatchObject({
      price: '200',
      bookable: false,
    });

    // Two branches on the port itself: no branch; bookable, since one of them is the key's.
    await route(ids.port!, [jed, dxb]).expect(200);
    expect((await quote(ids.port!).expect(422)).body).toMatchObject({ code: 'QUOTE_AMBIGUOUS' });
    // Two branches, one the key's, on a place priced by one branch: bookable.
    await route(ids.two!, [jed, pts]).expect(200);
    expect((await quote(ids.two!).expect(200)).body).toMatchObject({
      price: '100',
      bookable: true,
    });
    await route(ids.port!, []).expect(200);
    await route(ids.city!, []).expect(200);
    await route(ids.country!, []).expect(200);
  });

  it('lists a place a branch serves as an origin, with or without a price', async () => {
    const unpriced = (
      await t.prisma.location.create({
        data: {
          code: `${category.slice(0, 6)}U`,
          kind: 'CITY',
          nameEn: 'Routing unpriced',
          nameAr: 'مكان بلا سعر',
          countryCode: 'SD',
        },
      })
    ).id;
    const origins = async () =>
      (
        (
          await t
            .http()
            .get('/api/v1/cs/catalog')
            .set('Authorization', `Bearer ${bot.key}`)
            .expect(200)
        ).body as CsCatalogDto
      ).origins.map((p) => p.id);
    expect(await origins()).not.toContain(unpriced);
    await route(unpriced, [pts]).expect(200);
    expect(await origins()).toContain(unpriced);
  });
});
