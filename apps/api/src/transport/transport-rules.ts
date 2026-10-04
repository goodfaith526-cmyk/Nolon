import {
  POD_STATUSES,
  type CostSplitBasis,
  type PodStatus,
  type ShipmentStatus,
  type TripMove,
  type TripStatus,
} from '@nolon/shared';
import { splitAmount } from '../accounting/journal-math.js';
import { type Decimal, ZERO } from '../common/money.js';

/**
 * Inland transport rules (scope 12, annex B and annex C rules 10-11). Pure functions: the
 * services apply them under the trip and shipment row locks.
 */

// ---------------------------------------------------------------------------------------------
// Trip status
// ---------------------------------------------------------------------------------------------

const NEXT: Record<TripStatus, readonly TripMove[]> = {
  PLANNED: ['DEPARTED'],
  DEPARTED: ['ARRIVED'],
  ARRIVED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** The moves a trip can make from `status`: one step forward at a time. */
export function tripMoves(status: TripStatus): readonly TripMove[] {
  return NEXT[status];
}

/**
 * The road status each shipment on the trip takes when the trip makes `move` (annex B: the trip
 * status updates statuses 9-12). Completing the trip changes no shipment status.
 */
export function shipmentStatusFor(move: TripMove): ShipmentStatus | null {
  switch (move) {
    case 'DEPARTED':
      return 'ROAD_DEPARTED';
    case 'ARRIVED':
      return 'ROAD_ARRIVED';
    case 'COMPLETED':
      return null;
  }
}

/** The road statuses of one leg, in order (annex B statuses 9-12). */
const LEG: readonly ShipmentStatus[] = [
  'TRIP_SCHEDULED',
  'ROAD_DEPARTED',
  'ROAD_IN_TRANSIT',
  'ROAD_ARRIVED',
];

/** Where a shipment can go after its road leg; it never comes back to this leg from there. */
const AFTER_LEG: readonly ShipmentStatus[] = [
  'CUSTOMS_IN_PROGRESS',
  'CUSTOMS_CLEARED',
  'RECEIVED_DESTINATION_WAREHOUSE',
  'OUT_FOR_DELIVERY',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'CLOSED',
];

/**
 * True when a shipment on a trip already is at `target` or beyond it on this leg (moved by hand
 * on the shipment page, or delivered): the trip move leaves it as it is instead of waiting for it.
 * A shipment behind the target (reverted, on hold, cancelled) is not.
 */
export function atOrPastOnLeg(status: ShipmentStatus, target: ShipmentStatus): boolean {
  if (AFTER_LEG.includes(status)) return true;
  const at = LEG.indexOf(status);
  const goal = LEG.indexOf(target);
  return at >= 0 && goal >= 0 && at >= goal;
}

/** The status a shipment takes when it is put on a trip. */
export const SCHEDULED_STATUS: ShipmentStatus = 'TRIP_SCHEDULED';

/** Shipments are added, removed or the trip cancelled only before it leaves. */
export function isPlanned(status: TripStatus): boolean {
  return status === 'PLANNED';
}

/**
 * Trips a shipment can be on only one of at a time: one road leg is planned or under way. Once a
 * trip has arrived, its shipments may be put on the next leg.
 */
export const OPEN_TRIP_STATUSES: readonly TripStatus[] = ['PLANNED', 'DEPARTED'];

/** Expenses may be recorded on any trip that was not cancelled (receipts arrive late). */
export function takesExpenses(status: TripStatus): boolean {
  return status !== 'CANCELLED';
}

// ---------------------------------------------------------------------------------------------
// Cost split (annex C: a trip's cost is shared by its shipments, by CBM by default, or weight)
// ---------------------------------------------------------------------------------------------

export interface ShipmentMeasures {
  shipmentId: string;
  /** Total volume of the shipment's cargo lines; null when no line has one. */
  volumeCbm: Decimal | null;
  /** Total weight of the shipment's cargo lines; null when no line has one. */
  weightKg: Decimal | null;
}

/** Sums the cargo lines of a shipment; a measure no line has is null. */
export function measuresOf(
  shipmentId: string,
  items: readonly { volumeCbm: Decimal | null; weightKg: Decimal | null }[],
): ShipmentMeasures {
  const sum = (values: (Decimal | null)[]): Decimal | null => {
    const present = values.filter((v): v is Decimal => v !== null);
    return present.length === 0 ? null : present.reduce((acc, v) => acc.plus(v), ZERO);
  };
  return {
    shipmentId,
    volumeCbm: sum(items.map((i) => i.volumeCbm)),
    weightKg: sum(items.map((i) => i.weightKg)),
  };
}

/**
 * CBM when every shipment has a volume, otherwise weight when every shipment has a weight,
 * otherwise equal shares. A basis some shipments lack would put no cost on them at all.
 */
export function splitBasis(shipments: readonly ShipmentMeasures[]): CostSplitBasis {
  const positive = (v: Decimal | null) => v !== null && v.gt(0);
  if (shipments.every((s) => positive(s.volumeCbm))) return 'CBM';
  if (shipments.every((s) => positive(s.weightKg))) return 'WEIGHT';
  return 'EQUAL';
}

export interface CostShare {
  shipmentId: string;
  amount: Decimal;
}

/**
 * Splits a trip cost (in a currency with `decimalPlaces` minor units) between its shipments on
 * the basis above. The shares add up to the amount exactly (journal-math splitAmount); a share
 * can be zero only when the amount has fewer minor units than there are shipments.
 */
export function splitTripCost(
  amount: Decimal,
  decimalPlaces: number,
  shipments: readonly ShipmentMeasures[],
): { basis: CostSplitBasis; shares: CostShare[] } {
  if (shipments.length === 0) throw new Error('A trip cost is split over at least one shipment');
  // In a fixed order, so the cent left by rounding always lands on the same shipment.
  const ordered = [...shipments].sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));
  const basis = splitBasis(ordered);
  const weights = ordered.map((s) =>
    basis === 'CBM' ? (s.volumeCbm ?? ZERO) : basis === 'WEIGHT' ? (s.weightKg ?? ZERO) : ZERO,
  );
  const amounts = splitAmount(amount, weights, decimalPlaces);
  return {
    basis,
    shares: ordered.map((s, index) => ({
      shipmentId: s.shipmentId,
      amount: amounts[index] ?? ZERO,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Proof of delivery
// ---------------------------------------------------------------------------------------------

/** A POD names a trip only once the trip has left: the goods are on it or delivered. */
export const POD_TRIP_STATUSES: readonly TripStatus[] = ['DEPARTED', 'ARRIVED', 'COMPLETED'];

export function tripTakesPod(status: TripStatus): boolean {
  return POD_TRIP_STATUSES.includes(status);
}

/** The delivery statuses a POD may move the shipment to, among those allowed now. */
export function podStatusOptions(transitions: readonly ShipmentStatus[]): PodStatus[] {
  return POD_STATUSES.filter((s) => transitions.includes(s));
}

/** Delivered when the state machine allows it, else partially delivered, else no change. */
export function defaultPodStatus(options: readonly PodStatus[]): PodStatus | null {
  if (options.includes('DELIVERED')) return 'DELIVERED';
  return options[0] ?? null;
}
