import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';
import type { Prisma, Trip } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * Trips a user may see: those of their branches (AGENTS.md rule 2). A Driver (annex A, own trips)
 * sees only the trips assigned to the driver record linked to their user.
 */
export function tripScope(user: AuthUser): Prisma.TripWhereInput {
  if (limitedToOwnTrips(user, 'transport_trips')) {
    return { ...branchScope(user), driver: { userId: user.id } };
  }
  return branchScope(user);
}

/** True when the user works on trips only as their driver (annex A, own trips). */
export function isDriverOnly(user: AuthUser): boolean {
  return limitedToOwnTrips(user, 'transport_trips');
}

/** Planning trips and paying their costs is office work: a Driver records progress and PODs. */
export function forbidDriverOnly(user: AuthUser, what: string): void {
  if (isDriverOnly(user)) throw new ForbiddenException(`A driver cannot ${what}`);
}

/**
 * Locks the trip row for a change and returns it as it is under the lock. Every change to a trip
 * (status, shipments, expenses) takes this lock first and the shipment locks after it, in
 * shipment id order, so two trip changes never wait on each other in opposite orders.
 */
export async function lockTrip(tx: Tx, id: string): Promise<Trip> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "trips" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('Trip not found');
  return tx.trip.findUniqueOrThrow({ where: { id } });
}

/**
 * Share-locks the trip row for a write that depends on the trip without changing it (a POD
 * naming it) and returns its status and driver's user as they are under the lock. Same order as
 * lockTrip: the trip first, the shipment after.
 */
export async function lockTripShared(
  tx: Tx,
  id: string,
): Promise<{ status: Trip['status']; driverUserId: string | null }> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "trips" WHERE "id" = ${id}::uuid FOR SHARE`;
  if (rows.length === 0) throw new NotFoundException('Trip not found');
  const trip = await tx.trip.findUniqueOrThrow({
    where: { id },
    select: { status: true, driver: { select: { userId: true } } },
  });
  return { status: trip.status, driverUserId: trip.driver?.userId ?? null };
}
