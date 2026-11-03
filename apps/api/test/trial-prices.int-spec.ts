import type { ApiClientCreatedDto, CsQuoteDto } from '@nolon/shared';
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
} from '../src/seed/soft-launch.js';
import { TRIAL_NOTES, applyTrialPrices, trialCards } from '../src/seed/trial-prices.js';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';

/**
 * The trial-prices script (seed/trial-prices.ts) against PostgreSQL: after the soft-launch prices,
 * every route of the bot has an approved card in every category, the soft-launch cards and any
 * staff card are left alone, and a second run changes nothing. What both scripts add is undone
 * afterwards, as in soft-launch.int-spec.ts.
 */
describe('trial-prices data script', () => {
  let t: TestApp;
  let deps: SoftLaunchDeps;
  let actor: AuthUser;
  let key: ApiClientCreatedDto;
  const today = todayIn('UTC');
  const codes = SOFT_LAUNCH_PLACES.map((p) => p.code);
  const before = {
    places: new Set<string>(),
    aliases: [] as { locationId: string; alias: string }[],
    routing: [] as { locationId: string; branchId: string }[],
    categories: new Set<string>(),
    cards: new Set<string>(),
  };
  const placeIds = async () =>
    Object.fromEntries(
      (await t.prisma.location.findMany({ where: { code: { in: codes } } })).map((l) => [
        l.code,
        l.id,
      ]),
    );
  const scripted = () => ({ notes: { in: [SOFT_LAUNCH_NOTES, TRIAL_NOTES] } });

  beforeAll(async () => {
    t = await createTestApp();
    deps = {
      prisma: t.prisma,
      masterData: t.app.get(MasterDataService),
      rates: t.app.get(RatesService),
      apiClients: t.app.get(ApiClientsService),
    };
    // Not an it- user: the shared cleanup deletes their rate cards.
    const email = (await createUser(t.prisma, ['ADMINISTRATOR'], [], 'trial-prices-it-')).email;
    actor = await softLaunchActor(t.prisma, email);
    const cookie = await signIn(t, email);
    const branchIds = [await branchId(t.prisma, 'JED'), await branchId(t.prisma, 'DXB')];
    key = (
      await t
        .http()
        .post('/api/v1/api-clients')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send({
          name: 'Trial prices bot',
          branchIds,
          scopes: ['cs:quote:read'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;

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
    for (const r of await t.prisma.rateCard.findMany({ where: scripted(), select: { id: true } })) {
      before.cards.add(r.id);
    }
  });

  afterAll(async () => {
    if (!t || !key) return;
    const ids = Object.values(await placeIds());
    await t.prisma.rateCard.updateMany({
      where: { ...scripted(), id: { notIn: [...before.cards] }, status: { not: 'CANCELLED' } },
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
    await deps.apiClients.revoke(actor, key.client.id);
    await t.close();
  });

  it('fills every route and category the soft launch leaves empty, marked as trial', () => {
    const cards = trialCards();
    // Jeddah, Dubai and Sharjah: carton, pallet, special; Cairo and Guangzhou: all six; every
    // origin three container types. Four destinations each.
    expect(cards).toHaveLength((3 * 3 + 2 * 6 + 5 * 3) * 4);
    const keys = new Set(
      cards.map((c) => `${c.origin}|${c.destination}|${c.containerTypeCode ?? c.category}`),
    );
    expect(keys.size).toBe(cards.length);
    for (const c of cards) {
      expect(c.notes).toBe(TRIAL_NOTES);
      if (['BARREL', 'SUITCASE', 'CARTON50'].includes(c.category)) {
        expect(['EGCAI', 'CNCAN']).toContain(c.origin);
      }
      expect(c.category === 'CONTAINER').toBe(c.containerTypeCode !== undefined);
    }
    expect(cards.filter((c) => c.category === 'CONTAINER')).toHaveLength(5 * 3 * 4);
    expect(TRIAL_NOTES).toContain('سعر تجريبي');
  });

  it('enters the trial cards beside the soft-launch ones, never over them, and again changes nothing', async () => {
    await applySoftLaunch(deps, actor, { today });
    const ids = await placeIds();
    // Staff already priced Cairo → Khartoum pallets: that card stays, ours is not added.
    const staff = await deps.rates.create(actor, {
      branchId: await branchId(t.prisma, 'DXB'),
      originLocationId: ids.EGCAI!,
      destinationLocationId: ids.SDKRT!,
      mode: 'SEA_ROAD',
      cargoType: 'PALLET',
      chargeTypeCode: 'FREIGHT',
      priceCategoryCode: 'PALLET',
      unit: 'PER_CBM',
      price: '199',
      currency: 'USD',
      validFrom: today,
    });
    const softCards = await t.prisma.rateCard.findMany({
      where: { notes: SOFT_LAUNCH_NOTES, status: 'APPROVED' },
      orderBy: { id: 'asc' },
    });

    const first = (await applyTrialPrices(deps, actor, { today })).join('\n');
    const expected = trialCards().length;
    expect(first).toContain(
      `بطاقات الأسعار: ${expected - 1} جديدة معتمدة، 0 موجودة من قبل، 1 لم تُدخل`,
    );
    expect(first).toContain('199 USD');

    const trial = await t.prisma.rateCard.findMany({
      where: { notes: TRIAL_NOTES, id: { notIn: [...before.cards] } },
      include: { branch: true, origin: true, priceCategory: true },
    });
    expect(trial).toHaveLength(expected - 1);
    for (const c of trial) {
      expect(c.status).toBe('APPROVED');
      expect(c.approvedById).toBe(actor.id);
      if (c.containerTypeCode) {
        expect([c.cargoType, c.unit, c.loadType, c.priceCategoryCode]).toEqual([
          'CONTAINER',
          'PER_CONTAINER',
          'FCL',
          null,
        ]);
      } else {
        expect(c.unit).toBe(c.priceCategory?.defaultUnit);
      }
      expect(c.branch.code).toBe(c.origin.code === 'SAJED' ? 'JED' : 'DXB');
      expect(c.transitDays).toBe(c.origin.code === 'CNCAN' ? 45 : 25);
    }
    const staffAfter = await t.prisma.rateCard.findUniqueOrThrow({ where: { id: staff.id } });
    expect([staffAfter.status, staffAfter.price.toString(), staffAfter.notes]).toEqual([
      'DRAFT',
      '199',
      null,
    ]);
    // The soft-launch cards are exactly as they were.
    expect(
      await t.prisma.rateCard.findMany({
        where: { notes: SOFT_LAUNCH_NOTES, status: 'APPROVED' },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(softCards);

    // The bot quotes a trial price like any other approved card.
    const quote = (
      await t
        .http()
        .get('/api/v1/cs/quote')
        .query({
          originId: ids.CNCAN,
          destinationId: ids.SDPZU,
          category: 'SPECIAL',
          quantity: '1',
        })
        .set('Authorization', `Bearer ${key.key}`)
        .expect(200)
    ).body as CsQuoteDto;
    expect([quote.price, quote.currency, quote.unit, quote.mode, quote.transitDays]).toEqual([
      '1200',
      'USD',
      'PER_SHIPMENT',
      'SEA',
      45,
    ]);

    const count = () => t.prisma.rateCard.count({ where: { status: { not: 'CANCELLED' } } });
    const was = await count();
    const second = (await applyTrialPrices(deps, actor, { today })).join('\n');
    expect(second).toContain(
      `بطاقات الأسعار: 0 جديدة معتمدة، ${expected - 1} موجودة من قبل، 1 لم تُدخل`,
    );
    expect(await count()).toBe(was);
    await deps.rates.cancel(actor, staff.id);
  });

  it('never turns back on an origin or destination staff turned off (Codex F160-1)', async () => {
    const off = await t.prisma.location.findMany({ where: { code: { in: ['EGCAI', 'SDDOG'] } } });
    expect(off).toHaveLength(2);
    await t.prisma.location.updateMany({
      where: { id: { in: off.map((l) => l.id) } },
      data: { isActive: false },
    });
    try {
      const count = () => t.prisma.rateCard.count({ where: { status: { not: 'CANCELLED' } } });
      const was = await count();
      const lines = (await applyTrialPrices(deps, actor, { today })).join('\n');
      expect(lines).toContain('مكان موقوف: القاهرة (EGCAI)');
      expect(lines).toContain('مكان موقوف: دنقلا (SDDOG)');
      expect(lines).toContain('ينقصها فرع أو مكان أو فئة');
      expect(await count()).toBe(was);
      const after = await t.prisma.location.findMany({
        where: { id: { in: off.map((l) => l.id) } },
      });
      expect(after.map((l) => l.isActive)).toEqual([false, false]);
    } finally {
      await t.prisma.location.updateMany({
        where: { id: { in: off.map((l) => l.id) } },
        data: { isActive: true },
      });
    }
  });

  it('skips the cards of a category staff turned off, and says so', async () => {
    await deps.masterData.setPriceCategoryActive(actor, 'SPECIAL', false);
    try {
      const lines = (await applyTrialPrices(deps, actor, { today })).join('\n');
      expect(lines).toContain('فئة موقوفة: SPECIAL');
    } finally {
      await deps.masterData.setPriceCategoryActive(actor, 'SPECIAL', true);
    }
  });
});
