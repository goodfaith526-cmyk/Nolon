import { ConflictException } from '@nestjs/common';
import { fieldRefusal } from '../common/validation.js';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * Plan 13 section 1: a window (drop-off point) named on a staff booking, share-locked through
 * commit: active, taking shipments, and of the booking's own branch (400 DROP_OFF_NOT_ALLOWED
 * otherwise). The booking's branch is one the person writes bookings in (the caller checked it).
 */
export async function requireDropOffPointInTx(
  tx: Tx,
  id: string,
  branchId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<
    { branch_id: string; is_active: boolean; accepts_drop_off: boolean }[]
  >`SELECT "branch_id"::text AS "branch_id", "is_active", "accepts_drop_off"
    FROM "warehouses" WHERE "id" = ${id}::uuid FOR SHARE`;
  const point = rows[0];
  if (!point?.is_active || !point.accepts_drop_off || point.branch_id !== branchId)
    throw fieldRefusal(
      'DROP_OFF_NOT_ALLOWED',
      "Choose an active drop-off point of the booking's branch",
      ['dropOffWarehouseId'],
    );
  return id;
}

/**
 * A booking a bot request made keeps the request's window: staff change it on the request
 * (POST /cs-booking-requests/:id/drop-off), which updates both, so the bot and the window desk
 * never disagree (409 DROP_OFF_FROM_REQUEST).
 */
export async function refuseRequestBookingInTx(tx: Tx, bookingId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "cs_booking_requests" WHERE "booking_id" = ${bookingId}::uuid)
      AS "found"`;
  if (rows[0]?.found)
    throw new ConflictException({
      code: 'DROP_OFF_FROM_REQUEST',
      message: "Change this booking's drop-off point on its booking request",
      params: {},
      fields: ['dropOffWarehouseId'],
    });
}
