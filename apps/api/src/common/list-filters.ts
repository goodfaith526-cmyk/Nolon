import { z } from 'zod';
import type { PrismaService } from '../prisma/prisma.service.js';
import { toDbDate, todayIn } from './dates.js';
import { dateString } from './validation.js';

/**
 * Filters shared by the list endpoints (and the staff assistant that reads them): periods, flags
 * and the branch-local days of timestamps. Parsing lives here; the services build their `where`
 * from the helpers below, so every list reads a period the same way.
 */

/** `from` / `to` query fields (YYYY-MM-DD, both included). */
export const periodFields = { from: dateString.optional(), to: dateString.optional() };

/** `originLocationId` / `destinationLocationId` of a list of routed documents. */
export const routeFields = {
  originLocationId: z.uuid().optional(),
  destinationLocationId: z.uuid().optional(),
};

/** A list's route filter, for documents with origin and destination locations. */
export interface RouteFilters {
  originLocationId?: string;
  destinationLocationId?: string;
}

/** Prisma `where` fragment for `routeFields`: only the ends that were given. */
export function routeWhere(f: RouteFilters): RouteFilters {
  return {
    ...(f.originLocationId ? { originLocationId: f.originLocationId } : {}),
    ...(f.destinationLocationId ? { destinationLocationId: f.destinationLocationId } : {}),
  };
}

/** `branchId` (one of the user's; checked by the service) and `from` / `to` of a list. */
export const branchPeriodFields = { branchId: z.uuid().optional(), ...periodFields };

/** A `true` / `false` query flag; absent is false. */
export const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

/** A `true` / `false` query filter; absent is no filter (undefined). */
export const optionalFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

/**
 * zod check that each `[from, to]` pair of date fields is in order (a 400 on the `to` field).
 * Fields left out are not compared.
 */
export function periodsInOrder<K extends string>(...pairs: readonly (readonly [K, K])[]) {
  return (q: Partial<Record<K, string>>, ctx: z.RefinementCtx): void => {
    for (const [from, to] of pairs) {
      const start = q[from];
      const end = q[to];
      if (start !== undefined && end !== undefined && start > end) {
        ctx.addIssue({ code: 'custom', message: `${from} is after ${to}`, path: [to] });
      }
    }
  };
}

/** zod check that `from` is not after `to`. */
export const periodInOrder = periodsInOrder(['from', 'to']);

/** Prisma filter on a DATE column: from `from` to `to`, both included; undefined when neither. */
export function dateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (from === undefined && to === undefined) return undefined;
  return {
    ...(from !== undefined ? { gte: toDbDate(from) } : {}),
    ...(to !== undefined ? { lte: toDbDate(to) } : {}),
  };
}

/** The YYYY-MM-DD date after `date`. */
export function nextDay(date: string): string {
  const d = toDbDate(date);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Milliseconds a time zone's wall clock is ahead of UTC at an instant. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - (instant - (((instant % 1000) + 1000) % 1000));
}

/** The instant a calendar day starts (local midnight) in a time zone. */
export function startOfDayIn(date: string, timeZone: string): Date {
  const midnightUtc = toDbDate(date).getTime();
  const first = midnightUtc - zoneOffset(midnightUtc, timeZone);
  // Again at the first guess, in case the offset changes in between (daylight saving).
  return new Date(midnightUtc - zoneOffset(first, timeZone));
}

/** A branch and its time zone, for branch-local days. */
export interface BranchZone {
  id: string;
  timezone: string;
}

/** Every branch's time zone (a row's local day is its own branch's, as in the reports). */
export function branchZones(prisma: PrismaService): Promise<BranchZone[]> {
  return prisma.branch.findMany({ select: { id: true, timezone: true } });
}

type InstantRange = { gte?: Date; lt?: Date };

/**
 * Prisma filter on a timestamp column: the row's local day, in its branch's time zone, is from
 * `from` to `to` (both included), like the reports' `(column AT TIME ZONE timezone)::date`.
 * Undefined when neither is given. Returned as `{ OR }`: put it under the caller's `AND`.
 */
export function localDayRange<K extends string>(
  zones: readonly BranchZone[],
  column: K,
  from?: string,
  to?: string,
): { OR: ({ branchId: string } & Record<K, InstantRange>)[] } | undefined {
  if (from === undefined && to === undefined) return undefined;
  return {
    OR: zones.map((zone) => {
      const range: InstantRange = {
        ...(from !== undefined ? { gte: startOfDayIn(from, zone.timezone) } : {}),
        ...(to !== undefined ? { lt: startOfDayIn(nextDay(to), zone.timezone) } : {}),
      };
      return { branchId: zone.id, [column]: range } as { branchId: string } & Record<
        K,
        InstantRange
      >;
    }),
  };
}

/**
 * `localDayRange` with every branch's time zone, read only when a period is given. Undefined
 * (no filter) otherwise.
 */
export async function localDayFilter<K extends string>(
  prisma: PrismaService,
  column: K,
  from?: string,
  to?: string,
): Promise<ReturnType<typeof localDayRange<K>>> {
  if (from === undefined && to === undefined) return undefined;
  return localDayRange(await branchZones(prisma), column, from, to);
}

/**
 * Prisma filter on a DATE column: before today in the row's branch time zone (overdue). Returned
 * as `{ OR }`: put it under the caller's `AND`.
 */
export function beforeLocalToday<K extends string>(
  zones: readonly BranchZone[],
  column: K,
  now: Date = new Date(),
): { OR: ({ branchId: string } & Record<K, { lt: Date }>)[] } {
  return {
    OR: zones.map(
      (zone) =>
        ({ branchId: zone.id, [column]: { lt: toDbDate(todayIn(zone.timezone, now)) } }) as {
          branchId: string;
        } & Record<K, { lt: Date }>,
    ),
  };
}
