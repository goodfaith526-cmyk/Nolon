import { BOOKING_SERVICES, type BookingService, type ShipmentStatus } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import {
  type HistoryEvent,
  type ShipmentShape,
  hasPassedLoading,
  nextStatuses,
  permissionForTransition,
  publicTimeline,
  replayHistory,
  revertTarget,
} from './state-machine.js';

/** Walks the path; statuses before `from` (e.g. an earlier sea leg) count as passed. */
function walk(shape: ShipmentShape, path: ShipmentStatus[], passed: ShipmentStatus[] = []): void {
  const visited = new Set<ShipmentStatus>(passed);
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1] as ShipmentStatus;
    visited.add(from);
    expect(nextStatuses(from, shape, visited), `${from} → ${path[i]}`).toContain(path[i]);
  }
}

const passed = (...statuses: ShipmentStatus[]) => new Set<ShipmentStatus>(statuses);

const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 10, minute));
const event = (
  kind: HistoryEvent['kind'],
  status: ShipmentStatus,
  minute: number,
): HistoryEvent => ({ kind, status, occurredAt: at(minute), locationId: null });

describe('shipment state machine: annex B section 5 paths', () => {
  it('A: sea FCL door to door', () => {
    walk(
      {
        mode: 'SEA',
        loadType: 'FCL',
        services: ['MAIN_FREIGHT', 'PICKUP', 'CUSTOMS', 'INLAND_TRANSPORT', 'LAST_MILE'],
      },
      [
        'CREATED',
        'PICKUP_SCHEDULED',
        'LOADED',
        'DEPARTED',
        'IN_TRANSIT',
        'ARRIVED_PORT',
        'CUSTOMS_IN_PROGRESS',
        'CUSTOMS_CLEARED',
        'TRIP_SCHEDULED',
        'ROAD_DEPARTED',
        'ROAD_IN_TRANSIT',
        'ROAD_ARRIVED',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'CLOSED',
      ],
    );
  });

  it('B: sea LCL with consolidation, collected from the warehouse', () => {
    walk({ mode: 'SEA', loadType: 'LCL', services: ['MAIN_FREIGHT', 'WAREHOUSE', 'CUSTOMS'] }, [
      'CREATED',
      'RECEIVED_ORIGIN_WAREHOUSE',
      'CONSOLIDATED',
      'LOADED',
      'DEPARTED',
      'IN_TRANSIT',
      'ARRIVED_PORT',
      'CUSTOMS_IN_PROGRESS',
      'CUSTOMS_CLEARED',
      'RECEIVED_DESTINATION_WAREHOUSE',
      'DELIVERED',
      'CLOSED',
    ]);
  });

  it('C: port to port without customs', () => {
    walk({ mode: 'SEA', loadType: 'FCL', services: ['MAIN_FREIGHT'] }, [
      'CREATED',
      'LOADED',
      'DEPARTED',
      'IN_TRANSIT',
      'ARRIVED_PORT',
      'DELIVERED',
      'CLOSED',
    ]);
  });

  it('D: road only, multi-leg, delivered from the truck', () => {
    walk({ mode: 'ROAD', loadType: null, services: ['MAIN_FREIGHT'] }, [
      'CREATED',
      'TRIP_SCHEDULED',
      'ROAD_DEPARTED',
      'ROAD_ARRIVED',
      'TRIP_SCHEDULED',
      'ROAD_DEPARTED',
      'ROAD_IN_TRANSIT',
      'ROAD_ARRIVED',
      'DELIVERED',
      'CLOSED',
    ]);
  });

  it('E: storage only', () => {
    walk({ mode: 'ROAD', loadType: null, services: ['WAREHOUSE'] }, [
      'CREATED',
      'RECEIVED_DESTINATION_WAREHOUSE',
      'DELIVERED',
      'CLOSED',
    ]);
  });

  it('F: partial delivery in batches', () => {
    walk(
      { mode: 'SEA', loadType: 'FCL', services: ['MAIN_FREIGHT', 'LAST_MILE'] },
      [
        'ARRIVED_PORT',
        'OUT_FOR_DELIVERY',
        'PARTIALLY_DELIVERED',
        'OUT_FOR_DELIVERY',
        'PARTIALLY_DELIVERED',
        'PARTIALLY_DELIVERED',
        'DELIVERED',
        'CLOSED',
      ],
      ['CREATED', 'LOADED', 'DEPARTED'],
    );
  });
});

