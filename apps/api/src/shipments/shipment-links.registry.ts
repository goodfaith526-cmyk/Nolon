import { Injectable } from '@nestjs/common';
import type { Prisma, ShipmentStatus } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** The record a shipment's cancel or revert would leave stuck or contradict (B2). */
export interface ShipmentLinkBlocker {
  record: 'TRIP' | 'CONTAINER' | 'WAREHOUSE' | 'POD' | 'CUSTOMS';
  /** Its number, as staff see it. */
  number: string;
}

/** The step a revert would undo: its status, and the note its event carries. */
export interface UndoneStep {
  status: ShipmentStatus;
  note: string | null;
}

/**
 * Trips, containers, warehouse movements, proofs of delivery and customs files belong to their own
 * modules, which already depend on shipments. Each registers a handler at start-up, so a cancel or
 * a revert checks them without the shipments module reaching into their tables (plan #110, B2).
 *
 * Both are read in the caller's transaction under the shipment's exclusive row lock. Every write
 * that links a shipment to one of these records or moves its status through one (trip moves,
 * container closes and moves, receipts, releases, proofs of delivery, customs) locks the shipment
 * exclusively first, so the answer stays true until the commit.
 */
export interface ShipmentLinkHandler {
  /** A record cancelling the shipment would strand: a trip under way, a container in transit. */
  cancelBlockerInTx?(tx: Tx, shipmentId: string): Promise<ShipmentLinkBlocker | null>;
  /** A live record of this module that made the step a revert would undo. */
  revertBlockerInTx?(
    tx: Tx,
    shipmentId: string,
    step: UndoneStep,
  ): Promise<ShipmentLinkBlocker | null>;
}

@Injectable()
export class ShipmentLinksRegistry {
  private readonly handlers: ShipmentLinkHandler[] = [];

  register(handler: ShipmentLinkHandler): void {
    this.handlers.push(handler);
  }

  async cancelBlockerInTx(tx: Tx, shipmentId: string): Promise<ShipmentLinkBlocker | null> {
    for (const handler of this.handlers) {
      const blocker = await handler.cancelBlockerInTx?.(tx, shipmentId);
      if (blocker) return blocker;
    }
    return null;
  }

  async revertBlockerInTx(
    tx: Tx,
    shipmentId: string,
    step: UndoneStep,
  ): Promise<ShipmentLinkBlocker | null> {
    for (const handler of this.handlers) {
      const blocker = await handler.revertBlockerInTx?.(tx, shipmentId, step);
      if (blocker) return blocker;
    }
    return null;
  }
}
