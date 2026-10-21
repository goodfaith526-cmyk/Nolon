import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from './auth-user.js';

/**
 * Outlet isolation (business model plan 4.2), the second layer on top of the branch scope: an
 * Outlet Staff user reads and writes only the customers acquired through their outlets and the
 * quotations, bookings, shipments and documents sold through them. Every other user is not
 * limited by outlet (the fragments below are empty for them).
 *
 * The guard refuses an Outlet Staff user on every route not marked @OutletScoped(), so only the
 * routes built on these fragments are open to them.
 */

/** True when the user sees only the records of their own outlets. */
export function outletLimited(user: AuthUser): boolean {
  return user.allowedOutletIds !== undefined && user.allowedOutletIds !== null;
}

function outletIds(user: AuthUser): string[] {
  return [...(user.allowedOutletIds ?? [])];
}

/** Prisma `where` fragment for customers: `{ acquiredViaOutletId: { in } }` for Outlet Staff. */
export function customerOutletScope(user: AuthUser): { acquiredViaOutletId?: { in: string[] } } {
  return outletLimited(user) ? { acquiredViaOutletId: { in: outletIds(user) } } : {};
}

/** Prisma `where` fragment for quotations, bookings and shipments, on `salesOutletId`. */
export function salesOutletScope(user: AuthUser): { salesOutletId?: { in: string[] } } {
  return outletLimited(user) ? { salesOutletId: { in: outletIds(user) } } : {};
}

/**
 * Prisma `where` fragment for partners: Outlet Staff see only their own outlets. Under `AND`, so
 * it never replaces the caller's own `id` condition when spread next to it.
 */
export function partnerOutletScope(user: AuthUser): { AND?: { id: { in: string[] } }[] } {
  return outletLimited(user) ? { AND: [{ id: { in: outletIds(user) } }] } : {};
}

/**
 * The outlet a record an Outlet Staff user creates is sold through: their only outlet. Null for
 * every other user (their screens do not set an outlet yet, plan PR-3). A user of several outlets
 * cannot create until the screens let them choose one (403, nothing is written).
 */
export function outletForWrite(user: AuthUser): string | null {
  if (!outletLimited(user)) return null;
  const ids = outletIds(user);
  if (ids.length !== 1 || !ids[0]) throw new ForbiddenException('No single sales outlet to record');
  return ids[0];
}
