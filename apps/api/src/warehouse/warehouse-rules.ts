import {
  WAREHOUSE_RECEIPT_STATUSES,
  type ShipmentStatus,
  type WarehouseMovementKind,
  type WarehouseReceiptStatus,
} from '@nolon/shared';
import { daysBetween } from '../common/dates.js';
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

/** Packages held now in all warehouses: what each holds, added up. */
export function heldPackages(movements: readonly MovementAmounts[]): number {
  let held = 0;
  for (const t of totalsByWarehouse(movements).values()) held += t.onHandPackages;
  return held;
}

/**
 * Packages a receipt would put in the warehouses beyond the shipment's cargo lines: goods are in
 * one place at a time, so together the warehouses hold at most `expected`. Zero when it fits.
 */
export function extraPackagesOnReceipt(expected: number, held: number, packages: number): number {
  return Math.max(0, held + packages - expected);
}

/** Packages a warehouse holds for the shipment: received there minus released from there. */
export function onHandPackages(movements: readonly MovementAmounts[], warehouseId: string): number {
  return totalsByWarehouse(movements).get(warehouseId)?.onHandPackages ?? 0;
}

export interface TimedMovement extends MovementAmounts {
  occurredAt: Date;
  createdAt: Date;
}

/**
 * Most packages a release dated `at` can take from the warehouse: the running balance, in log
 * order (occurredAt, then createdAt), must not go below zero at that time or at any later
 * movement. A backdated release therefore cannot take goods received after its date. The new
 * release goes after the movements with the same time.
 */
export function releasableAt(
  movements: readonly TimedMovement[],
  warehouseId: string,
  at: Date,
): number {
  const ordered = movements
    .filter((m) => m.warehouseId === warehouseId)
    .sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  let balance = 0;
  let releasable: number | null = null;
  for (const m of ordered) {
    if (releasable === null && m.occurredAt.getTime() > at.getTime()) releasable = balance;
    balance += m.kind === 'RECEIPT' ? m.packages : -m.packages;
    if (releasable !== null) releasable = Math.min(releasable, balance);
  }
  return Math.max(releasable ?? balance, 0);
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

/**
 * Days goods have been held: from the day the current holding started (the first receipt after
 * the warehouse last held nothing for the shipment) to today, both in the branch's calendar.
 * Received today is 0 days.
 */
export function daysHeld(heldSince: string, today: string): number {
  return Math.max(daysBetween(heldSince, today), 0);
}
