import type { AuthUser } from '../auth/auth-user.js';
import {
  type CardCategory,
  type CardSpec,
  SOFT_LAUNCH_DESTINATIONS,
  SOFT_LAUNCH_ORIGINS,
  SOFT_LAUNCH_PLACES,
  SOFT_LAUNCH_PRICES,
  type SoftLaunchDeps,
  ensurePlace,
  ensureRateCards,
} from './soft-launch.js';

/**
 * Trial prices (owner's request, 2026-11-02): every route of the booking bot (5 origins, 4
 * destinations) gets an approved card in every price category and for every container type, so staff and the bot can be tried
 * end to end. They fill only what the soft-launch prices (soft-launch.ts) leave empty: the
 * soft-launch cards are NOLON's real prices and are never touched, and a route and category that
 * already has any card of its own (staff's or the soft launch's) is left as it is and reported.
 *
 * The numbers are NOT from NOLON's sales: they are derived from the soft-launch prices (decisions
 * file v6, section ط) and every card says so in its note, which staff see on the rates screen. When
 * the real price arrives, staff cancel the trial card and enter theirs.
 *
 * Safe to run again: the same rules as the soft-launch script (nothing deleted, an approved card
 * never changed, a card with other terms on the route never approved).
 */

/** Shown on every trial card: where the price comes from. */
export const TRIAL_NOTES =
  'سعر تجريبي للتجربة فقط، ليس سعر بيع معتمد من المبيعات. محسوب من أسعار السوفت لانش ' +
  '(ملف قرارات التشغيل، القسم ط). المبيعات تلغي البطاقة وتدخل السعر الحقيقي عند وصوله.';

/** The categories trial cards are entered in (all six seeded or soft-launch categories). */
export const TRIAL_CATEGORIES = [
  'BARREL',
  'SUITCASE',
  'CARTON50',
  'CARTON',
  'PALLET',
  'SPECIAL',
] as const;

/** The container types trial full-container cards are entered for («OTHER» is not priced). */
export const TRIAL_CONTAINER_TYPES = ['20GP', '40GP', '40HC'] as const;

/**
 * Trial prices by origin, in the currency of that origin's existing cards (USD where it has none).
 * Units are the category's: BARREL per barrel, SUITCASE and CARTON50 per piece, CARTON and PALLET
 * per CBM, SPECIAL per shipment, containers per container. How each number was derived: decisions file v6, section ط.
 */
export const TRIAL_PRICES: readonly {
  origins: readonly string[];
  currency: string;
  transitDays: number;
  /** Categories the soft launch already prices for these origins are left out. */
  prices: Readonly<Partial<Record<(typeof TRIAL_CATEGORIES)[number], string>>>;
  /** Full containers (FCL), per container, by container type. */
  containers: Readonly<Record<(typeof TRIAL_CONTAINER_TYPES)[number], string>>;
}[] = [
  {
    origins: ['SAJED'],
    currency: 'SAR',
    transitDays: 25,
    prices: {
      CARTON: '1000',
      PALLET: '800',
      SPECIAL: '3000',
    },
    containers: { '20GP': '9000', '40GP': '14000', '40HC': '15000' },
  },
  {
    origins: ['AEDXB', 'AESHJ'],
    currency: 'AED',
    transitDays: 25,
    prices: {
      CARTON: '1000',
      PALLET: '800',
      SPECIAL: '3000',
    },
    containers: { '20GP': '9000', '40GP': '14000', '40HC': '15000' },
  },
  {
    origins: ['EGCAI'],
    currency: 'USD',
    transitDays: 25,
    prices: {
      BARREL: '80',
      SUITCASE: '40',
      CARTON50: '40',
      CARTON: '270',
      PALLET: '220',
      SPECIAL: '800',
    },
    containers: { '20GP': '2500', '40GP': '3800', '40HC': '4000' },
  },
  {
    origins: ['CNCAN'],
    currency: 'USD',
    transitDays: 45,
    prices: {
      BARREL: '120',
      SUITCASE: '60',
      CARTON50: '60',
      CARTON: '400',
      PALLET: '330',
      SPECIAL: '1200',
    },
    containers: { '20GP': '3500', '40GP': '5500', '40HC': '5800' },
  },
];

