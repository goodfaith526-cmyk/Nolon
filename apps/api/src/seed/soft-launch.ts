import { randomUUID } from 'node:crypto';
import {
  hasAllBranchAccess,
  type CargoType,
  type CreateRateCardRequest,
  type CsScope,
  type LocationKind,
  type RateUnit,
  type ShippingMode,
} from '@nolon/shared';
import { loadAccess, readAccessVersion } from '../access-control/access-loader.js';
import type { AuthUser } from '../auth/auth-user.js';
import { credentialStamp } from '../auth/credential-lock.js';
import { toDbDate } from '../common/dates.js';
import { fold } from '../customer-service/bot-names.js';
import type { ApiClientsService } from '../customer-service/api-clients.service.js';
import type { MasterDataService } from '../master-data/master-data.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { type RatesService, withLoadType } from '../rates/rates.service.js';

/**
 * The soft-launch prices of the customer-service booking bot (owner's request, 2026-10-29, numbers
 * from NOLON's sales on 2026-10-28): places and their other names, two new price categories, 36
 * approved rate cards, routing for the priced origins and for Cairo and Guangzhou (no price yet),
 * the three scopes the bot's API key needs, and pickup and door delivery off for that key.
 * Everything goes through NOLON's own services, as the screens do, so the same rules, locks and
 * audit log apply.
 *
 * Safe to run again: what is there already is left as it is and reported. Nothing is deleted, an
 * approved card is never changed, and a routing rule or category staff already set is kept.
 */

export interface PlaceSpec {
  code: string;
  kind: LocationKind;
  nameEn: string;
  nameAr: string;
  countryCode: string;
  aliases: readonly string[];
}

export const SOFT_LAUNCH_PLACES: readonly PlaceSpec[] = [
  // Origins.
  {
    code: 'SAJED',
    kind: 'PORT',
    nameEn: 'Jeddah',
    nameAr: 'جدة',
    countryCode: 'SA',
    aliases: ['جده', 'Jeddah', 'Jedda', 'Jiddah'],
  },
  {
    code: 'AEDXB',
    kind: 'CITY',
    nameEn: 'Dubai',
    nameAr: 'دبي',
    countryCode: 'AE',
    aliases: ['دبى', 'Dubai'],
  },
  {
    code: 'AESHJ',
    kind: 'CITY',
    nameEn: 'Sharjah',
    nameAr: 'الشارقة',
    countryCode: 'AE',
    aliases: ['الشارقه', 'شارقة', 'الشارجة', 'Sharjah'],
  },
  {
    code: 'EGCAI',
    kind: 'CITY',
    nameEn: 'Cairo',
    nameAr: 'القاهرة',
    countryCode: 'EG',
    aliases: ['القاهره', 'Cairo'],
  },
  {
    code: 'CNCAN',
    kind: 'CITY',
    nameEn: 'Guangzhou',
    nameAr: 'قوانزو',
    countryCode: 'CN',
    aliases: ['قوانجو', 'غوانزو', 'جوانزو', 'قوانغتشو', 'غوانغتشو', 'Guangzhou', 'Canton'],
  },
  // Destinations.
  {
    code: 'SDPZU',
    kind: 'PORT',
    nameEn: 'Port Sudan',
    nameAr: 'بورتسودان',
    countryCode: 'SD',
    aliases: ['بورسودان', 'بور سودان', 'بورت سودان', 'Port Sudan', 'Portsudan'],
  },
  {
    code: 'SDATB',
    kind: 'CITY',
    nameEn: 'Atbara',
    nameAr: 'عطبرة',
    countryCode: 'SD',
    aliases: ['عطبره', 'Atbara'],
  },
  {
    code: 'SDKRT',
    kind: 'CITY',
    nameEn: 'Khartoum',
    nameAr: 'الخرطوم',
    countryCode: 'SD',
    aliases: ['خرطوم', 'Khartoum'],
  },
  {
    code: 'SDDOG',
    kind: 'CITY',
    nameEn: 'Dongola',
    nameAr: 'دنقلا',
    countryCode: 'SD',
    aliases: ['دنقلة', 'دنقله', 'Dongola'],
  },
];