describe('shipment state machine: services decide the stages', () => {
  it('hides stages whose service was not booked', () => {
    const portToPort: ShipmentShape = { mode: 'SEA', loadType: 'FCL', services: ['MAIN_FREIGHT'] };
    expect(nextStatuses('CREATED', portToPort, passed('CREATED'))).toEqual(['LOADED']);
    expect(
      nextStatuses('ARRIVED_PORT', portToPort, passed('CREATED', 'LOADED', 'ARRIVED_PORT')),
    ).toEqual(['PARTIALLY_DELIVERED', 'DELIVERED']);
  });

  it('allows consolidation for LCL only', () => {
    const services: BookingService[] = ['MAIN_FREIGHT', 'WAREHOUSE'];
    const visited = passed('CREATED', 'RECEIVED_ORIGIN_WAREHOUSE');
    expect(
      nextStatuses(
        'RECEIVED_ORIGIN_WAREHOUSE',
        { mode: 'SEA', loadType: 'LCL', services },
        visited,
      ),
    ).toContain('CONSOLIDATED');
    expect(
      nextStatuses(
        'RECEIVED_ORIGIN_WAREHOUSE',
        { mode: 'SEA', loadType: 'FCL', services },
        visited,
      ),
    ).not.toContain('CONSOLIDATED');
  });

  it('never offers sea statuses on a road shipment', () => {
    expect(
      nextStatuses(
        'CREATED',
        { mode: 'ROAD', loadType: null, services: ['MAIN_FREIGHT'] },
        passed('CREATED'),
      ),
    ).toEqual(['TRIP_SCHEDULED']);
  });

  it('offers nothing after the end and nothing while on hold', () => {
    const shape: ShipmentShape = { mode: 'SEA', loadType: 'FCL', services: ['MAIN_FREIGHT'] };
    const all = passed('CREATED', 'LOADED', 'DEPARTED', 'ARRIVED_PORT', 'DELIVERED');
    expect(nextStatuses('CLOSED', shape, all)).toEqual([]);
    expect(nextStatuses('CANCELLED', shape, all)).toEqual([]);
    expect(nextStatuses('ON_HOLD', shape, all)).toEqual([]);
    expect(nextStatuses('DELIVERED', shape, all)).toEqual(['CLOSED']);
  });

  it('can reach DELIVERED and CLOSED for every mode, load type and set of services', () => {
    const shapes: ShipmentShape[] = [];
    for (let mask = 1; mask < 1 << BOOKING_SERVICES.length; mask++) {
      const services = BOOKING_SERVICES.filter((_, i) => mask & (1 << i));
      shapes.push({ mode: 'ROAD', loadType: null, services });
      shapes.push({ mode: 'SEA', loadType: 'FCL', services });
      shapes.push({ mode: 'SEA', loadType: 'LCL', services });
    }
    for (const shape of shapes) {
      // States are (status, statuses passed): what is offered depends on both.
      const key = (status: ShipmentStatus, visited: ReadonlySet<ShipmentStatus>) =>
        `${status}|${[...visited].sort().join(',')}`;
      const start = passed('CREATED');
      const seen = new Set([key('CREATED', start)]);
      const queue: [ShipmentStatus, Set<ShipmentStatus>][] = [['CREATED', start]];
      let closed = false;
      while (queue.length > 0) {
        const [current, visited] = queue.shift() as [ShipmentStatus, Set<ShipmentStatus>];
        const options = nextStatuses(current, shape, visited);
        // No active status may be a dead end.
        if (current !== 'CLOSED') {
          expect(options.length, `${current} ${JSON.stringify(shape)}`).toBeGreaterThan(0);
        }
        for (const next of options) {
          if (next === 'CLOSED') closed = true;
          const after = new Set(visited).add(next);
          if (!seen.has(key(next, after))) {
            seen.add(key(next, after));
            queue.push([next, after]);
          }
        }
      }
      expect(closed, JSON.stringify(shape)).toBe(true);
    }
  });
});

