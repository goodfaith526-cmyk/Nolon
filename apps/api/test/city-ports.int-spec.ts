import { randomUUID } from 'node:crypto';
import type {
  ConsolidationSummaryDto,
  CustomerDto,
  LocationDto,
  MasterDataDto,
  Page,
  QuotationDto,
  RateCardDto,
} from '@nolon/shared';
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
import { AGENT_PREFIX, registerClient, requests, tokenFor } from './agent-drafts-helpers.js';
import { uniquePhone, waitForLockWaiter } from './test-data.js';

// A city and the places that serve it (owner, 2026-10-14: a lookup by Dubai includes Jebel Ali).
// The relation is data: a place names its city. Lists filtered by a city also find its places
// and say which locations they matched; a filter on a port stays exact, and writes keep the
// location they were given. The people here keep the ledger prefix: the containers they make
// are not removed by the usual cleanup.

let t: TestApp;
let r: ReturnType<typeof requests>;
let dxb: string;
let city: LocationDto;
let port: LocationDto;
let otherPort: LocationDto;
let portSudan: string;
let rateFromPort: string;
let customer: CustomerDto;
let token = '';
const cookies = { admin: '', sales: '', ops: '' };

const tag = `CP${randomUUID().slice(0, 5).toUpperCase()}`;

const patch = (path: string, cookie: string, body: object) =>
  t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

const createLocation = async (body: object) =>
  (await r.post('/master-data/locations', cookies.admin, body).expect(201)).body as LocationDto;

