import type {
  ConsolidationBasis,
  ConsolidationMove,
  ConsolidationStatus,
  ShipmentStatus,
} from '@nolon/shared';
import { splitAmount } from '../accounting/journal-math.js';
import { type Decimal, ZERO } from '../common/money.js';

/**
 * Consolidation rules (annex B, consolidation; annex C rules 7a and 13). Pure functions: the
 * services apply them under the container and shipment row locks.
 */

const NEXT: Record<ConsolidationStatus, readonly ConsolidationMove[]> = {
  OPEN: ['CLOSED'],
  CLOSED: ['LOADED'],
  LOADED: ['DEPARTED'],
  DEPARTED: ['ARRIVED'],
  ARRIVED: ['DECONSOLIDATED'],
  DECONSOLIDATED: [],
  CANCELLED: [],
};

/** The moves a container can make from `status`: one step forward at a time. */
export function consolidationMoves(status: ConsolidationStatus): readonly ConsolidationMove[] {
  return NEXT[status];
}

/**
 * The status each shipment in the container takes when the container makes `move` (annex B: a
 * change of the container's status applies to all its shipments). Unpacking the container at the
 * destination changes no shipment status: each goes on by itself from the port.
 */
export function shipmentStatusFor(move: ConsolidationMove): ShipmentStatus | null {
  switch (move) {
    case 'CLOSED':
      return 'CONSOLIDATED';
    case 'LOADED':
      return 'LOADED';
    case 'DEPARTED':
      return 'DEPARTED';
    case 'ARRIVED':
      return 'ARRIVED_PORT';
    case 'DECONSOLIDATED':
      return null;
  }
}

/** The sea leg of an LCL shipment, in order (annex B statuses 4-8). */
const SEA_LEG: readonly ShipmentStatus[] = [
  'CONSOLIDATED',
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
  'ARRIVED_PORT',
];

/** Where a shipment goes after the sea leg; it never comes back to the leg from there. */
const AFTER_SEA_LEG: readonly ShipmentStatus[] = [
  'TRIP_SCHEDULED',
  'ROAD_DEPARTED',
  'ROAD_IN_TRANSIT',
  'ROAD_ARRIVED',
  'CUSTOMS_IN_PROGRESS',
  'CUSTOMS_CLEARED',
  'RECEIVED_DESTINATION_WAREHOUSE',
  'OUT_FOR_DELIVERY',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'CLOSED',
];

/**
 * True when a shipment in the container already is at `target` or beyond it (moved by hand on the
 * shipment page): the container move leaves it as it is. A shipment behind the target (reverted,
 * on hold, cancelled) is not.
 */
export function atOrPastOnSeaLeg(status: ShipmentStatus, target: ShipmentStatus): boolean {
  if (AFTER_SEA_LEG.includes(status)) return true;
  const at = SEA_LEG.indexOf(status);
  const goal = SEA_LEG.indexOf(target);
  return at >= 0 && goal >= 0 && at >= goal;
}

/** Shipments are added or removed, the basis changed, or the container cancelled while open. */
export function isOpen(status: ConsolidationStatus): boolean {
  return status === 'OPEN';
}

/** Closed and not cancelled: the shipments are fixed and costs are shared as they come. */
export function isClosed(status: ConsolidationStatus): boolean {
  return status !== 'OPEN' && status !== 'CANCELLED';
}

/** The container's details (vessel, dates, seal...) are corrected until it is unpacked. */
export function isEditable(status: ConsolidationStatus): boolean {
  return status !== 'DECONSOLIDATED' && status !== 'CANCELLED';
}

/** A container cost may be billed on any container that was not cancelled (bills come late). */
export function takesCosts(status: ConsolidationStatus): boolean {
  return status !== 'CANCELLED';
}

/**
 * The shipment's CBM or weight on the container's basis: the sum of its cargo lines, null when no
 * line has it or it is not positive (the container cannot be closed then: the shipment would
 * carry no share of the cost).
 */
export function basisValueOf(
  basis: ConsolidationBasis,
  items: readonly { volumeCbm: Decimal | null; weightKg: Decimal | null }[],
): Decimal | null {
  const values = items
    .map((i) => (basis === 'CBM' ? i.volumeCbm : i.weightKg))
    .filter((v): v is Decimal => v !== null);
  if (values.length === 0) return null;
  const total = values.reduce((acc, v) => acc.plus(v), ZERO);
  return total.gt(0) ? total : null;
}

export interface ContainerShare {
  shipmentId: string;
  amount: Decimal;
}

/**
 * Splits a container cost (in a currency with `decimalPlaces` minor units) between its shipments
 * in proportion to the basis values frozen at the close. The shares add up to the amount exactly
 * (journal-math splitAmount); in a fixed order, so the cent left by rounding always lands on the
 * same shipment.
 */
export function splitContainerCost(
  amount: Decimal,
  decimalPlaces: number,
  shipments: readonly { shipmentId: string; basisValue: Decimal }[],
): ContainerShare[] {
  if (shipments.length === 0) throw new Error('A container cost is split over its shipments');
  const ordered = [...shipments].sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));
  const amounts = splitAmount(
    amount,
    ordered.map((s) => s.basisValue),
    decimalPlaces,
  );
  return ordered.map((s, index) => ({ shipmentId: s.shipmentId, amount: amounts[index] ?? ZERO }));
}
