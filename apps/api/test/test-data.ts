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
  // Cancellations are insert-only (a trigger refuses DELETE). Test data only: the test database
  // role is a superuser, and replica mode skips that trigger for this transaction.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.podCancellation.deleteMany({ where: { pod: { shipment: createdBy } } });
    await tx.shipmentCargoCorrection.deleteMany({ where: { shipment: createdBy } });
  });
  await prisma.podPhoto.deleteMany({ where: { pod: { shipment: createdBy } } });
  await prisma.proofOfDelivery.deleteMany({ where: { shipment: createdBy } });
  // Trip drafts are created by the assistant's agent-it- users, for it- shipments (or none yet).
  await prisma.tripDraft.deleteMany({
    where: {
      OR: [
        { shipments: { some: { shipment: createdBy } } },
        { trip: createdBy },
        { createdBy: { email: { startsWith: 'agent-it-' } } },
      ],
    },
  });
  await prisma.tripShipment.deleteMany({
    where: { OR: [{ shipment: createdBy }, { trip: createdBy }] },
  });
  await prisma.trip.deleteMany({ where: createdBy });
  await prisma.vehicle.deleteMany({ where: { plateNumber: { startsWith: 'ZZ' } } });
  await prisma.driver.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
  await prisma.carrier.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
  await prisma.grnDraft.deleteMany({ where: { shipment: createdBy } });
  await prisma.goodsReleaseDraft.deleteMany({ where: { shipment: createdBy } });
  await prisma.shipmentStatusDraft.deleteMany({ where: { shipment: createdBy } });
  await prisma.warehouseMovementPhoto.deleteMany({ where: { movement: { shipment: createdBy } } });
  // Cancellations are insert-only (a trigger refuses DELETE). Test data only: the test database
  // role is a superuser, and replica mode skips that trigger for this one statement's transaction.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.warehouseMovementCancellation.deleteMany({
      where: { movement: { shipment: createdBy } },
    });
  });
  await prisma.warehouseMovement.deleteMany({ where: { shipment: createdBy } });
  await prisma.customsFee.deleteMany({ where: { shipment: createdBy } });
  await prisma.customsClearance.deleteMany({ where: { shipment: createdBy } });
  await prisma.document.deleteMany({ where: { shipment: createdBy } });
  await prisma.shipment.deleteMany({ where: createdBy });
  // Entry drafts are created by the assistant's agent-it- users, for it- customers. A booking
  // for a new customer goes before the customer draft it names and the booking it created.
  await prisma.newCustomerBookingDraft.deleteMany({
    where: { createdBy: { email: { startsWith: 'agent-it-' } } },
  });
  await prisma.customerDraft.deleteMany({
    where: { createdBy: { email: { startsWith: 'agent-it-' } } },
  });
  // A quotation for a new customer goes before the customer and the quotation it created.
  await prisma.newCustomerQuotationDraft.deleteMany({
    where: { createdBy: { email: { startsWith: 'agent-it-' } } },
  });
  await prisma.bookingDraft.deleteMany({ where: { customer: createdBy } });
  await prisma.quotationDraft.deleteMany({ where: { customer: createdBy } });
  // Approved from the assistant's chat, a booking or quotation is created by the agent-it- user.
  const createdOrForTestCustomer = { OR: [createdBy, { customer: createdBy }] };
  await prisma.booking.deleteMany({ where: createdOrForTestCustomer });
  await prisma.quotation.deleteMany({ where: createdOrForTestCustomer });
  await prisma.rateCardDraft.deleteMany({
    where: { createdBy: { email: { startsWith: 'agent-it-' } } },
  });
  await prisma.rateCard.deleteMany({ where: createdBy });
  const customers = { customer: createdBy };
  await prisma.customerContact.deleteMany({ where: customers });
  await prisma.partyDraft.deleteMany({ where: { customer: createdBy } });
  await prisma.party.deleteMany({ where: customers });
  await prisma.customer.deleteMany({ where: createdBy });
  await prisma.userPartner.deleteMany({ where: { partner: createdBy } });
  await prisma.partnerContract.deleteMany({ where: { partner: createdBy } });
  await prisma.partner.deleteMany({ where: createdBy });
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