const location = (suffix: string, kind: 'CITY' | 'PORT', extra: object = {}) => ({
  code: `${tag}${suffix}`,
  kind,
  nameEn: `City ports ${tag}${suffix}`,
  nameAr: 'اختبار المدينة والموانئ',
  countryCode: 'AE',
  ...extra,
});

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  portSudan = (await t.prisma.location.findUniqueOrThrow({ where: { code: 'SDPZU' } })).id;
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
    sales: await createUser(t.prisma, ['SALES'], ['DXB'], LEDGER_PREFIX),
    ops: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const client = await registerClient(t, cookies.admin, `City ports ${tag}`);
  const agent = await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX);
  token = await tokenFor(t, await signIn(t, agent.email), client);

  city = await createLocation(location('C', 'CITY', { shortCode: 'ZCP' }));
  port = await createLocation(location('P', 'PORT', { cityId: city.id }));
  otherPort = await createLocation(location('Q', 'PORT'));
  rateFromPort = (
    await t.prisma.rateCard.create({
      data: {
        branchId: dxb,
        originLocationId: port.id,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'GENERAL',
        containerTypeCode: '20GP',
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_CONTAINER',
        price: '900',
        minimumCharge: '0',
        currency: 'USD',
        validFrom: new Date('2026-01-01T00:00:00Z'),
        validTo: null,
        status: 'APPROVED',
        createdById: people.sales.id,
        approvedById: people.sales.id,
        approvedAt: new Date(),
      },
    })
  ).id;
  customer = (
    await r
      .post('/customers', cookies.sales, {
        branchId: dxb,
        kind: 'COMPANY',
        name: `City Ports ${tag}`,
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await t.close();
});

describe('a place and its city', () => {
  it('is master data: a place names its city, and master data says so', async () => {
    expect(port.cityId).toBe(city.id);
    const all = (await r.get('/master-data', cookies.sales).expect(200)).body as MasterDataDto;
    expect(all.locations.find((l) => l.id === port.id)?.cityId).toBe(city.id);
    expect(all.locations.find((l) => l.id === city.id)?.cityId).toBeNull();
  });

  it('refuses a city that is not a CITY, a city inside a city, and a city of itself', async () => {
    await r
      .post('/master-data/locations', cookies.admin, location('X', 'PORT', { cityId: port.id }))
      .expect(400);
    await r
      .post('/master-data/locations', cookies.admin, location('Y', 'CITY', { cityId: city.id }))
      .expect(400);
    await patch(`/master-data/locations/${otherPort.id}`, cookies.admin, {
      cityId: otherPort.id,
    }).expect(400);
    // A city its places name stays a city.
    await patch(`/master-data/locations/${city.id}`, cookies.admin, { kind: 'PORT' }).expect(400);
    await r
      .post('/master-data/locations', cookies.sales, location('Z', 'PORT', { cityId: city.id }))
      .expect(403);
  });
});

describe('a place and its city: one country', () => {
  it('refuses a place in another country than its city, in the service', async () => {
    const refused = (
      await r
        .post(
          '/master-data/locations',
          cookies.admin,
          location('S', 'PORT', { cityId: city.id, countryCode: 'SA' }),
        )
        .expect(400)
    ).body as { code: string; fields: string[]; params: Record<string, string> };
    expect(refused).toMatchObject({
      code: 'CITY_OTHER_COUNTRY',
      fields: ['countryCode', 'cityId'],
      params: { city: city.code, country: 'AE' },
    });

    // Without a city the place names its own country, which stays required.
    const noCountry: Record<string, unknown> = location('N', 'PORT');
    delete noCountry.countryCode;
    await r.post('/master-data/locations', cookies.admin, noCountry).expect(400);
    const saudi = await createLocation(location('S', 'PORT', { countryCode: 'SA' }));
    expect(saudi).toMatchObject({ countryCode: 'SA', cityId: null });

    // Picking a city of another country, or moving a place away from its city's country.
    await patch(`/master-data/locations/${saudi.id}`, cookies.admin, { cityId: city.id })
      .expect(400)
      .expect((res) => expect((res.body as { code: string }).code).toBe('CITY_OTHER_COUNTRY'));
    await patch(`/master-data/locations/${port.id}`, cookies.admin, { countryCode: 'SA' })
      .expect(400)
      .expect((res) => expect((res.body as { code: string }).code).toBe('CITY_OTHER_COUNTRY'));
    // A city whose places are in its country keeps that country.
    await patch(`/master-data/locations/${city.id}`, cookies.admin, { countryCode: 'SA' }).expect(
      400,
    );
    // The city and its country together.
    const moved = (
      await patch(`/master-data/locations/${saudi.id}`, cookies.admin, {
        cityId: city.id,
        countryCode: 'AE',
      }).expect(200)
    ).body as LocationDto;
    expect(moved).toMatchObject({ cityId: city.id, countryCode: 'AE' });
    // Who may only view master data changes nothing.
    await patch(`/master-data/locations/${saudi.id}`, cookies.sales, { cityId: null }).expect(403);
    // Not one of the city's places for the lists below.
    await patch(`/master-data/locations/${saudi.id}`, cookies.admin, { cityId: null }).expect(200);
  });
});

describe('a place and its city, at once (Codex F96-1)', () => {
  it("never leaves a new place in another country than its city's", async () => {
    const lone = await createLocation(location('R', 'CITY'));
    // Another session holds the city row, so both requests below are under way before either
    // one writes.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const holdingNow = new Promise<void>((resolve) => (holding = resolve));
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "locations" WHERE "id" = ${lone.id}::uuid FOR NO KEY UPDATE`;
        holding();
        await held;
      },
      { timeout: 20_000 },
    );
    await holdingNow;
    const toSaudi = patch(`/master-data/locations/${lone.id}`, cookies.admin, {
      countryCode: 'SA',
    }).then((res) => res);
    await waitForLockWaiter(t.prisma, 1);
    const newPort = r
      .post('/master-data/locations', cookies.admin, location('RP', 'PORT', { cityId: lone.id }))
      .then((res) => res);
    await waitForLockWaiter(t.prisma, 2);
    release();
    await holder;
    const statuses = [(await toSaudi).status, (await newPort).status];
    // One of them is refused, whichever ran second.
    expect(statuses.filter((s) => s >= 200 && s < 300)).toHaveLength(1);
    expect(statuses.filter((s) => s === 400)).toHaveLength(1);
    const saved = await t.prisma.location.findUniqueOrThrow({ where: { id: lone.id } });
    const places = await t.prisma.location.findMany({ where: { cityId: lone.id } });
    for (const place of places) expect(place.countryCode).toBe(saved.countryCode);
  });
});

describe('lists filtered by a city', () => {
  it('find rates from its ports and say which locations they matched', async () => {
    const byCity = (
      await r.get(`/rates?originLocationId=${city.id}&pageSize=100`, cookies.sales).expect(200)
    ).body as Page<RateCardDto>;
    expect(byCity.items.map((i) => i.id)).toContain(rateFromPort);
    expect(byCity.matchedLocations).toEqual({
      originLocationIds: [city.id, port.id],
      destinationLocationIds: null,
    });
    // Through the assistant, the same.
    const viaAgent = (
      await r.agentGet(`/rates?originLocationId=${city.id}&pageSize=100`, token).expect(200)
    ).body as Page<RateCardDto>;
    expect(viaAgent.items.map((i) => i.id)).toContain(rateFromPort);
  });

  it('stay exact on a port, and say nothing without a route filter', async () => {
    const byOther = (
      await r.get(`/rates?originLocationId=${otherPort.id}`, cookies.sales).expect(200)
    ).body as Page<RateCardDto>;
    expect(byOther.items.map((i) => i.id)).not.toContain(rateFromPort);
    expect(byOther.matchedLocations).toEqual({
      originLocationIds: [otherPort.id],
      destinationLocationIds: null,
    });
    const unfiltered = (await r.get('/rates?pageSize=1', cookies.sales).expect(200))
      .body as Page<RateCardDto>;
    expect(unfiltered).not.toHaveProperty('matchedLocations');
  });

  it('find quotations and containers from its ports; the record keeps the port', async () => {
    const quotation = (
      await r
        .post('/quotations', cookies.sales, {
          customerId: customer.id,
          originLocationId: port.id,
          destinationLocationId: portSudan,
          mode: 'SEA',
          loadType: 'FCL',
          cargoType: 'GENERAL',
          currency: 'USD',
          validUntil: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
          lines: [
            { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', unitPrice: '10', quantity: '1' },
          ],
        })
        .expect(201)
    ).body as QuotationDto;
    expect(quotation.originLocationId).toBe(port.id);
    const quotations = (
      await r.get(`/quotations?originLocationId=${city.id}`, cookies.sales).expect(200)
    ).body as Page<QuotationDto>;
    expect(quotations.items.map((q) => q.id)).toContain(quotation.id);
    expect(quotations.matchedLocations?.originLocationIds).toEqual([city.id, port.id]);

    const container = (
      await r
        .post('/consolidations', cookies.ops, {
          branchId: dxb,
          originLocationId: port.id,
          destinationLocationId: portSudan,
          containerTypeCode: '20GP',
          shipmentIds: [],
        })
        .expect(201)
    ).body as ConsolidationSummaryDto;
    const containers = (
      await r.get(`/consolidations?originLocationId=${city.id}`, cookies.ops).expect(200)
    ).body as Page<ConsolidationSummaryDto>;
    expect(containers.items.map((c) => c.id)).toContain(container.id);
  });
});
