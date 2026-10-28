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

/** Same members, whatever the order. */
function sameSet(a: Iterable<string>, b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((x) => left.has(x));
}

/**
 * The user's outlets (id to branch) as they are now, locked until the transaction ends: null for
 * a user not limited by outlet.
 *
 * The request decided its scope from the sign-in snapshot (`allowedBranchIds`, `allowedOutletIds`:
 * which records it may see, which branch it writes to, whose numbers a refusal may name). That
 * snapshot can be stale by the time a write commits: the outlet deactivated, the user moved to
 * another outlet or branch, or out of the role, before or while this request runs. So every write
 * by Outlet Staff calls this first, and it refuses the request (403) unless the role, branches and
 * outlets read now under lock are exactly the snapshot's. The request then never mixes a stale
 * scope with the current one, and the user retries under their new scope.
 *
 * Each step share-locks the rows it reads, so an administrator's change (user update deletes
 * roles, then branches, then outlets; partner update locks the partner) waits for this write, or
 * this write waits for the change and then sees it. The locks are taken in the user update's own
 * order and before any other lock of the write, so the two cannot deadlock.
 */
export async function lockOutletsInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
): Promise<ReadonlyMap<string, string> | null> {
  if (!outletLimited(user)) return null;
  const changed = () => new ForbiddenException('Your access changed: reload and try again');
  const role = await tx.$queryRaw<{ role: string }[]>`
    SELECT "role"::text AS "role" FROM "user_roles"
    WHERE "user_id" = ${user.id}::uuid AND "role" = 'OUTLET_STAFF' FOR SHARE`;
  if (role.length === 0) throw changed();
  const branches = await tx.$queryRaw<{ branch_id: string }[]>`
    SELECT "branch_id" FROM "user_branches" WHERE "user_id" = ${user.id}::uuid FOR SHARE`;
  if (
    !sameSet(
      branches.map((b) => b.branch_id),
      user.allowedBranchIds,
    )
  ) {
    throw changed();
  }
  const links = await tx.$queryRaw<{ partner_id: string }[]>`
    SELECT "partner_id" FROM "user_partners" WHERE "user_id" = ${user.id}::uuid FOR SHARE`;
  const outlets =
    branches.length === 0 || links.length === 0
      ? []
      : await tx.$queryRaw<{ id: string; branch_id: string }[]>`
    SELECT "id", "branch_id" FROM "partners"
    WHERE "id" IN (${Prisma.join(links.map((l) => Prisma.sql`${l.partner_id}::uuid`))})
      AND "branch_id" IN (${Prisma.join(branches.map((b) => Prisma.sql`${b.branch_id}::uuid`))})
      AND "kind" = 'SALES_OUTLET' AND "is_active"
    FOR SHARE`;
  if (
    !sameSet(
      outlets.map((o) => o.id),
      user.allowedOutletIds ?? [],
    )
  ) {
    throw changed();
  }
  return new Map(outlets.map((o) => [o.id, o.branch_id]));
}

/**
 * The outlet a record an Outlet Staff user creates in `branchId` is sold through: their only
 * outlet, checked and locked inside the write's transaction (lockOutletsInTx), and of that branch.
 * Null for every other user (their screens do not set an outlet yet, plan PR-3). 403 when the user
 * does not have exactly one active outlet of that branch (nothing is written).
 */
export async function outletForWriteInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  branchId: string,
): Promise<string | null> {
  const outlets = await lockOutletsInTx(tx, user);
  if (outlets === null) return null;
  const [only, ...rest] = [...outlets];
  if (!only || rest.length > 0 || only[1] !== branchId) {
    throw new ForbiddenException('No single sales outlet to record');
  }
  return only[0];
}

/**
 * For a write by Outlet Staff to an existing record whose outlet never changes (a shipment): the
 * record's outlet must be one of the user's outlets, checked and locked inside the write's
 * transaction (lockOutletsInTx: 403 when the user's access changed). Otherwise the record is of
 * another outlet: 404 with `notFound`. A no-op for a user not limited by outlet. A record another
 * user can move to another outlet goes through lockRecordOutletInTx instead.
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

/** Records another user can move to another outlet (plan PR-3), with the column naming it. */
const MOVABLE_OUTLET_COLUMN = {
  quotations: 'sales_outlet_id',
  bookings: 'sales_outlet_id',
  customers: 'acquired_via_outlet_id',
} as const;

/**
 * For any write to a record whose outlet can change after the request read it: the record's row
 * lock (`lock`, the one the write takes anyway), and its outlet as it is now, under that lock. For
 * Outlet Staff the user's outlets are checked and locked first (lockOutletsInTx), then the record
 * must be of one of them, or 404 with `notFound`: a record moved to another outlet meanwhile is
 * never written, nor moved back, from a read made before the move. 404 too when the row is gone.
 * The caller writes, and keeps or checks the outlet, from the value returned, never from its read.
 */
export async function lockRecordOutletInTx(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  table: keyof typeof MOVABLE_OUTLET_COLUMN,
  id: string,
  notFound: string,
  lock: 'UPDATE' | 'NO KEY UPDATE' | 'SHARE',
): Promise<string | null> {
  const outlets = await lockOutletsInTx(tx, user);
  const rows = await tx.$queryRaw<{ outlet_id: string | null }[]>(
    Prisma.sql`SELECT ${Prisma.raw(`"${MOVABLE_OUTLET_COLUMN[table]}"`)} AS "outlet_id"
      FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid FOR ${Prisma.raw(lock)}`,
  );
  const row = rows[0];
  if (!row || (outlets !== null && (row.outlet_id === null || !outlets.has(row.outlet_id)))) {
    throw new NotFoundException(notFound);
  }
  return row.outlet_id;
}