describe('shipment state machine: permissions per stage', () => {
  it('lets each team record its own stage', () => {
    expect(permissionForTransition('CUSTOMS_CLEARED')).toContain('customs:update');
    expect(permissionForTransition('RECEIVED_DESTINATION_WAREHOUSE')).toContain('warehouse:update');
    expect(permissionForTransition('ROAD_DEPARTED')).toContain('transport_trips:update');
    expect(permissionForTransition('DELIVERED')).toContain('pod:create');
    expect(permissionForTransition('LOADED')).toEqual(['shipments:update']);
  });

  it('closing needs shipments:approve only', () => {
    expect(permissionForTransition('CLOSED')).toEqual(['shipments:approve']);
  });
});

describe('shipment history replay', () => {
  it('drops reverted statuses and resolved holds', () => {
    const path = replayHistory([
      event('CREATED', 'CREATED', 0),
      event('STATUS', 'LOADED', 1),
      event('STATUS', 'DEPARTED', 2),
      event('REVERT', 'LOADED', 3),
      event('HOLD', 'ON_HOLD', 4),
      event('RESUME', 'LOADED', 5),
      event('STATUS', 'DEPARTED', 6),
    ]);
    expect(path.map((e) => e.status)).toEqual(['CREATED', 'LOADED', 'DEPARTED']);
    expect(path.at(-1)?.occurredAt).toEqual(at(6));
  });

  it('reverts to the previous status, and not from the first one or while on hold', () => {
    const created = replayHistory([event('CREATED', 'CREATED', 0)]);
    expect(revertTarget(created)).toBeNull();
    const loaded = replayHistory([event('CREATED', 'CREATED', 0), event('STATUS', 'LOADED', 1)]);
    expect(revertTarget(loaded)).toBe('CREATED');
    const held = replayHistory([
      event('CREATED', 'CREATED', 0),
      event('STATUS', 'LOADED', 1),
      event('HOLD', 'ON_HOLD', 2),
    ]);
    expect(revertTarget(held)).toBeNull();
  });

  it('undoes repeated statuses one step at a time', () => {
    const events = [
      event('CREATED', 'CREATED', 0),
      event('STATUS', 'OUT_FOR_DELIVERY', 1),
      event('STATUS', 'PARTIALLY_DELIVERED', 2),
      event('STATUS', 'PARTIALLY_DELIVERED', 3),
    ];
    const before = replayHistory(events);
    expect(revertTarget(before)).toBe('PARTIALLY_DELIVERED');
    const after = replayHistory([...events, event('REVERT', 'PARTIALLY_DELIVERED', 4)]);
    expect(after.map((e) => e.status)).toEqual([
      'CREATED',
      'OUT_FOR_DELIVERY',
      'PARTIALLY_DELIVERED',
    ]);
    expect(after.at(-1)?.occurredAt).toEqual(at(2));
    const again = replayHistory([
      ...events,
      event('REVERT', 'PARTIALLY_DELIVERED', 4),
      event('REVERT', 'OUT_FOR_DELIVERY', 5),
    ]);
    expect(again.map((e) => e.status)).toEqual(['CREATED', 'OUT_FOR_DELIVERY']);
  });

  it('knows when the cargo has been loaded', () => {
    const before = replayHistory([
      event('CREATED', 'CREATED', 0),
      event('STATUS', 'PICKUP_SCHEDULED', 1),
      event('HOLD', 'ON_HOLD', 2),
    ]);
    expect(hasPassedLoading(before)).toBe(false);
    const after = replayHistory([event('CREATED', 'CREATED', 0), event('STATUS', 'LOADED', 1)]);
    expect(hasPassedLoading(after)).toBe(true);
    const reverted = replayHistory([
      event('CREATED', 'CREATED', 0),
      event('STATUS', 'LOADED', 1),
      event('REVERT', 'CREATED', 2),
    ]);
    expect(hasPassedLoading(reverted)).toBe(false);
  });

  it('shows the customer public statuses only', () => {
    const path = replayHistory([
      event('CREATED', 'CREATED', 0),
      event('STATUS', 'RECEIVED_ORIGIN_WAREHOUSE', 1),
      event('STATUS', 'CONSOLIDATED', 2),
      event('STATUS', 'LOADED', 3),
    ]);
    expect(publicTimeline(path).map((e) => e.status)).toEqual([
      'REGISTERED',
      'AT_ORIGIN_WAREHOUSE',
      'LOADED',
    ]);
  });
});

