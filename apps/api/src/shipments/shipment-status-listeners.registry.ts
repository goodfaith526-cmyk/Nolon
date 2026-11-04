import { Injectable } from '@nestjs/common';
import type { Prisma, ShipmentStatus } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** A shipment's status as just recorded: at its creation, or by an event. */
export interface ShipmentStatusChange {
  shipmentId: string;
  bookingId: string;
  status: ShipmentStatus;
  occurredAt: Date;
}

export type ShipmentStatusListener = (tx: Tx, change: ShipmentStatusChange) => Promise<void>;

/**
 * Modules that follow shipment statuses (the customer service notices, plan 09 section 5) register
 * here at start-up, so the shipments module calls them without depending on them. Every listener
 * runs inside the transaction that records the status, under the shipment's row lock: a rolled
 * back change leaves nothing behind.
 */
@Injectable()
export class ShipmentStatusListenersRegistry {
  private readonly listeners: ShipmentStatusListener[] = [];

  register(listener: ShipmentStatusListener): void {
    this.listeners.push(listener);
  }

  async notifyInTx(tx: Tx, change: ShipmentStatusChange): Promise<void> {
    for (const listener of this.listeners) await listener(tx, change);
  }
}
