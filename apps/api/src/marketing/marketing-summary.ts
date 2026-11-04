import { HttpException, HttpStatus } from '@nestjs/common';
import {
  type BookingStatus,
  type LoadType,
  type LocationDto,
  MARKETING_MAX_MONTHS,
  type MarketingMonthDto,
  type MarketingPriceDto,
  type MarketingRevenueDto,
  type MarketingRouteDto,
  type MarketingSummaryDto,
  type PriceCategoryDto,
} from '@nolon/shared';
import { type Decimal, toDecimalString } from '../common/money.js';

/** A booking count of the period (BookingReportsService.marketingMonthly). */
export interface BookingCountRow {
  month: string;
  originId: string;
  destinationId: string;
  category: string | null;
  fromRequest: boolean;
  status: BookingStatus;
  count: number;
}

/** A bot request count of the period (BookingRequestReportsService.marketingMonthly). */
export interface RequestCountRow {
  month: string;
  originId: string | null;
  destinationId: string | null;
  category: string | null;
  source: 'bot' | 'website';
  count: number;
}

/** A revenue sum of the period (BillingReportsService.marketingRevenue). */
export interface RevenueRow {
  month: string;
  originId: string;
  destinationId: string;
  currency: string;
  invoiced: Decimal;
  credited: Decimal;
}

function refuse(code: string, message: string): HttpException {
  return new HttpException({ message, code, statusCode: 400 }, HttpStatus.BAD_REQUEST);
}

/**
 * The months (YYYY-MM) from `from`'s to `to`'s, both valid YYYY-MM-DD days: 400 BAD_RANGE when
 * `to` is before `from`, 400 RANGE_TOO_LONG past MARKETING_MAX_MONTHS calendar months.
 */
export function periodMonths(from: string, to: string): string[] {
  if (to < from) throw refuse('BAD_RANGE', 'to must be on or after from');
  const index = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
  const first = index(from);
  const last = index(to);
  if (last - first + 1 > MARKETING_MAX_MONTHS) {
    throw refuse('RANGE_TOO_LONG', `The period covers at most ${MARKETING_MAX_MONTHS} months`);
  }
  const months: string[] = [];
  for (let i = first; i <= last; i++) {
    months.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  }
  return months;
}

/** Nulls last, then text order: stable output for the same data. */
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** The routes the prices cover, each with its load types and shipment types. */
export function routesOf(prices: readonly MarketingPriceDto[]): MarketingRouteDto[] {
  const routes = new Map<
    string,
    { route: MarketingRouteDto; loadTypes: Set<LoadType>; categories: Set<string> }
  >();
  for (const p of prices) {
    const key = `${p.originId}|${p.destinationId}|${p.mode}`;
    let entry = routes.get(key);
    if (!entry) {
      entry = {
        route: {
          originId: p.originId,
          destinationId: p.destinationId,
          mode: p.mode,
          loadTypes: [],
          categories: [],
        },
        loadTypes: new Set(),
        categories: new Set(),
      };
      routes.set(key, entry);
    }
    if (p.loadType !== null) entry.loadTypes.add(p.loadType);
    entry.categories.add(p.category);
  }
  return [...routes.values()].map(({ route, loadTypes, categories }) => ({
    ...route,
    loadTypes: [...loadTypes].sort(),
    categories: [...categories].sort(),
  }));
}

/**
 * One row per month, route and shipment type: the bots' requests by source, the bookings staff
 * entered without a request (source branch), and the bookings made by their status now.
 */
export function monthlyRows(
  requests: readonly RequestCountRow[],
  bookings: readonly BookingCountRow[],
): MarketingMonthDto[] {
  const rows = new Map<string, MarketingMonthDto>();
  const row = (
    month: string,
    originId: string | null,
    destinationId: string | null,
    category: string | null,
  ) => {
    const key = JSON.stringify([month, originId, destinationId, category]);
    let found = rows.get(key);
    if (!found) {
      found = {
        month,
        originId,
        destinationId,
        category,
        requests: { total: 0, bot: 0, website: 0, branch: 0 },
        bookings: { confirmed: 0, cancelled: 0 },
      };
      rows.set(key, found);
    }
    return found;
  };
  for (const r of requests) {
    const target = row(r.month, r.originId, r.destinationId, r.category);
    target.requests[r.source] += r.count;
    target.requests.total += r.count;
  }
  for (const b of bookings) {
    const target = row(b.month, b.originId, b.destinationId, b.category);
    if (!b.fromRequest) {
      target.requests.branch += b.count;
      target.requests.total += b.count;
    }
    if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') target.bookings.confirmed += b.count;
    if (b.status === 'CANCELLED') target.bookings.cancelled += b.count;
  }
  return [...rows.values()].sort(
    (a, b) =>
      compareNullable(a.month, b.month) ||
      compareNullable(a.originId, b.originId) ||
      compareNullable(a.destinationId, b.destinationId) ||
      compareNullable(a.category, b.category),
  );
}

export function revenueRows(rows: readonly RevenueRow[]): MarketingRevenueDto[] {
  return rows.map((r) => ({
    month: r.month,
    originId: r.originId,
    destinationId: r.destinationId,
    currency: r.currency,
    invoiced: toDecimalString(r.invoiced),
    credited: toDecimalString(r.credited),
    net: toDecimalString(r.invoiced.minus(r.credited)),
  }));
}

export interface SummaryInput {
  from: string;
  to: string;
  pricesOn: string;
  months: readonly string[];
  locations: readonly LocationDto[];
  categories: readonly PriceCategoryDto[];
  prices: MarketingPriceDto[];
  requests: readonly RequestCountRow[];
  bookings: readonly BookingCountRow[];
  newCustomers: ReadonlyMap<string, number>;
  /** Null: the key may not read revenue, and the field is left out. */
  revenue: readonly RevenueRow[] | null;
}

/** The summary from its parts; the places and types are the ones it names. */
export function buildSummary(input: SummaryInput): MarketingSummaryDto {
  const monthly = monthlyRows(input.requests, input.bookings);
  const revenue = input.revenue === null ? null : revenueRows(input.revenue);
  const routes = routesOf(input.prices);
  const placeIds = new Set<string>();
  const categoryCodes = new Set<string>();
  for (const r of [...input.prices, ...monthly, ...(revenue ?? [])]) {
    if (r.originId !== null) placeIds.add(r.originId);
    if (r.destinationId !== null) placeIds.add(r.destinationId);
  }
  for (const r of [...input.prices, ...monthly]) {
    if (r.category !== null) categoryCodes.add(r.category);
  }
  return {
    from: input.from,
    to: input.to,
    pricesOn: input.pricesOn,
    places: input.locations
      .filter((l) => placeIds.has(l.id))
      .map((l) => ({
        id: l.id,
        code: l.code,
        kind: l.kind,
        nameAr: l.nameAr,
        nameEn: l.nameEn,
        countryCode: l.countryCode,
      })),
    categories: input.categories
      .filter((c) => categoryCodes.has(c.code))
      .map((c) => ({ code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, unit: c.defaultUnit })),
    routes,
    prices: input.prices,
    monthly,
    newCustomers: input.months.map((month) => ({
      month,
      count: input.newCustomers.get(month) ?? 0,
    })),
    ...(revenue === null ? {} : { revenue }),
  };
}
