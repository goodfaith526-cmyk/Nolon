import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * Booking status changes driven by its shipment: closing the shipment completes the booking,
 * cancelling it cancels the booking. Kept apart from BookingsService (which creates shipments)
 * so the shipments module can use it without a circular dependency. Always called inside the
 * caller's transaction.
 */
@Injectable()
export class BookingLifecycleService {
  async completeForShipment(tx: Tx, bookingId: string): Promise<void> {
    await this.move(tx, bookingId, { status: 'COMPLETED' });
  }

  async cancelForShipment(tx: Tx, bookingId: string, reason: string): Promise<void> {
    await this.move(tx, bookingId, { status: 'CANCELLED', cancelReason: reason });
  }

  private async move(
    tx: Tx,
    bookingId: string,
    data: Prisma.BookingUncheckedUpdateManyInput,
  ): Promise<void> {
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, status: 'CONFIRMED' },
      data,
    });
    if (count === 0) throw new ConflictException('Booking changed meanwhile; reload and retry');
  }
}
