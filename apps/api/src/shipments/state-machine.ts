import type {
  BookingService,
  LoadType,
  Permission,
  PublicShipmentStatus,
  ShipmentEventKind,
  ShipmentStatus,
  ShippingMode,
} from '@nolon/shared';

/**
 * The shipment state machine (annex B section 4). Pure functions only: ShipmentsService applies
 * them under a row lock and records an event for every change. No other code changes a
 * shipment's status.
 */

/** Statuses a shipment can move to from each status, before the service filter below. */
const FORWARD: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  CREATED: [
    'PICKUP_SCHEDULED',
    'RECEIVED_ORIGIN_WAREHOUSE',
    'LOADED',
    'TRIP_SCHEDULED',
    'CUSTOMS_IN_PROGRESS',
    'RECEIVED_DESTINATION_WAREHOUSE',
    'OUT_FOR_DELIVERY',
  ],
  PICKUP_SCHEDULED: ['RECEIVED_ORIGIN_WAREHOUSE', 'LOADED', 'TRIP_SCHEDULED'],
  RECEIVED_ORIGIN_WAREHOUSE: ['CONSOLIDATED', 'LOADED', 'TRIP_SCHEDULED'],
  CONSOLIDATED: ['LOADED'],
  LOADED: ['DEPARTED'],
  DEPARTED: ['IN_TRANSIT', 'ARRIVED_PORT'],
  IN_TRANSIT: ['ARRIVED_PORT'],
  ARRIVED_PORT: [
    'CUSTOMS_IN_PROGRESS',
    'TRIP_SCHEDULED',
    'RECEIVED_DESTINATION_WAREHOUSE',
    'OUT_FOR_DELIVERY',
    'PARTIALLY_DELIVERED',
    'DELIVERED',
  ],
  // A multi-leg road journey (Port Sudan → Atbara → Khartoum) repeats the road statuses per leg.
  TRIP_SCHEDULED: ['ROAD_DEPARTED'],
  ROAD_DEPARTED: ['ROAD_IN_TRANSIT', 'ROAD_ARRIVED'],
  ROAD_IN_TRANSIT: ['ROAD_ARRIVED'],
  ROAD_ARRIVED: [
    'TRIP_SCHEDULED',
    'CUSTOMS_IN_PROGRESS',
    'RECEIVED_DESTINATION_WAREHOUSE',
    'OUT_FOR_DELIVERY',
    'PARTIALLY_DELIVERED',
    'DELIVERED',
  ],
  CUSTOMS_IN_PROGRESS: ['CUSTOMS_CLEARED'],
  CUSTOMS_CLEARED: [
    'TRIP_SCHEDULED',
    'RECEIVED_DESTINATION_WAREHOUSE',
    'OUT_FOR_DELIVERY',
    'PARTIALLY_DELIVERED',
    'DELIVERED',
  ],
  RECEIVED_DESTINATION_WAREHOUSE: [
    'TRIP_SCHEDULED',
    'OUT_FOR_DELIVERY',
    'PARTIALLY_DELIVERED',
    'DELIVERED',
  ],
  OUT_FOR_DELIVERY: ['PARTIALLY_DELIVERED', 'DELIVERED'],
  // Each further batch is another partial delivery until the last one.
  PARTIALLY_DELIVERED: ['OUT_FOR_DELIVERY', 'PARTIALLY_DELIVERED', 'DELIVERED'],
  DELIVERED: ['CLOSED'],
  CLOSED: [],
  ON_HOLD: [],
  CANCELLED: [],
};

const SEA_STATUSES: readonly ShipmentStatus[] = [
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
  'ARRIVED_PORT',
];
const ROAD_STATUSES: readonly ShipmentStatus[] = [
  'TRIP_SCHEDULED',
  'ROAD_DEPARTED',
  'ROAD_IN_TRANSIT',
  'ROAD_ARRIVED',
];
const DELIVERY_STATUSES: readonly ShipmentStatus[] = ['PARTIALLY_DELIVERED', 'DELIVERED'];

/** Statuses after which the cargo counts as loaded: cancelling needs a Branch Manager. */
const PRE_LOADING: readonly ShipmentStatus[] = [
  'CREATED',
  'PICKUP_SCHEDULED',
  'RECEIVED_ORIGIN_WAREHOUSE',
  'CONSOLIDATED',
  'TRIP_SCHEDULED',
  'ON_HOLD',
];

