import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
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
 * The user's outlets as they are now, locked until the transaction ends: null for a user not
 * limited by outlet. The sign-in snapshot (`allowedOutletIds`) can be stale by the time a write
 * commits (the outlet deactivated, the user moved to another outlet or out of the role), so every
 * write by Outlet Staff calls this first and decides on what it returns.
 *
 * Each step share-locks the rows it reads, so an administrator's change (user update deletes
 * roles, then branches, then outlets; partner update locks the partner) waits for this write, or
 * this write waits for the change and then sees it. The locks are taken in the user update's own
 * order and before any other lock of the write, so the two cannot deadlock.
 */
export async function lockOutletsInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
): Promise<ReadonlySet<string> | null> {
  if (!outletLimited(user)) return null;
  const role = await tx.$queryRaw<{ role: string }[]>`
    SELECT "role"::text AS "role" FROM "user_roles"
    WHERE "user_id" = ${user.id}::uuid AND "role" = 'OUTLET_STAFF' FOR SHARE`;
  if (role.length === 0) return new Set();
  const branches = await tx.$queryRaw<{ branch_id: string }[]>`
    SELECT "branch_id" FROM "user_branches" WHERE "user_id" = ${user.id}::uuid FOR SHARE`;
  const links = await tx.$queryRaw<{ partner_id: string }[]>`
    SELECT "partner_id" FROM "user_partners" WHERE "user_id" = ${user.id}::uuid FOR SHARE`;
  if (branches.length === 0 || links.length === 0) return new Set();
  const outlets = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "partners"
    WHERE "id" IN (${Prisma.join(links.map((l) => Prisma.sql`${l.partner_id}::uuid`))})
      AND "branch_id" IN (${Prisma.join(branches.map((b) => Prisma.sql`${b.branch_id}::uuid`))})
      AND "kind" = 'SALES_OUTLET' AND "is_active"
    FOR SHARE`;
  return new Set(outlets.map((o) => o.id));
}

/**
 * The outlet a record an Outlet Staff user creates is sold through: their only outlet as it is
 * now, checked and locked inside the write's transaction (never the sign-in snapshot). Null for every other user (their screens do not set an outlet yet, plan
 * PR-3). 403 when the user does not have exactly one active outlet now (nothing is written).
 */
export async function outletForWriteInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
): Promise<string | null> {
  const outlets = await lockOutletsInTx(tx, user);
  if (outlets === null) return null;
  const [only, ...rest] = [...outlets];
  if (!only || rest.length > 0) throw new ForbiddenException('No single sales outlet to record');
  return only;
}

/**
 * For a write by Outlet Staff to an existing record: the record's outlet must still be one of the
 * user's active outlets, checked and locked inside the write's transaction. Otherwise the record is
 * out of the user's scope now: 404 with `notFound`, as for a record of another outlet. A no-op for
 * a user not limited by outlet.
 */
export async function assertOutletInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  recordOutletId: string | null,
  notFound: string,
): Promise<void> {
  const outlets = await lockOutletsInTx(tx, user);
  if (outlets !== null && (recordOutletId === null || !outlets.has(recordOutletId))) {
    throw new NotFoundException(notFound);
  }
}