describe('shipment state machine: starting at the destination', () => {
  it('starts with customs, storage or delivery only when NOLON does not carry the cargo', () => {
    expect(
      nextStatuses(
        'CREATED',
        { mode: 'SEA', loadType: 'FCL', services: ['CUSTOMS'] },
        passed('CREATED'),
      ),
    ).toEqual(['CUSTOMS_IN_PROGRESS']);
    expect(
      nextStatuses(
        'CREATED',
        {
          mode: 'SEA',
          loadType: 'FCL',
          services: ['MAIN_FREIGHT', 'CUSTOMS', 'WAREHOUSE', 'LAST_MILE'],
        },
        passed('CREATED'),
      ),
    ).toEqual(['RECEIVED_ORIGIN_WAREHOUSE', 'LOADED']);
  });
});

describe('shipment state machine: booked stages cannot be skipped', () => {
  const sea = (services: BookingService[], loadType: 'FCL' | 'LCL' = 'FCL'): ShipmentShape => ({
    mode: 'SEA',
    loadType,
    services: ['MAIN_FREIGHT', ...services],
  });
  const arrived = passed('CREATED', 'LOADED', 'DEPARTED', 'ARRIVED_PORT');

  it('customs and last mile booked: no delivery straight from the port', () => {
    const shape = sea(['CUSTOMS', 'LAST_MILE']);
    expect(nextStatuses('ARRIVED_PORT', shape, arrived)).toEqual(['CUSTOMS_IN_PROGRESS']);
    const cleared = new Set(arrived).add('CUSTOMS_IN_PROGRESS').add('CUSTOMS_CLEARED');
    expect(nextStatuses('CUSTOMS_CLEARED', shape, cleared)).toEqual(['OUT_FOR_DELIVERY']);
  });

  it('pickup comes first', () => {
    expect(nextStatuses('CREATED', sea(['PICKUP', 'WAREHOUSE']), passed('CREATED'))).toEqual([
      'PICKUP_SCHEDULED',
    ]);
  });

  it('an LCL shipment is consolidated before loading', () => {
    const visited = passed('CREATED', 'RECEIVED_ORIGIN_WAREHOUSE');
    expect(nextStatuses('RECEIVED_ORIGIN_WAREHOUSE', sea(['WAREHOUSE'], 'LCL'), visited)).toEqual([
      'CONSOLIDATED',
    ]);
    expect(nextStatuses('CREATED', sea([], 'LCL'), passed('CREATED'))).toEqual(['CONSOLIDATED']);
  });

  it('inland transport follows the sea leg and comes before delivery', () => {
    const shape = sea(['INLAND_TRANSPORT']);
    expect(nextStatuses('CREATED', shape, passed('CREATED'))).toEqual(['LOADED']);
    expect(nextStatuses('ARRIVED_PORT', shape, arrived)).toEqual(['TRIP_SCHEDULED']);
  });

  it('warehousing booked: stored before the last mile or delivery', () => {
    const shape = sea(['WAREHOUSE', 'LAST_MILE']);
    expect(nextStatuses('ARRIVED_PORT', shape, arrived)).toEqual([
      'RECEIVED_DESTINATION_WAREHOUSE',
    ]);
    const stored = new Set(arrived).add('RECEIVED_DESTINATION_WAREHOUSE');
    expect(nextStatuses('RECEIVED_DESTINATION_WAREHOUSE', shape, stored)).toEqual([
      'OUT_FOR_DELIVERY',
    ]);
  });

  it('keeps optional steps: in transit, further road legs, partial deliveries', () => {
    expect(nextStatuses('DEPARTED', sea([]), passed('CREATED', 'LOADED'))).toEqual([
      'IN_TRANSIT',
      'ARRIVED_PORT',
    ]);
    const road: ShipmentShape = { mode: 'ROAD', loadType: null, services: ['MAIN_FREIGHT'] };
    expect(
      nextStatuses(
        'ROAD_ARRIVED',
        road,
        passed('CREATED', 'TRIP_SCHEDULED', 'ROAD_DEPARTED', 'ROAD_ARRIVED'),
      ),
    ).toEqual(['TRIP_SCHEDULED', 'PARTIALLY_DELIVERED', 'DELIVERED']);
    const delivering = passed('CREATED', 'LOADED', 'ARRIVED_PORT', 'PARTIALLY_DELIVERED');
    expect(nextStatuses('PARTIALLY_DELIVERED', sea([]), delivering)).toEqual([
      'PARTIALLY_DELIVERED',
      'DELIVERED',
    ]);
  });
});
