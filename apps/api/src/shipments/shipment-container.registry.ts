import { Injectable } from '@nestjs/common';
import type { ConsolidationStatus, Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** The container a shipment is in (any status but CANCELLED). */
export interface ShipmentContainerRef {
  id: string;
  number: string;
  status: ConsolidationStatus;
}

/**
 * Containers are the consolidations module's. It registers this at start-up, so correcting a
 * shipment's cargo lines (B3-3) locks and measures its container without the shipments module
 * reaching into consolidation tables (consolidations already depends on shipments).
 *
 * Lock order (docs/plans/05-correction-contracts.md, section 3): the container first, then the
 * shipment, as adding to and closing a container do. Never lock a container after a shipment.
 */
export interface ShipmentContainerHandler {
  /** The container the shipment is in now; null when none. No lock is taken. */
  liveContainerInTx(tx: Tx, shipmentId: string): Promise<ShipmentContainerRef | null>;
  /** Locks the container's row (FOR UPDATE) and returns it as it is under the lock. */
  lockContainerInTx(tx: Tx, containerId: string): Promise<ShipmentContainerRef>;
  /**
   * Under the container's lock: runs `write` (which changes cargo lines of its shipments), then
   * refuses (409 CONTAINER_OVER_VOLUME / CONTAINER_OVER_WEIGHT) when the load grew past a limit,
   * the same rule as adding a shipment to it.
   */
  guardCapacityInTx(tx: Tx, containerId: string, write: () => Promise<void>): Promise<void>;
}

@Injectable()
export class ShipmentContainerRegistry {
  private handler: ShipmentContainerHandler | null = null;

  register(handler: ShipmentContainerHandler): void {
    this.handler = handler;
  }

  get(): ShipmentContainerHandler {
    if (!this.handler) throw new Error('No shipment container handler registered');
    return this.handler;
  }
}
