import { Injectable } from '@nestjs/common';
import type { ConsolidationCostDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import type { Decimal } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** A closed container, as its costs are shared out (annex C rule 13). */
export interface ClosedContainer {
  id: string;
  number: string;
  branchId: string;
  /** YYYY-MM-DD in the container's branch: the day it was closed. */
  closedOn: string;
  /** The shipments and the CBM or weight frozen at the close. */
  shipments: readonly { shipmentId: string; basisValue: Decimal }[];
}

/** What payables tells a container about its costs. */
export interface ContainerCostsView {
  costs: ConsolidationCostDto[];
  /** USD shared to each shipment by the allocation entries of approved bills. */
  allocatedUsd: Map<string, Decimal>;
  /** Debit - credit (USD) of the clearing account for this container. */
  clearingBalanceUsd: Decimal;
}

/**
 * Container costs are supplier bill lines (payables). Payables registers this at start-up, so the
 * container's close shares out the bills already approved and its cancellation checks for them,
 * without the consolidation module reaching into payables' tables.
 */
export interface ContainerCostHandler {
  /** Rule 13 for every approved cost of the container not shared out yet; in the close's tx. */
  allocatePendingInTx(tx: Tx, user: AuthUser, container: ClosedContainer): Promise<void>;
  /** How many approved bill lines charge the container (it cannot be cancelled while any do). */
  approvedCostCountInTx(tx: Tx, consolidationId: string): Promise<number>;
  view(consolidationId: string): Promise<ContainerCostsView>;
}

@Injectable()
export class ContainerCostsRegistry {
  private handler: ContainerCostHandler | null = null;

  register(handler: ContainerCostHandler): void {
    this.handler = handler;
  }

  get(): ContainerCostHandler {
    if (!this.handler) throw new Error('No container cost handler registered');
    return this.handler;
  }
}
