import type { BookingService, ShipmentEventDto, ShipmentStatus, ShippingMode } from '@nolon/shared';

/**
 * The few milestones a person reads a shipment by (screen review 2026-11-06), grouping the
 * state machine's statuses for display only. The API still decides every move; this only says
 * where the shipment stands on a progress bar.
 */
export const MILESTONES = [
  'REGISTERED',
  'ORIGIN',
  'ON_THE_WAY',
  'ARRIVED',
  'CUSTOMS',
  'DELIVERY',
] as const;
export type Milestone = (typeof MILESTONES)[number];

/** The milestone a status belongs to, or null for ON_HOLD and CANCELLED (no place of their own). */
export function milestoneOf(status: ShipmentStatus, mode: ShippingMode): Milestone | null {
  switch (status) {
    case 'CREATED':
    case 'PICKUP_SCHEDULED':
      return 'REGISTERED';
    case 'RECEIVED_ORIGIN_WAREHOUSE':
    case 'CONSOLIDATED':
    case 'LOADED':
      return 'ORIGIN';
    case 'DEPARTED':
    case 'IN_TRANSIT':
      return 'ON_THE_WAY';
    case 'TRIP_SCHEDULED':
    case 'ROAD_DEPARTED':
    case 'ROAD_IN_TRANSIT':
      // A road shipment travels on its trip; a sea shipment's trip runs inland after the port.
      return mode === 'ROAD' ? (status === 'TRIP_SCHEDULED' ? 'ORIGIN' : 'ON_THE_WAY') : 'ARRIVED';
    case 'ARRIVED_PORT':
    case 'ROAD_ARRIVED':
      return 'ARRIVED';
    case 'CUSTOMS_IN_PROGRESS':
    case 'CUSTOMS_CLEARED':
      return 'CUSTOMS';
    case 'RECEIVED_DESTINATION_WAREHOUSE':
    case 'OUT_FOR_DELIVERY':
    case 'PARTIALLY_DELIVERED':
    case 'DELIVERED':
    case 'CLOSED':
      return 'DELIVERY';
    case 'ON_HOLD':
    case 'CANCELLED':
      return null;
  }
}

export type StepState = 'done' | 'current' | 'upcoming';

export interface ProgressStep {
  milestone: Milestone;
  state: StepState;
  /** When the shipment first reached this milestone (ISO), from its history. */
  reachedAt: string | null;
}

export interface ShipmentProgress {
  steps: ProgressStep[];
  /** ON_HOLD or CANCELLED: the bar stops at the step the shipment was on. */
  stopped: 'ON_HOLD' | 'CANCELLED' | null;
}

const DONE: readonly ShipmentStatus[] = ['DELIVERED', 'CLOSED'];

/**
 * The progress bar of one shipment. Customs shows only when booked or already passed through;
 * a road shipment has no separate arrival-at-port step, so ARRIVED reads as arrival in the city.
 */
export function shipmentProgress(shipment: {
  status: ShipmentStatus;
  statusBeforeHold: ShipmentStatus | null;
  mode: ShippingMode;
  services: readonly BookingService[];
  events: readonly ShipmentEventDto[];
}): ShipmentProgress {
  const { mode } = shipment;
  const live = shipment.events.filter((e) => e.kind !== 'HOLD' && e.kind !== 'RESUME');
  // The step a stopped shipment was on: the hold's own record, else its last status before.
  const lastLive = [...live].reverse().find((e) => milestoneOf(e.status, mode) !== null);
  const standing =
    shipment.status === 'ON_HOLD'
      ? (shipment.statusBeforeHold ?? lastLive?.status ?? 'CREATED')
      : shipment.status === 'CANCELLED'
        ? (lastLive?.status ?? 'CREATED')
        : shipment.status;
  const current = milestoneOf(standing, mode) ?? 'REGISTERED';
  const currentIndex = MILESTONES.indexOf(current);

  const reached = new Map<Milestone, string>();
  for (const e of live) {
    const m = milestoneOf(e.status, mode);
    if (m && !reached.has(m)) reached.set(m, e.occurredAt);
  }

  const customsSeen = reached.has('CUSTOMS');
  const steps = MILESTONES.filter(
    (m) => m !== 'CUSTOMS' || shipment.services.includes('CUSTOMS') || customsSeen,
  ).map<ProgressStep>((milestone) => {
    const index = MILESTONES.indexOf(milestone);
    const finished = milestone === current && DONE.includes(standing);
    const state: StepState =
      index < currentIndex || finished ? 'done' : index === currentIndex ? 'current' : 'upcoming';
    return {
      milestone,
      state,
      reachedAt: state === 'upcoming' ? null : (reached.get(milestone) ?? null),
    };
  });

  const stopped =
    shipment.status === 'ON_HOLD' || shipment.status === 'CANCELLED' ? shipment.status : null;
  return { steps, stopped };
}
