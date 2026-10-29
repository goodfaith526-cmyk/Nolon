import { Injectable } from '@nestjs/common';
import type { CommissionRole } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import type { CargoType, Prisma, ShipmentStatus } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * The writes that can change a partner's commission on a shipment (plan 07, 4.3). Each calls
 * `CommissionTriggers.shipmentChangedInTx` inside its own transaction, after its write; the
 * integration tests (commission-accrual.int-spec.ts) run every one of them.
 */
export const COMMISSION_TRIGGERS = [
  /** InvoicesService.approve: the INVOICED event, and the base of a percentage. */
  'INVOICE_APPROVED',
  /** CreditNotesService.approve: a smaller base. */
  'CREDIT_NOTE_APPROVED',
  /** PodService.record and cancel: the DELIVERED event (a full, live POD). */
  'POD',
  /** ShipmentsService.applyEventInTx: every status step, revert, hold and cancel (DEPARTED). */
  'SHIPMENT_EVENT',
  /** ShipmentsService.update: the consolidator or the distributor changed. */
  'SHIPMENT_PARTNERS',
  /** ShipmentsService.correctCargo: the quantity of a fixed amount per unit (F149-4). */
  'CARGO_CORRECTED',
] as const;
export type CommissionTrigger = (typeof COMMISSION_TRIGGERS)[number];

/**
 * Every write of a shipment's cargo lines in the code, by file and call (commission-triggers.spec.ts
 * finds them, and fails on one missing here): each says which trigger covers it, or why none is
 * needed (F149-4). The cargo type and container types are written with the lines, only there.
 */
export const CARGO_WRITES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'shipments/shipments.service.ts': {
    'shipment.create': 'createForBooking: a new shipment has no event or invoice yet',
    'shipmentItem.deleteMany': 'correctCargo: CARGO_CORRECTED',
    'shipmentItem.createMany': 'correctCargo: CARGO_CORRECTED',
  },
};

/** What a shipment's partner commissions depend on (ShipmentsService.commissionFactsInTx). */
export interface ShipmentCommissionFacts {
  number: string;
  branchId: string;
  /** The branch's time zone: the day an event happened on. */
  timezone: string;
  status: ShipmentStatus;
  cargoType: CargoType;
  partners: Record<CommissionRole, string | null>;
  /** The cargo lines as corrected (unitQuantity reads them). */
  items: {
    cargoType: CargoType;
    containerTypeCode: string | null;
    quantity: number;
    weightKg: Prisma.Decimal | null;
    volumeCbm: Prisma.Decimal | null;
  }[];
  /** The price category of each of its booking's lines (null: a line without one). */
  categories: (string | null)[];
  /** When it first departed (DEPARTED or ROAD_DEPARTED) on the path it still stands on. */
  departedAt: Date | null;
}

export interface CommissionSyncHandler {
  /**
   * Brings the shipment's partner commissions to what they should be now, posting rule 16 for each
   * difference. `date` is the entry date (the invoice's or the credit note's); by default the day
   * in the shipment's branch.
   */
  syncShipmentInTx(tx: Tx, user: AuthUser, shipmentId: string, date?: string): Promise<void>;
}

/**
 * Partner commissions are their own module, which reads shipments, invoices and proofs of delivery
 * and so depends on them. It registers here at start-up, so those modules call the sync without a
 * module cycle (as ShipmentLinksRegistry).
 */
@Injectable()
export class CommissionTriggers {
  private handler: CommissionSyncHandler | null = null;

  register(handler: CommissionSyncHandler): void {
    this.handler = handler;
  }

  /**
   * Queues the transaction behind any other one syncing the shipment's commissions, until commit.
   * The sync takes it first thing. A write that posts its own entry before the sync (an invoice or
   * credit note approval) takes it before posting: posting holds the journal's number sequence
   * until commit, and a sync waiting on that while holding this lock would deadlock.
   */
  async lockInTx(tx: Tx, shipmentId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission:${shipmentId}`}, 0))`;
  }

  /** `trigger` names the write, for the reader: every one syncs the same way. */
  async shipmentChangedInTx(
    tx: Tx,
    user: AuthUser,
    shipmentId: string,
    trigger: CommissionTrigger,
    date?: string,
  ): Promise<void> {
    if (!this.handler) throw new Error(`No commission handler registered (${trigger})`);
    await this.handler.syncShipmentInTx(tx, user, shipmentId, date);
  }
}
