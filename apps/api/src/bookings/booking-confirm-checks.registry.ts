import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * A check another module runs on every booking confirmation, inside the confirming transaction
 * with the booking row locked; it throws to refuse. Registered at start-up (as
 * ContainerBookingsRegistry), so the bookings module never reads another module's tables: the
 * customer service registers its cargo-completeness gate here (plan 09 section 4).
 */
export type BookingConfirmCheck = (tx: Tx, bookingId: string) => Promise<void>;

@Injectable()
export class BookingConfirmChecksRegistry {
  private readonly checks: BookingConfirmCheck[] = [];

  register(check: BookingConfirmCheck): void {
    this.checks.push(check);
  }

  async run(tx: Tx, bookingId: string): Promise<void> {
    for (const check of this.checks) await check(tx, bookingId);
  }
}
