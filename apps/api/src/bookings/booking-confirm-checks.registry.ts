import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * A check another module runs on every booking confirmation, inside the confirming transaction
 * with the booking row locked; it throws to refuse. Registered at start-up (as
 * ContainerBookingsRegistry), so the bookings module never reads another module's tables: the
 * customer service registers its cargo-completeness gate here (plan 09 section 4).
 */
export type BookingConfirmCheck = (tx: Tx, bookingId: string) => Promise<void>;

/**
 * The LAST step of a transaction that confirms a booking, after every write of that transaction:
 * billing's invoice made on confirmation and the customer's credit check under its advisory lock
 * (plan 06 ب6, F147-2; plan 12 section 2.3). BookingsService.finalChecksInTx runs it; every
 * caller of confirmInTx calls that last. `user` is the person confirming.
 */
export type BookingFinalCheck = (
  tx: Tx,
  booking: { id: string; customerId: string; user: AuthUser },
) => Promise<void>;

@Injectable()
export class BookingConfirmChecksRegistry {
  private readonly checks: BookingConfirmCheck[] = [];
  private readonly finals: BookingFinalCheck[] = [];

  register(check: BookingConfirmCheck): void {
    this.checks.push(check);
  }

  registerFinal(check: BookingFinalCheck): void {
    this.finals.push(check);
  }

  async run(tx: Tx, bookingId: string): Promise<void> {
    for (const check of this.checks) await check(tx, bookingId);
  }

  async runFinal(
    tx: Tx,
    booking: { id: string; customerId: string; user: AuthUser },
  ): Promise<void> {
    for (const check of this.finals) await check(tx, booking);
  }
}
