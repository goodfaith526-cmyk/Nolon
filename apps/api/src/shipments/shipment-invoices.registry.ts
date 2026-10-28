import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** The invoices that still bill a shipment (annex B: they block its cancellation). */
export interface LiveShipmentInvoices {
  /** Numbers of the approved invoices that are not fully credited, or that took a payment. */
  approved: string[];
  /** How many draft invoices bill the shipment (drafts have no number yet). */
  drafts: number;
}

/**
 * Customer invoices are billing's. Billing registers this at start-up, so cancelling a shipment
 * checks its invoices without the shipments module reaching into billing's tables (billing
 * already depends on shipments).
 */
export interface ShipmentInvoicesHandler {
  /** In the caller's transaction, which holds the shipment's row lock exclusively. */
  liveInvoicesInTx(tx: Tx, shipmentId: string): Promise<LiveShipmentInvoices>;
}

@Injectable()
export class ShipmentInvoicesRegistry {
  private handler: ShipmentInvoicesHandler | null = null;

  register(handler: ShipmentInvoicesHandler): void {
    this.handler = handler;
  }

  get(): ShipmentInvoicesHandler {
    if (!this.handler) throw new Error('No shipment invoices handler registered');
    return this.handler;
  }
}
