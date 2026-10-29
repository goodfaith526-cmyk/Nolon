import type { ApiClientCreatedDto, CsCatalogDto, CsQuoteDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/auth-user.js';
import { todayIn } from '../src/common/dates.js';
import { ApiClientsService } from '../src/customer-service/api-clients.service.js';
import { MasterDataService } from '../src/master-data/master-data.service.js';
import { RatesService } from '../src/rates/rates.service.js';
import {
  SOFT_LAUNCH_NOTES,
  SOFT_LAUNCH_PLACES,
  type SoftLaunchDeps,
  applySoftLaunch,
  softLaunchActor,
  softLaunchCards,
} from '../src/seed/soft-launch.js';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';

/**
 * The soft-launch data script (seed/soft-launch.ts) against PostgreSQL: it enters the places,
 * categories, 36 approved cards, routing and key scopes through the services, the bot then quotes
 * and lists them, and a second run changes nothing. What it adds is undone afterwards (cards
 * cancelled, routing and aliases put back, new categories deactivated), so other files never see it.
 */
describe('soft-launch data script', () => {
  let t: TestApp;
  let deps: SoftLaunchDeps;
  let actor: AuthUser;
  let bot: ApiClientCreatedDto;
  let adminEmail = '';
  const today = todayIn('UTC');
  const before = {
    places: new Set<string>(),
    aliases: [] as { locationId: string; alias: string }[],
    routing: [] as { locationId: string; branchId: string }[],
    categories: new Set<string>(),
    cards: new Set<string>(),
    /** Of those, the ones still in force (a run before cancels its own). */
    live: 0,
  };
  const codes = SOFT_LAUNCH_PLACES.map((p) => p.code);
  const placeIds = async () =>
    Object.fromEntries(
      (await t.prisma.location.findMany({ where: { code: { in: codes } } })).map((l) => [
        l.code,
        l.id,
      ]),
    );
  const ours = () => ({
    priceCategoryCode: { in: ['BARREL', 'SUITCASE', 'CARTON50'] },
    origin: { code: { in: ['SAJED', 'AEDXB', 'AESHJ'] } },
    destination: { code: { in: ['SDPZU', 'SDATB', 'SDKRT', 'SDDOG'] } },
  });

  beforeAll(async () => {
    t = await createTestApp();
    deps = {
      prisma: t.prisma,
      masterData: t.app.get(MasterDataService),
      rates: t.app.get(RatesService),
      apiClients: t.app.get(ApiClientsService),
    };
    // Not an it- user: the shared cleanup deletes their rate cards, and the bot's quotes keep these.
    adminEmail = (await createUser(t.prisma, ['ADMINISTRATOR'], [], 'soft-launch-it-')).email;
    const cookie = await signIn(t, adminEmail);
    bot = (
      await t
        .http()
        .post('/api/v1/api-clients')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send({
          name: 'Soft launch bot',
          branchIds: [await branchId(t.prisma, 'JED'), await branchId(t.prisma, 'PTS')],
          scopes: ['cs:tracking:lookup'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;
    actor = await softLaunchActor(t.prisma, adminEmail.toUpperCase());

    const ids = Object.values(await placeIds());
    for (const id of ids) before.places.add(id);
    before.aliases = await t.prisma.locationAlias.findMany({
      where: { locationId: { in: ids } },
      select: { locationId: true, alias: true },
    });
    before.routing = await t.prisma.branchRoutingRule.findMany({
      where: { locationId: { in: ids } },
      select: { locationId: true, branchId: true },
    });
    for (const c of await t.prisma.priceCategory.findMany()) before.categories.add(c.code);
    for (const r of await t.prisma.rateCard.findMany({ where: ours() })) {
      before.cards.add(r.id);
      if (r.status !== 'CANCELLED') before.live++;
    }
  });

  afterAll(async () => {
    if (!t) return;
    const ids = Object.values(await placeIds());
    await t.prisma.rateCard.updateMany({
      where: { ...ours(), id: { notIn: [...before.cards] }, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED' },
    });
    await t.prisma.branchRoutingRule.deleteMany({ where: { locationId: { in: ids } } });
    await t.prisma.branchRoutingRule.createMany({ data: before.routing });
    await t.prisma.locationAlias.deleteMany({ where: { locationId: { in: ids } } });
    await t.prisma.locationAlias.createMany({ data: before.aliases });
    await t.prisma.location.updateMany({
      where: { id: { in: ids.filter((id) => !before.places.has(id)) } },
      data: { isActive: false },
    });
    await t.prisma.priceCategory.updateMany({
      where: {
        code: { in: ['SUITCASE', 'CARTON50'] },
        NOT: { code: { in: [...before.categories] } },
      },
      data: { isActive: false },
    });
    await deps.apiClients.revoke(actor, bot.client.id);
    await t.close();
  });

  it('has the 36 cards of the table', () => {
    const cards = softLaunchCards();
    expect(cards).toHaveLength(36);
    const price = (origin: string, category: string) => [
      ...new Set(
        cards
          .filter((c) => c.origin === origin && c.category === category)
          .map((c) => `${c.price} ${c.currency}`),
      ),
    ];
    expect(price('SAJED', 'BARREL')).toEqual(['250 SAR']);
    expect(price('SAJED', 'SUITCASE')).toEqual(['150 SAR']);
    expect(price('SAJED', 'CARTON50')).toEqual(['150 SAR']);
    expect(price('AEDXB', 'BARREL')).toEqual(['300 AED']);
    expect(price('AESHJ', 'BARREL')).toEqual(['300 AED']);
    expect(price('AESHJ', 'CARTON50')).toEqual(['150 AED']);
    expect(cards.filter((c) => c.destination === 'SDPZU').every((c) => c.mode === 'SEA')).toBe(
      true,
    );
    expect(cards.filter((c) => c.destination !== 'SDPZU').every((c) => c.mode === 'SEA_ROAD')).toBe(
      true,
    );
  });

  it('enters everything through the services, and the bot quotes and lists it', async () => {
    const report = await applySoftLaunch(deps, actor, { today, keyPrefix: bot.client.keyPrefix });
    expect(report.join('\n')).toContain('بطاقات الأسعار:');

    const cards = await t.prisma.rateCard.findMany({
      where: { ...ours(), id: { notIn: [...before.cards] } },
      include: { branch: true, origin: true, destination: true },
    });
    expect(cards).toHaveLength(36 - before.live);
    for (const c of cards) {
      expect(c.status).toBe('APPROVED');
      expect(c.approvedById).toBe(actor.id);
      expect(c.transitDays).toBe(25);
      expect(c.notes).toBe(SOFT_LAUNCH_NOTES);
      expect(c.branch.code).toBe(c.origin.code === 'SAJED' ? 'JED' : 'DXB');
    }
    // Each card is in the audit log as created and approved by the Administrator.
    const audited = await t.prisma.auditEvent.count({
      where: { entity: 'RATE', entityId: { in: cards.map((c) => c.id) }, userId: actor.id },
    });
    expect(audited).toBe(cards.length * 2);

    const ids = await placeIds();
    const jeddah = await t.prisma.location.findUniqueOrThrow({
      where: { code: 'SAJED' },
      include: { aliases: true },
    });
    expect(jeddah.aliases.map((a) => a.alias)).toEqual(expect.arrayContaining(['جده', 'Jedda']));
    expect(await deps.masterData.routingCandidates(ids.CNCAN!)).toHaveLength(1);
    expect(await deps.masterData.routingCandidates(ids.EGCAI!)).toHaveLength(1);

    const key = (await deps.apiClients.list()).find((k) => k.id === bot.client.id);
    expect(key?.scopes).toEqual([
      'cs:catalog:read',
      'cs:quote:read',
      'cs:booking_requests:create',
      'cs:tracking:lookup',
    ]);

    const catalog = (
      await t.http().get('/api/v1/cs/catalog').set('Authorization', `Bearer ${bot.key}`).expect(200)
    ).body as CsCatalogDto;
    const origins = catalog.origins.map((o) => o.code);
    for (const code of ['SAJED', 'AEDXB', 'AESHJ', 'EGCAI', 'CNCAN']) {
      expect(origins).toContain(code);
    }
    const destinations = catalog.destinations.map((d) => d.code);
    for (const code of ['SDPZU', 'SDATB', 'SDKRT', 'SDDOG']) expect(destinations).toContain(code);
    expect(catalog.categories.map((c) => c.code)).toEqual(
      expect.arrayContaining(['BARREL', 'SUITCASE', 'CARTON50']),
    );

    const quote = (
      await t
        .http()
        .get('/api/v1/cs/quote')
        .query({
          originId: ids.SAJED,
          destinationId: ids.SDDOG,
          category: 'BARREL',
          quantity: '2',
        })
        .set('Authorization', `Bearer ${bot.key}`)
        .expect(200)
    ).body as CsQuoteDto;
    expect([quote.price, quote.currency, quote.unit, quote.mode, quote.transitDays]).toEqual([
      '250',
      'SAR',
      'PER_BARREL',
      'SEA_ROAD',
      25,
    ]);
    expect([quote.total, quote.bookable]).toEqual(['500.00', true]);
  });

  it('changes nothing on a second run, and keeps a card staff set at another price', async () => {
    const card = await t.prisma.rateCard.findFirstOrThrow({
      where: {
        ...ours(),
        origin: { code: 'AESHJ' },
        destination: { code: 'SDKRT' },
        priceCategoryCode: 'SUITCASE',
        status: 'APPROVED',
      },
    });
    // Staff replace one card with their own price.
    await t.prisma.rateCard.update({ where: { id: card.id }, data: { status: 'CANCELLED' } });
    await t.prisma.rateCard.create({
      data: {
        ...card,
        id: undefined,
        price: '175',
        status: 'APPROVED',
        createdAt: undefined,
        updatedAt: undefined,
      },
    });
    const count = () => t.prisma.rateCard.count({ where: { ...ours(), status: 'APPROVED' } });
    const was = await count();
    const aliases = await t.prisma.locationAlias.count();
    const report = await applySoftLaunch(deps, actor, { today, keyPrefix: bot.client.keyPrefix });
    expect(await count()).toBe(was);
    expect(await t.prisma.locationAlias.count()).toBe(aliases);
    const lines = report.join('\n');
    expect(lines).toContain('بطاقات الأسعار: 0 جديدة معتمدة، 35 موجودة من قبل، 1 لم تُدخل');
    expect(lines).toContain('175 AED');
    expect(lines).toContain('الصلاحيات التلاتة موجودة');
    // The key covers JED and PTS, not DXB: the script says so.
    expect(lines).toContain('لا تشمل DXB');
  });

  it('refuses to act as anyone but an active Administrator', async () => {
    const sales = await createUser(t.prisma, ['SALES'], ['JED']);
    await expect(softLaunchActor(t.prisma, sales.email)).rejects.toThrow('No active Administrator');
  });
});
