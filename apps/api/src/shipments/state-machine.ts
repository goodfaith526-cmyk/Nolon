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
    'CONSOLIDATED',
    'LOADED',
    'TRIP_SCHEDULED',
    'CUSTOMS_IN_PROGRESS',
    'RECEIVED_DESTINATION_WAREHOUSE',
    'OUT_FOR_DELIVERY',
  ],
  PICKUP_SCHEDULED: [
    'RECEIVED_ORIGIN_WAREHOUSE',
    'CONSOLIDATED',
    'LOADED',
    'TRIP_SCHEDULED',
    'CUSTOMS_IN_PROGRESS',
    'RECEIVED_DESTINATION_WAREHOUSE',
    'OUT_FOR_DELIVERY',
  ],
  RECEIVED_ORIGIN_WAREHOUSE: [
    'CONSOLIDATED',
    'LOADED',
    'TRIP_SCHEDULED',
    'CUSTOMS_IN_PROGRESS',
    'OUT_FOR_DELIVERY',
  ],
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
 * Destination stages a shipment may go to straight from the origin side (created, picked up,
 * stored), but only when NOLON does not carry it (no main freight or inland transport booked):
 * customs clearance, storage or final delivery only.
 */
const DESTINATION_ONLY_STARTS: readonly ShipmentStatus[] = [
  'CUSTOMS_IN_PROGRESS',
  'RECEIVED_DESTINATION_WAREHOUSE',
  'OUT_FOR_DELIVERY',
];

const ORIGIN_SIDE: readonly ShipmentStatus[] = [
  'CREATED',
  'PICKUP_SCHEDULED',
  'RECEIVED_ORIGIN_WAREHOUSE',
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
      // Groupage into a container NOLON ships: LCL sea freight only.
      return shipment.loadType === 'LCL' && shipment.mode === 'SEA' && has('MAIN_FREIGHT');
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
 * Booked stages are never skipped. A status is offered only once every stage the booking
 * requires before it is done, judged on the statuses the shipment has actually passed
 * (`visited`, from the replayed history):
 * - pickup comes first;
 * - an LCL sea shipment is consolidated before loading;
 * - inland trips follow the sea leg (inland transport is the destination leg, from the port);
 * - customs on a sea shipment starts once it has arrived at the port;
 * - the destination warehouse, last mile and delivery wait for the sea leg, a road leg, and
 *   customs clearance, when booked; last mile and delivery also wait for a warehouse receipt
 *   when warehousing is booked, and delivery for the last mile when it is booked.
 * Optional steps stay optional: in-transit updates, further road legs and partial deliveries.
 */
function prerequisitesMet(
  next: ShipmentStatus,
  shipment: ShipmentShape,
  visited: ReadonlySet<ShipmentStatus>,
): boolean {
  const has = (service: BookingService) => shipment.services.includes(service);
  const seaLeg = shipment.mode === 'SEA' && has('MAIN_FREIGHT');
  const roadLeg = stageApplies('TRIP_SCHEDULED', shipment);
  if (has('PICKUP') && next !== 'PICKUP_SCHEDULED' && !visited.has('PICKUP_SCHEDULED')) {
    return false;
  }
  if (next === 'LOADED' && stageApplies('CONSOLIDATED', shipment)) {
    return visited.has('CONSOLIDATED');
  }
  if (next === 'TRIP_SCHEDULED' || next === 'CUSTOMS_IN_PROGRESS') {
    return !seaLeg || visited.has('ARRIVED_PORT');
  }
  if (
    next === 'RECEIVED_DESTINATION_WAREHOUSE' ||
    next === 'OUT_FOR_DELIVERY' ||
    DELIVERY_STATUSES.includes(next)
  ) {
    if (seaLeg && !visited.has('ARRIVED_PORT')) return false;
    if (roadLeg && !visited.has('ROAD_ARRIVED')) return false;
    if (has('CUSTOMS') && !visited.has('CUSTOMS_CLEARED')) return false;
  }
  if (next === 'OUT_FOR_DELIVERY' || DELIVERY_STATUSES.includes(next)) {
    const stored =
      visited.has('RECEIVED_ORIGIN_WAREHOUSE') || visited.has('RECEIVED_DESTINATION_WAREHOUSE');
    if (has('WAREHOUSE') && !stored) return false;
  }
  if (DELIVERY_STATUSES.includes(next) && has('LAST_MILE')) {
    return visited.has('OUT_FOR_DELIVERY');
  }
  return true;
}

/**
 * Forward statuses reachable from `status` for this shipment, given the statuses it has passed.
 * When none of the stage statuses apply (a stage the booking's services leave out), delivery is
 * offered so no shipment is stranded; every combination of services can reach DELIVERED (see
 * the spec).
 */
export function nextStatuses(
  status: ShipmentStatus,
  shipment: ShipmentShape,
  visited: ReadonlySet<ShipmentStatus>,
): ShipmentStatus[] {
  const carried =
    shipment.services.includes('MAIN_FREIGHT') || shipment.services.includes('INLAND_TRANSPORT');
  const candidates = FORWARD[status].filter(
    (next) =>
      stageApplies(next, shipment) &&
      !(ORIGIN_SIDE.includes(status) && carried && DESTINATION_ONLY_STARTS.includes(next)),
  );
  const canMove = !FINISHED.includes(status) && status !== 'ON_HOLD' && status !== 'DELIVERED';
  if (canMove && candidates.every((next) => DELIVERY_STATUSES.includes(next))) {
    for (const next of DELIVERY_STATUSES) {
      if (!candidates.includes(next)) candidates.push(next);
    }
  }
  return candidates.filter((next) => prerequisitesMet(next, shipment, visited));
}

/** The statuses a shipment has passed, for nextStatuses. */
export function visitedStatuses(path: readonly HistoryEntry[]): Set<ShipmentStatus> {
  return new Set(path.map((entry) => entry.status));
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
        // A revert undoes exactly the current step (revertTarget is the entry before it), so
        // repeated statuses, such as several partial deliveries, are undone one at a time.
        if (path.length > 1) path.pop();
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