const FINISHED: readonly ShipmentStatus[] = ['CLOSED', 'CANCELLED'];

export interface ShipmentShape {
  mode: ShippingMode;
  loadType: LoadType | null;
  services: readonly BookingService[];
}

/**
 * Destination stages a shipment may start with, but only when NOLON does not carry it (no main
 * freight or inland transport booked): customs clearance, storage or final delivery only.
 */
const DESTINATION_ONLY_STARTS: readonly ShipmentStatus[] = [
  'CUSTOMS_IN_PROGRESS',
  'RECEIVED_DESTINATION_WAREHOUSE',
  'OUT_FOR_DELIVERY',
];

/** Annex B: the services chosen on the booking decide which stages exist. */
export function stageApplies(status: ShipmentStatus, shipment: ShipmentShape): boolean {
  const has = (service: BookingService) => shipment.services.includes(service);
  switch (status) {
    case 'PICKUP_SCHEDULED':
      return has('PICKUP');
    case 'RECEIVED_ORIGIN_WAREHOUSE':
    case 'RECEIVED_DESTINATION_WAREHOUSE':
      return has('WAREHOUSE');
    case 'CONSOLIDATED':
      return shipment.loadType === 'LCL';
    case 'CUSTOMS_IN_PROGRESS':
    case 'CUSTOMS_CLEARED':
      return has('CUSTOMS');
    case 'OUT_FOR_DELIVERY':
      return has('LAST_MILE');
    default:
      if (SEA_STATUSES.includes(status)) return shipment.mode === 'SEA' && has('MAIN_FREIGHT');
      if (ROAD_STATUSES.includes(status)) {
        return has('INLAND_TRANSPORT') || (shipment.mode === 'ROAD' && has('MAIN_FREIGHT'));
      }
      return true;
  }
}

/**
 * Forward statuses reachable from `status` for this shipment. When none of the stage statuses
 * apply (a stage the booking's services leave out), delivery is offered so no shipment is
 * stranded; every combination of services can reach DELIVERED (see the spec).
 */
export function nextStatuses(status: ShipmentStatus, shipment: ShipmentShape): ShipmentStatus[] {
  const carried =
    shipment.services.includes('MAIN_FREIGHT') || shipment.services.includes('INLAND_TRANSPORT');
  const candidates = FORWARD[status].filter(
    (next) =>
      stageApplies(next, shipment) &&
      !(status === 'CREATED' && carried && DESTINATION_ONLY_STARTS.includes(next)),
  );
  const canMove = !FINISHED.includes(status) && status !== 'ON_HOLD' && status !== 'DELIVERED';
  if (canMove && candidates.every((next) => DELIVERY_STATUSES.includes(next))) {
    for (const next of DELIVERY_STATUSES) {
      if (!candidates.includes(next)) candidates.push(next);
    }
  }
  return candidates;
}

/**
 * Permissions that allow moving a shipment to `status`, besides shipments:update. Warehouse,
 * customs, trip and delivery staff record their own stage through their module's permission.
 */
export function stagePermissions(status: ShipmentStatus): readonly Permission[] {
  switch (status) {
    case 'RECEIVED_ORIGIN_WAREHOUSE':
    case 'RECEIVED_DESTINATION_WAREHOUSE':
      return ['warehouse:update'];
    case 'CONSOLIDATED':
      return ['consolidation:update'];
    case 'CUSTOMS_IN_PROGRESS':
    case 'CUSTOMS_CLEARED':
      return ['customs:update'];
    case 'OUT_FOR_DELIVERY':
    case 'PARTIALLY_DELIVERED':
    case 'DELIVERED':
      return ['pod:create'];
    case 'CLOSED':
      // Closing is a sign-off, not an operational step: shipments:approve only.
      return [];
    default:
      return ROAD_STATUSES.includes(status) ? ['transport_trips:update'] : [];
  }
}

export function permissionForTransition(status: ShipmentStatus): readonly Permission[] {
  return status === 'CLOSED'
    ? ['shipments:approve']
    : ['shipments:update', ...stagePermissions(status)];
}

