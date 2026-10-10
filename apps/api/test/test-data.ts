import { randomInt } from 'node:crypto';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * A customer phone no other test, nor an earlier run, holds: a phone is unique per branch, and
 * customers with posted entries outlive their run.
 */
export function uniquePhone(): string {
  return `+2496${String(randomInt(10_000_000, 99_999_999))}`;
}

/** Removes everything the test users created, so the users themselves can be deleted. */
export async function deleteCommercialTestData(prisma: PrismaService): Promise<void> {
  const createdBy = { createdBy: { email: { startsWith: 'it-' } } };
  // Confirmed bookings have shipments (and maybe documents, warehouse movements and customs
  // records), which restrict deleting them.
  // Trips and PODs (inland transport); fleet records of the tests are named ZZ...
  await prisma.podPhoto.deleteMany({ where: { pod: { shipment: createdBy } } });
  await prisma.proofOfDelivery.deleteMany({ where: { shipment: createdBy } });
  await prisma.tripShipment.deleteMany({
    where: { OR: [{ shipment: createdBy }, { trip: createdBy }] },
  });
  await prisma.trip.deleteMany({ where: createdBy });
  await prisma.vehicle.deleteMany({ where: { plateNumber: { startsWith: 'ZZ' } } });
  await prisma.driver.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
  await prisma.carrier.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
  await prisma.grnDraft.deleteMany({ where: { shipment: createdBy } });
  await prisma.warehouseMovementPhoto.deleteMany({ where: { movement: { shipment: createdBy } } });
  await prisma.warehouseMovement.deleteMany({ where: { shipment: createdBy } });
  await prisma.customsFee.deleteMany({ where: { shipment: createdBy } });
  await prisma.customsClearance.deleteMany({ where: { shipment: createdBy } });
  await prisma.document.deleteMany({ where: { shipment: createdBy } });
  await prisma.shipment.deleteMany({ where: createdBy });
  await prisma.booking.deleteMany({ where: createdBy });
  await prisma.quotation.deleteMany({ where: createdBy });
  await prisma.rateCard.deleteMany({ where: createdBy });
  const customers = { customer: createdBy };
  await prisma.customerContact.deleteMany({ where: customers });
  await prisma.party.deleteMany({ where: customers });
  await prisma.customer.deleteMany({ where: createdBy });
  await prisma.location.deleteMany({ where: { code: { startsWith: 'ZZ' } } });
  const testWarehouses = { warehouse: { code: { startsWith: 'ZZ' } } };
  await prisma.storageLocation.deleteMany({ where: testWarehouses });
  await prisma.warehouse.deleteMany({ where: { code: { startsWith: 'ZZ' } } });
}

/**
 * Waits until `count` sessions (default one) are blocked on a row lock: the requests under test
 * reached the lock.
 */
export async function waitForLockWaiter(prisma: PrismaService, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS "n" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`;
    if ((rows[0]?.n ?? 0n) >= BigInt(count)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fewer than ${count} requests waited on the lock`);
}