export interface CategorySpec {
  code: string;
  nameEn: string;
  nameAr: string;
  cargoType: CargoType;
  unit: RateUnit;
  /** Created when missing; an existing category keeps its names. */
  create: boolean;
}

export const SOFT_LAUNCH_CATEGORIES: readonly CategorySpec[] = [
  // Seeded by migration 20261021172517; a 200-litre barrel the customer brings.
  {
    code: 'BARREL',
    nameEn: 'Barrel',
    nameAr: 'برميل',
    cargoType: 'BARREL',
    unit: 'PER_BARREL',
    create: false,
  },
  {
    code: 'SUITCASE',
    nameEn: 'Suitcase up to 30 kg',
    nameAr: 'شنطة سفر لحدي 30 كيلو',
    cargoType: 'GENERAL',
    unit: 'PER_PIECE',
    create: true,
  },
  // Its own category, not CARTON («كرتون / طرد», no weight limit): this price holds to 50 kg.
  {
    code: 'CARTON50',
    nameEn: 'Carton up to 50 kg',
    nameAr: 'كرتونة لحدي 50 كيلو',
    cargoType: 'GENERAL',
    unit: 'PER_PIECE',
    create: true,
  },
];

/** Each origin's branch: it owns the cards and serves the customer-service requests. */
export const SOFT_LAUNCH_ORIGINS: Readonly<Record<string, string>> = {
  SAJED: 'JED',
  AEDXB: 'DXB',
  AESHJ: 'DXB',
  // No price yet (within a month): the bot takes the request and sales call back in 48 hours.
  EGCAI: 'DXB',
  CNCAN: 'DXB',
};

export const SOFT_LAUNCH_DESTINATIONS = ['SDPZU', 'SDATB', 'SDKRT', 'SDDOG'] as const;

/** Prices by origin and category, in the origin's currency. Sharjah is priced as Dubai. */
export const SOFT_LAUNCH_PRICES: readonly {
  origins: readonly string[];
  currency: string;
  prices: Readonly<Record<string, string>>;
}[] = [
  {
    origins: ['SAJED'],
    currency: 'SAR',
    prices: { BARREL: '250', SUITCASE: '150', CARTON50: '150' },
  },
  {
    origins: ['AEDXB', 'AESHJ'],
    currency: 'AED',
    prices: { BARREL: '300', SUITCASE: '150', CARTON50: '150' },
  },
];

/** The quoted transit time is 15 to 25 days; a card holds one number, the longer one. */
export const SOFT_LAUNCH_TRANSIT_DAYS = 25;

export const SOFT_LAUNCH_NOTES =
  'سعر الحجز المسبق (السوفت لانش) لأول حجز للزبون. مدة الوصول 15 إلى 25 يوم. ' +
  'شامل الشحن والتغليف والجمارك في السودان. الكرتونة فوق 50 كيلو: زيادة 2 درهم لكل كيلو، ' +
  'يحسبها الموظف مع تأكيد الحجز.';

/** The scopes the booking bot's key needs; any other scope the key holds is kept. */
export const SOFT_LAUNCH_SCOPES: readonly CsScope[] = [
  'cs:catalog:read',
  'cs:quote:read',
  'cs:booking_requests:create',
];

export interface CardSpec {
  branchCode: string;
  origin: string;
  destination: string;
  category: string;
  mode: ShippingMode;
  price: string;
  currency: string;
}

/** The 36 cards: 3 origins, 4 destinations, 3 categories. Port Sudan by sea; inland sea + road. */
export function softLaunchCards(): CardSpec[] {
  return SOFT_LAUNCH_PRICES.flatMap(({ origins, currency, prices }) =>
    origins.flatMap((origin) =>
      SOFT_LAUNCH_DESTINATIONS.flatMap((destination) =>
        Object.entries(prices).map(([category, price]) => ({
          branchCode: SOFT_LAUNCH_ORIGINS[origin] ?? '',
          origin,
          destination,
          category,
          mode: destination === 'SDPZU' ? ('SEA' as const) : ('SEA_ROAD' as const),
          price,
          currency,
        })),
      ),
    ),
  );
}