export function isActive(status: ShipmentStatus): boolean {
  return !FINISHED.includes(status);
}

export function canHold(status: ShipmentStatus): boolean {
  return isActive(status) && status !== 'ON_HOLD' && status !== 'DELIVERED';
}

/** Cancelling is possible until delivery starts; after loading it needs a Branch Manager. */
export function canCancelStatus(status: ShipmentStatus): boolean {
  return isActive(status) && !['PARTIALLY_DELIVERED', 'DELIVERED'].includes(status);
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

export interface HistoryEvent {
  kind: ShipmentEventKind;
  status: ShipmentStatus;
  occurredAt: Date;
  locationId: string | null;
}

export interface HistoryEntry {
  status: ShipmentStatus;
  occurredAt: Date;
  locationId: string | null;
}

/**
 * Replays events (in recording order) into the path the shipment actually took: a revert removes
 * the statuses it undoes, and a resume removes the hold. The last entry is the current status.
 */
export function replayHistory(events: readonly HistoryEvent[]): HistoryEntry[] {
  const path: HistoryEntry[] = [];
  for (const event of events) {
    const entry = {
      status: event.status,
      occurredAt: event.occurredAt,
      locationId: event.locationId,
    };
    switch (event.kind) {
      case 'RESUME':
        if (path.at(-1)?.status === 'ON_HOLD') path.pop();
        break;
      case 'REVERT':
        while (path.length > 1 && path.at(-1)?.status !== event.status) path.pop();
        break;
      default:
        path.push(entry);
    }
  }
  return path;
}

/** The status a revert returns to, or null when there is nothing to revert. */
export function revertTarget(path: readonly HistoryEntry[]): ShipmentStatus | null {
  const current = path.at(-1)?.status;
  if (!current || !isActive(current) || current === 'ON_HOLD') return null;
  return path.at(-2)?.status ?? null;
}

/** True once the path has gone past the loading stage (cancelling then needs a manager). */
export function hasPassedLoading(path: readonly HistoryEntry[]): boolean {
  return path.some((entry) => !PRE_LOADING.includes(entry.status));
}

// ---------------------------------------------------------------------------------------------
// Public view
// ---------------------------------------------------------------------------------------------

const PUBLIC_STATUS: Record<ShipmentStatus, PublicShipmentStatus | null> = {
  CREATED: 'REGISTERED',
  PICKUP_SCHEDULED: 'PICKUP_IN_PROGRESS',
  RECEIVED_ORIGIN_WAREHOUSE: 'AT_ORIGIN_WAREHOUSE',
  CONSOLIDATED: null,
  LOADED: 'LOADED',
  DEPARTED: 'DEPARTED_ORIGIN',
  IN_TRANSIT: 'IN_TRANSIT_SEA',
  ARRIVED_PORT: 'ARRIVED_PORT',
  TRIP_SCHEDULED: 'PREPARING_ROAD',
  ROAD_DEPARTED: 'DEPARTED_ROAD',
  ROAD_IN_TRANSIT: 'IN_TRANSIT_ROAD',
  ROAD_ARRIVED: 'ARRIVED_CITY',
  CUSTOMS_IN_PROGRESS: 'CUSTOMS_IN_PROGRESS',
  CUSTOMS_CLEARED: 'CUSTOMS_CLEARED',
  RECEIVED_DESTINATION_WAREHOUSE: 'AT_DESTINATION_WAREHOUSE',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  PARTIALLY_DELIVERED: 'PARTIALLY_DELIVERED',
  DELIVERED: 'DELIVERED',
  CLOSED: null,
  ON_HOLD: 'ON_HOLD',
  CANCELLED: null,
};

export function publicStatus(status: ShipmentStatus): PublicShipmentStatus | null {
  return PUBLIC_STATUS[status];
}

export interface PublicEntry {
  status: PublicShipmentStatus;
  occurredAt: Date;
  locationId: string | null;
}

/** The customer's timeline: the actual path, internal statuses left out. */
export function publicTimeline(path: readonly HistoryEntry[]): PublicEntry[] {
  const timeline: PublicEntry[] = [];
  for (const entry of path) {
    const status = publicStatus(entry.status);
    if (status)
      timeline.push({ status, occurredAt: entry.occurredAt, locationId: entry.locationId });
  }
  return timeline;
}
