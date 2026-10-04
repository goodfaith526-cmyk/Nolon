import {
  WAREHOUSE_RECEIPT_STATUSES,
  type ShipmentStatus,
  type WarehouseMovementKind,
  type WarehouseReceiptStatus,
} from '@nolon/shared';
import { type Decimal, ZERO } from '../common/money.js';

/**
 * Warehouse rules (scope 10), as pure functions. What a warehouse holds for a shipment is what
 * it received minus what it released; a release can take at most that.
 */

export interface MovementAmounts {
  kind: WarehouseMovementKind;
  warehouseId: string;
  packages: number;
  weightKg: Decimal | null;
}

export interface WarehouseTotals {
  receivedPackages: number;
  releasedPackages: number;
  onHandPackages: number;
  receivedWeightKg: Decimal;
  releasedWeightKg: Decimal;
}

/** Totals per warehouse, in the order each warehouse first appears. */
export function totalsByWarehouse(
  movements: readonly MovementAmounts[],
): Map<string, WarehouseTotals> {
  const totals = new Map<string, WarehouseTotals>();
  for (const m of movements) {
    const t = totals.get(m.warehouseId) ?? {
      receivedPackages: 0,
      releasedPackages: 0,
      onHandPackages: 0,
      receivedWeightKg: ZERO,
      releasedWeightKg: ZERO,
    };
    if (m.kind === 'RECEIPT') {
      t.receivedPackages += m.packages;
      if (m.weightKg) t.receivedWeightKg = t.receivedWeightKg.plus(m.weightKg);
    } else {
      t.releasedPackages += m.packages;
      if (m.weightKg) t.releasedWeightKg = t.releasedWeightKg.plus(m.weightKg);
    }
    t.onHandPackages = t.receivedPackages - t.releasedPackages;
    totals.set(m.warehouseId, t);
  }
  return totals;
}

/** Packages a warehouse holds for the shipment: received there minus released from there. */
export function onHandPackages(movements: readonly MovementAmounts[], warehouseId: string): number {
  return totalsByWarehouse(movements).get(warehouseId)?.onHandPackages ?? 0;
}

/** A release is allowed only for at least one package and no more than is on hand. */
export function canRelease(onHand: number, packages: number): boolean {
  return Number.isInteger(packages) && packages > 0 && packages <= onHand;
}

/** The warehouse statuses among the moves the state machine allows now. */
export function receiptStatusOptions(
  transitions: readonly ShipmentStatus[],
): WarehouseReceiptStatus[] {
  return WAREHOUSE_RECEIPT_STATUSES.filter((status) => transitions.includes(status));
}

/**
 * Preselected on the receipt form: the one allowed warehouse status. With none, the receipt only
 * records the goods; with both (a shipment NOLON does not carry, still on the origin side), the
 * user says which warehouse side this is.
 */
export function defaultReceiptStatus(
  options: readonly WarehouseReceiptStatus[],
): WarehouseReceiptStatus | null {
  return options.length === 1 ? (options[0] ?? null) : null;
}