/** Whether the soft launch prices this origin and category (then no trial card is made). */
function softLaunchPriced(origin: string, category: string): boolean {
  return SOFT_LAUNCH_PRICES.some((p) => p.origins.includes(origin) && category in p.prices);
}

/**
 * The trial cards: every route and category the soft-launch prices leave empty, then a
 * full-container card per container type on every route.
 */
export function trialCards(): CardSpec[] {
  return TRIAL_PRICES.flatMap(({ origins, currency, transitDays, prices, containers }) =>
    origins.flatMap((origin) =>
      SOFT_LAUNCH_DESTINATIONS.flatMap((destination) =>
        Object.entries(prices)
          .filter(([category]) => !softLaunchPriced(origin, category))
          .map(([category, price]) => ({
            branchCode: SOFT_LAUNCH_ORIGINS[origin] ?? '',
            origin,
            destination,
            category,
            mode: destination === 'SDPZU' ? ('SEA' as const) : ('SEA_ROAD' as const),
            price,
            currency,
            transitDays,
            notes: TRIAL_NOTES,
          }))
          .concat(
            TRIAL_CONTAINER_TYPES.map((type) => ({
              branchCode: SOFT_LAUNCH_ORIGINS[origin] ?? '',
              origin,
              destination,
              category: 'CONTAINER',
              containerTypeCode: type,
              mode: destination === 'SDPZU' ? ('SEA' as const) : ('SEA_ROAD' as const),
              price: containers[type],
              currency,
              transitDays,
              notes: TRIAL_NOTES,
            })),
          ),
      ),
    ),
  );
}

/**
 * Applies the trial prices. The places are found or entered as the soft-launch script does; a
 * category missing or inactive is reported and its cards skipped (staff decide, the script does
 * not turn a category back on). Returns what it did and found, one line each.
 */
export async function applyTrialPrices(
  deps: SoftLaunchDeps,
  actor: AuthUser,
  options: { today: string },
): Promise<string[]> {
  const report: string[] = [];
  const say = (line: string) => report.push(line);
  const { prisma } = deps;

  const branches = new Map(
    (await prisma.branch.findMany({ select: { id: true, code: true } })).map((b) => [b.code, b.id]),
  );
  const placeIds = new Map<string, string>();
  for (const spec of SOFT_LAUNCH_PLACES) {
    const id = await ensurePlace(deps, actor, spec, say);
    if (id) placeIds.set(spec.code, id);
  }
  const categories = new Map<string, CardCategory>();
  const rows = await prisma.priceCategory.findMany({
    where: { code: { in: [...TRIAL_CATEGORIES] } },
  });
  for (const code of TRIAL_CATEGORIES) {
    const row = rows.find((r) => r.code === code);
    if (!row || !row.isActive) {
      say(`فئة ${row ? 'موقوفة' : 'ناقصة'}: ${code}، بطاقاتها التجريبية لم تُدخل`);
      continue;
    }
    categories.set(code, { cargoType: row.cargoType, unit: row.defaultUnit });
  }
  const containerTypes = new Set(
    (
      await prisma.containerType.findMany({
        where: { code: { in: [...TRIAL_CONTAINER_TYPES] }, isActive: true },
        select: { code: true },
      })
    ).map((c) => c.code),
  );
  for (const code of TRIAL_CONTAINER_TYPES) {
    if (!containerTypes.has(code)) say(`نوع حاوية ناقص أو موقوف: ${code}، بطاقاته لم تُدخل`);
  }
  await ensureRateCards(deps, actor, trialCards(), {
    today: options.today,
    branches,
    placeIds,
    categories,
    containerTypes,
    say,
  });
  return report;
}