export interface SoftLaunchDeps {
  prisma: PrismaService;
  masterData: MasterDataService;
  rates: RatesService;
  apiClients: ApiClientsService;
}

export interface SoftLaunchOptions {
  /** The UTC date the cards are valid from (YYYY-MM-DD). */
  today: string;
  /** The booking bot's API key, by its prefix (nolcs_...): without it no key changes. */
  keyPrefix?: string;
}

/**
 * The person the changes are made as, in the audit log: the Administrator with `email`, else the
 * first active Administrator. Built as a signed-in request builds it, without a session.
 */
export async function softLaunchActor(prisma: PrismaService, email?: string): Promise<AuthUser> {
  const version = await readAccessVersion(prisma);
  const user = await prisma.user.findFirst({
    where: {
      isActive: true,
      roles: { some: { role: 'ADMINISTRATOR' } },
      ...(email ? { email: email.toLowerCase() } : {}),
    },
    include: { roles: true, branches: { select: { branchId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) throw new Error(`No active Administrator${email ? ` with email ${email}` : ''}`);
  const roles = user.roles.map((r) => r.role);
  const access = await loadAccess(
    prisma,
    user.id,
    roles,
    user.branches.map((b) => b.branchId),
    version,
  );
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    preferredLocale: user.preferredLocale,
    sessionId: randomUUID(),
    credentialStamp: credentialStamp(user.passwordHash),
    roles,
    access,
    allBranches: hasAllBranchAccess(roles),
    allowedBranchIds: access.branchIds(),
    allowedOutletIds: null,
  };
}

/** Applies the soft-launch data. Returns what it did and found, one line each, for the console. */
export async function applySoftLaunch(
  deps: SoftLaunchDeps,
  actor: AuthUser,
  options: SoftLaunchOptions,
): Promise<string[]> {
  const report: string[] = [];
  const say = (line: string) => report.push(line);
  const { prisma, masterData, rates, apiClients } = deps;

  const branches = new Map(
    (await prisma.branch.findMany({ select: { id: true, code: true } })).map((b) => [b.code, b.id]),
  );

  // 1. Places: found by code, else by a name in the same country; created when missing.
  const placeIds = new Map<string, string>();
  for (const spec of SOFT_LAUNCH_PLACES) {
    const id = await ensurePlace(deps, actor, spec, say);
    if (id) placeIds.set(spec.code, id);
  }

  // 2. Price categories.
  const categories = new Set<string>();
  for (const spec of SOFT_LAUNCH_CATEGORIES) {
    const row = await prisma.priceCategory.findUnique({ where: { code: spec.code } });
    if (!row) {
      if (!spec.create) {
        say(`فئة ناقصة: ${spec.code}، بطاقاتها لم تُدخل`);
        continue;
      }
      await masterData.createPriceCategory(actor, {
        code: spec.code,
        nameEn: spec.nameEn,
        nameAr: spec.nameAr,
        cargoType: spec.cargoType,
        defaultUnit: spec.unit,
      });
      say(`فئة جديدة: ${spec.code} «${spec.nameAr}»`);
    } else if (row.cargoType !== spec.cargoType || row.defaultUnit !== spec.unit) {
      say(
        `فئة ${spec.code} موجودة بنوع ${row.cargoType} ووحدة ${row.defaultUnit}، ` +
          `لا ${spec.cargoType} و${spec.unit}: بطاقاتها لم تُدخل`,
      );
      continue;
    } else if (!row.isActive) {
      await masterData.setPriceCategoryActive(actor, spec.code, true);
      say(`فئة مُفعّلة: ${spec.code} «${row.nameAr}»`);
    } else {
      say(`فئة موجودة: ${spec.code} «${row.nameAr}»`);
    }
    categories.add(spec.code);
  }
  const categorySpecs = new Map(SOFT_LAUNCH_CATEGORIES.map((c) => [c.code, c]));

  // 3. Rate cards: created as drafts and approved, as on the rates screen. A card already in force
  // today with exactly these terms (transit days and note included, no end date) counts as
  // present; any other card on the same route and category (a staff draft, a card with other
  // terms, one starting later) is left as it is and reported, never approved or changed: staff
  // decide.
  const counts = { created: 0, present: 0, skipped: 0 };
  const today = toDbDate(options.today);
  for (const card of softLaunchCards()) {
    const label = `${card.origin}→${card.destination} ${card.category}`;
    const branchId = branches.get(card.branchCode);
    const origin = placeIds.get(card.origin);
    const destination = placeIds.get(card.destination);
    const category = categories.has(card.category) ? categorySpecs.get(card.category) : undefined;
    if (!branchId || !origin || !destination || !category) {
      say(`بطاقة لم تُدخل (ينقصها فرع أو مكان أو فئة): ${label}`);
      counts.skipped++;
      continue;
    }
    const input = withLoadType<CreateRateCardRequest>({
      branchId,
      originLocationId: origin,
      destinationLocationId: destination,
      mode: card.mode,
      cargoType: category.cargoType,
      chargeTypeCode: 'FREIGHT',
      priceCategoryCode: card.category,
      unit: category.unit,
      price: card.price,
      currency: card.currency,
      validFrom: options.today,
      transitDays: SOFT_LAUNCH_TRANSIT_DAYS,
      notes: SOFT_LAUNCH_NOTES,
    });
    const existing = await prisma.rateCard.findMany({
      where: {
        branchId,
        originLocationId: origin,
        destinationLocationId: destination,
        priceCategoryCode: card.category,
        chargeTypeCode: 'FREIGHT',
        status: { in: ['DRAFT', 'APPROVED'] },
        OR: [{ validTo: null }, { validTo: { gte: today } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    const inForce = (r: (typeof existing)[number]) =>
      r.status === 'APPROVED' &&
      r.validFrom <= today &&
      r.mode === input.mode &&
      r.loadType === (input.loadType ?? null) &&
      r.cargoType === input.cargoType &&
      r.containerTypeCode === null &&
      r.unit === input.unit &&
      r.currency === input.currency &&
      r.price.equals(input.price) &&
      r.minimumCharge.isZero() &&
      r.validTo === null &&
      r.transitDays === SOFT_LAUNCH_TRANSIT_DAYS &&
      r.notes === SOFT_LAUNCH_NOTES;
    if (existing.some(inForce)) {
      counts.present++;
      continue;
    }
    if (existing.length > 0) {
      const others = existing
        .map((r) => {
          const from = r.validFrom.toISOString().slice(0, 10);
          return `${r.status} ${r.price.toString()} ${r.currency} ${r.unit} من ${from} ${r.transitDays ?? '-'} يوم`;
        })
        .join('؛ ');
      say(`بطاقة أخرى على نفس الطريق والفئة، تُركت كما هي ولم تُدخل بطاقتنا (${others}): ${label}`);
      counts.skipped++;
      continue;
    }
    const created = await rates.create(actor, input);
    try {
      await rates.approve(actor, created.id);
    } catch (error) {
      // Never leave a draft behind: a later run would find it and skip the card.
      await rates.cancel(actor, created.id);
      throw error;
    }
    counts.created++;
  }
  say(
    `بطاقات الأسعار: ${counts.created} جديدة معتمدة، ${counts.present} موجودة من قبل، ${counts.skipped} لم تُدخل`,
  );

  // 4. Routing: the branch that serves each origin, unless staff already set one.
  for (const [code, branchCode] of Object.entries(SOFT_LAUNCH_ORIGINS)) {
    const id = placeIds.get(code);
    const branchId = branches.get(branchCode);
    if (!id || !branchId) continue;
    const current = await masterData.routingCandidates(id);
    if (current.length === 0) {
      await masterData.setRoutingBranches(actor, id, [branchId]);
      say(`توجيه: ${code} ← فرع ${branchCode}`);
    } else {
      const codes = [...branches].filter(([, b]) => current.includes(b)).map(([c]) => c);
      say(`توجيه موجود، تُرك: ${code} ← ${codes.join('، ')}`);
    }
  }

  // 5. The bot's API key, named by its prefix (never guessed): the three scopes added to what it
  // holds, and pickup and door delivery off. Without the prefix, or when the key does not cover
  // the origins' branches, nothing about any key changes.
  const active = (await apiClients.list()).filter((k) => k.isActive);
  const key = options.keyPrefix ? active.find((k) => k.keyPrefix === options.keyPrefix) : undefined;
  const needed = [...new Set(Object.values(SOFT_LAUNCH_ORIGINS))];
  if (!key) {
    say(
      `المفتاح: لم يتغير أي مفتاح. ${
        options.keyPrefix ? `لا مفتاح نشط بالبادئة ${options.keyPrefix}. ` : ''
      }المفاتيح النشطة: ${
        active
          .map((k) => `«${k.name}» ${k.keyPrefix} (فروع ${k.branchCodes.join('، ')})`)
          .join('؛ ') || 'لا شيء'
      }. شغّل مرة تانية مع SOFT_LAUNCH_KEY_PREFIX=بادئة مفتاح بوت الحجز`,
    );
  } else if (needed.some((b) => !key.branchCodes.includes(b))) {
    say(
      `المفتاح «${key.name}» لم يتغير: فروعه ${key.branchCodes.join('، ')} لا تشمل ` +
        `${needed.filter((b) => !key.branchCodes.includes(b)).join('، ')}`,
    );
  } else {
    const missing = SOFT_LAUNCH_SCOPES.filter((s) => !key.scopes.includes(s));
    if (missing.length > 0) {
      await apiClients.setScopes(actor, key.id, [...key.scopes, ...missing]);
      say(`المفتاح «${key.name}» (${key.keyPrefix}): أُضيفت ${missing.join('، ')}`);
    } else {
      say(`المفتاح «${key.name}» (${key.keyPrefix}): الصلاحيات التلاتة موجودة`);
    }
    // No pickup from home and no door delivery at the soft launch: the bot offers neither.
    if (key.services.length > 0) {
      await apiClients.setServices(actor, key.id, []);
      say(`المفتاح «${key.name}»: أُوقفت خدمات ${key.services.join('، ')}`);
    } else {
      say(`المفتاح «${key.name}»: الاستلام والتوصيل موقوفين`);
    }
  }
  return report;
}

async function ensurePlace(
  { prisma, masterData }: SoftLaunchDeps,
  actor: AuthUser,
  spec: PlaceSpec,
  say: (line: string) => void,
): Promise<string | null> {
  let place = await prisma.location.findUnique({
    where: { code: spec.code },
    include: { aliases: true },
  });
  if (!place) {
    const wanted = new Set([spec.nameAr, spec.nameEn, ...spec.aliases].map(fold));
    const candidates = await prisma.location.findMany({
      where: { countryCode: spec.countryCode, kind: { not: 'COUNTRY' } },
      include: { aliases: true },
    });
    const hits = candidates.filter((l) =>
      [l.nameAr, l.nameEn, ...l.aliases.map((a) => a.alias)].some((n) => wanted.has(fold(n))),
    );
    if (hits.length > 1) {
      say(
        `${spec.nameAr}: أكثر من مكان بنفس الاسم (${hits.map((h) => h.code).join('، ')})، لم يُستعمل`,
      );
      return null;
    }
    place = hits[0] ?? null;
    if (place) say(`${spec.nameAr}: موجود بالرمز ${place.code}`);
  }
  if (!place) {
    const created = await masterData.createLocation(actor, {
      code: spec.code,
      kind: spec.kind,
      nameEn: spec.nameEn,
      nameAr: spec.nameAr,
      countryCode: spec.countryCode,
    });
    place = await prisma.location.findUniqueOrThrow({
      where: { id: created.id },
      include: { aliases: true },
    });
    say(`مكان جديد: ${spec.nameAr} (${spec.code})`);
  } else if (!place.isActive) {
    await masterData.updateLocation(actor, place.id, { isActive: true });
    say(`مكان مُفعّل: ${place.nameAr} (${place.code})`);
  }
  const held = place.aliases.map((a) => a.alias);
  const lower = new Set([place.nameAr, place.nameEn, ...held].map((n) => n.toLowerCase()));
  const added = spec.aliases.filter((a) => !lower.has(a.toLowerCase()));
  if (added.length > 0) {
    await masterData.setLocationAliases(actor, place.id, [...held, ...added]);
    say(`أسماء تانية لـ ${place.nameAr}: ${added.join('، ')}`);
  }
  return place.id;
}
