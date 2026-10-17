import { Injectable } from '@nestjs/common';
import type { BookingService, DraftContainer, LoadType, ShippingMode } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PreparedBooking } from './bookings.service.js';

type Tx = Prisma.TransactionClient;

/** What a booking must be to go in an open LCL container: checked against the container. */
export interface ContainerBookingShape {
  originLocationId: string;
  mode: ShippingMode;
  loadType?: LoadType | null;
  services: readonly BookingService[];
}

/**
 * Booking into an open container (consolidation's rules). Consolidations registers this at
 * start-up, so a booking draft that names a container is checked and approved by the same rules
 * as a booking made from the container's page, without the bookings module reaching into
 * consolidation's tables (consolidations already depends on bookings).
 */
export interface ContainerBookingHandler {
  /**
   * NOLON's checks for this user booking into the container now, without a lock: they may book
   * into it, it is open with room, and the booking is an LCL sea booking with main freight from
   * the container's port of loading. Nothing is written.
   */
  requireBookable(
    user: AuthUser,
    consolidationId: string,
    booking: ContainerBookingShape,
  ): Promise<void>;
  /**
   * The container as a reference, whatever else a draft still misses (requireBookable's first
   * half): the user may book into containers and read this one directly (its branch's, or an open
   * one of any branch: the one cross-branch case), and it is open with room. Not found when they
   * could not read it directly, so a refusal names nothing of it. Nothing is written.
   */
  requireReference(user: AuthUser, consolidationId: string): Promise<void>;
  /**
   * In the caller's transaction: locks the container, checks again that it is open with room,
   * records the prepared booking, confirms it (its shipment is created) and puts the shipment in
   * the container. The new booking's id.
   */
  bookInTx(
    tx: Tx,
    user: AuthUser,
    consolidationId: string,
    prepared: PreparedBooking,
  ): Promise<string>;
  /**
   * The container as the review screen of a draft the caller found in the user's branches shows
   * it, only when this user could read it directly (GET /consolidations/:id); null otherwise, or
   * when it no longer exists. A draft never shows more of a container than its direct read.
   */
  describe(user: AuthUser, consolidationId: string): Promise<DraftContainer | null>;
}

@Injectable()
export class ContainerBookingsRegistry {
  private handler: ContainerBookingHandler | null = null;

  register(handler: ContainerBookingHandler): void {
    this.handler = handler;
  }

  get(): ContainerBookingHandler {
    if (!this.handler) throw new Error('No container booking handler registered');
    return this.handler;
  }
}
