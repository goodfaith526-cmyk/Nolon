import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** A warehouse still holding a shipment's goods. */
export interface ShipmentGoodsOnHand {
  warehouseCode: string;
  /** Received there minus released from there; more than none. */
  packages: number;
}

/**
 * Warehouse movements are the warehouse module's. It registers this at start-up, so closing a
 * shipment checks its goods without the shipments module reaching into warehouse tables (the
 * warehouse module already depends on shipments).
 */
export interface ShipmentStockHandler {
  /**
   * Every warehouse holding the shipment's goods, in code order. Read in the caller's
   * transaction; receipts and releases lock the shipment (exclusive) before they write, so under
   * the shipment's row lock the answer stays true until the commit.
   */
  goodsOnHandInTx(tx: Tx, shipmentId: string): Promise<ShipmentGoodsOnHand[]>;
}

@Injectable()
export class ShipmentStockRegistry {
  private handler: ShipmentStockHandler | null = null;

  register(handler: ShipmentStockHandler): void {
    this.handler = handler;
  }

  get(): ShipmentStockHandler {
    if (!this.handler) throw new Error('No shipment stock handler registered');
    return this.handler;
  }
}
