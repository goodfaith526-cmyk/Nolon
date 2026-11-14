import { HttpStatus, Injectable } from '@nestjs/common';
import { codedRefusal } from '../common/validation.js';
import type { Prisma, ShipmentStatus } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** The record a shipment's cancel or revert would leave stuck or contradict (B2). */
export interface ShipmentLinkBlocker {
  record: 'TRIP' | 'CONTAINER' | 'WAREHOUSE' | 'POD' | 'CUSTOMS' | 'PALLET';
  /** Its number, as staff see it. */
  number: string;
}

/** The step a revert would undo: its status, and the note its event carries. */
export interface UndoneStep {
  status: ShipmentStatus;
  note: string | null;
}

/**
 * Where a record put the shipment without a status step of its own (a proof of delivery that kept
 * the status moves the shipment to where it was delivered): for the location timeline (B3).
 */
export interface LocationEffect {
  at: Date;
  createdAt: Date;
  locationId: string;
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
  /** The live records of this module that moved the shipment without a status step. */
  locationEffectsInTx?(tx: Tx, shipmentId: string): Promise<LocationEffect[]>;
  /**
   * When a live full proof of delivery of this module delivered the shipment, or null: closing a
   * shipment with a distributor needs one (plan 07, 6).
   */
  fullDeliveryAtInTx?(tx: Tx, shipmentId: string): Promise<Date | null>;
  /** Plan 12 section 6: whether a live proof of delivery of this module records a delivery. */
  hasLivePodInTx?(tx: Tx, shipmentId: string): Promise<boolean>;
  /**
   * Plan 15-3: the live (open or closed) pallet the shipment is on, or null. A container or trip
   * takes such a shipment in or out only with its whole pallet (SHIPMENT_ON_PALLET).
   */
  livePalletInTx?(tx: Tx, shipmentId: string): Promise<{ id: string; number: string } | null>;
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

  async fullDeliveryAtInTx(tx: Tx, shipmentId: string): Promise<Date | null> {
    for (const handler of this.handlers) {
      const at = await handler.fullDeliveryAtInTx?.(tx, shipmentId);
      if (at) return at;
    }
    return null;
  }

  async hasLivePodInTx(tx: Tx, shipmentId: string): Promise<boolean> {
    for (const handler of this.handlers) {
      if (await handler.hasLivePodInTx?.(tx, shipmentId)) return true;
    }
    return false;
  }

  async livePalletInTx(tx: Tx, shipmentId: string): Promise<{ id: string; number: string } | null> {
    for (const handler of this.handlers) {
      const pallet = await handler.livePalletInTx?.(tx, shipmentId);
      if (pallet) return pallet;
    }
    return null;
  }

  /**
   * Plan 15-3: 409 SHIPMENT_ON_PALLET when the shipment is on a live pallet, unless the caller acts
   * for that very pallet (`palletId`). Read under the shipment's exclusive lock or the carrier's.
   */
  async requireNotOnPalletInTx(
    tx: Tx,
    shipmentId: string,
    label: string,
    palletId?: string,
  ): Promise<void> {
    const pallet = await this.livePalletInTx(tx, shipmentId);
    if (pallet && pallet.id !== palletId) {
      throw codedRefusal(
        HttpStatus.CONFLICT,
        'SHIPMENT_ON_PALLET',
        `Shipment ${label} is on pallet ${pallet.number}: it goes in or out with its whole pallet`,
        { shipment: label, pallet: pallet.number },
      );
    }
  }

  async locationEffectsInTx(tx: Tx, shipmentId: string): Promise<LocationEffect[]> {
    const effects: LocationEffect[] = [];
    for (const handler of this.handlers) {
      effects.push(...((await handler.locationEffectsInTx?.(tx, shipmentId)) ?? []));
    }
    return effects;
  }
}
