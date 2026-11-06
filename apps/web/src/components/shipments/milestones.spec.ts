import type { ShipmentEventDto, ShipmentStatus } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { milestoneOf, shipmentProgress } from './milestones';

function event(status: ShipmentStatus, at: string, kind: ShipmentEventDto['kind'] = 'STATUS') {
  return {
    id: `${status}-${at}`,
    kind,
    status,
    fromStatus: null,
    occurredAt: at,
    branchId: 'b',
    locationId: null,
    userName: null,
    source: 'USER',
    note: null,
    reason: null,
    createdAt: at,
  } satisfies ShipmentEventDto;
}

const base = {
  statusBeforeHold: null,
  mode: 'SEA' as const,
  services: ['MAIN_FREIGHT', 'CUSTOMS'] as const,
};

const states = (p: ReturnType<typeof shipmentProgress>) =>
  p.steps.map((s) => `${s.milestone}:${s.state}`);

describe('shipment milestones', () => {
  it('puts the inland trip of a sea shipment under arrival, and of a road shipment on the way', () => {
    expect(milestoneOf('ROAD_IN_TRANSIT', 'SEA')).toBe('ARRIVED');
    expect(milestoneOf('ROAD_IN_TRANSIT', 'ROAD')).toBe('ON_THE_WAY');
    expect(milestoneOf('TRIP_SCHEDULED', 'ROAD')).toBe('ORIGIN');
    expect(milestoneOf('ON_HOLD', 'SEA')).toBeNull();
  });

  it('marks earlier steps done, the current one current, and keeps the first time each was reached', () => {
    const p = shipmentProgress({
      ...base,
      status: 'IN_TRANSIT',
      events: [
        event('CREATED', '2026-11-01T08:00:00Z', 'CREATED'),
        event('LOADED', '2026-11-02T08:00:00Z'),
        event('DEPARTED', '2026-11-03T08:00:00Z'),
        event('IN_TRANSIT', '2026-11-04T08:00:00Z'),
      ],
    });
    expect(states(p)).toEqual([
      'REGISTERED:done',
      'ORIGIN:done',
      'ON_THE_WAY:current',
      'ARRIVED:upcoming',
      'CUSTOMS:upcoming',
      'DELIVERY:upcoming',
    ]);
    expect(p.steps[2]?.reachedAt).toBe('2026-11-03T08:00:00Z');
    expect(p.steps[3]?.reachedAt).toBeNull();
    expect(p.stopped).toBeNull();
  });

  it('leaves customs out when it was not booked nor passed through', () => {
    const p = shipmentProgress({
      ...base,
      services: ['MAIN_FREIGHT'],
      status: 'CREATED',
      events: [],
    });
    expect(p.steps.map((s) => s.milestone)).not.toContain('CUSTOMS');
  });

  it('stops a held shipment on the step it was on', () => {
    const p = shipmentProgress({
      ...base,
      status: 'ON_HOLD',
      statusBeforeHold: 'ARRIVED_PORT',
      events: [
        event('ARRIVED_PORT', '2026-11-05T08:00:00Z'),
        event('ON_HOLD', '2026-11-06T08:00:00Z', 'HOLD'),
      ],
    });
    expect(p.stopped).toBe('ON_HOLD');
    expect(p.steps.find((s) => s.state === 'current')?.milestone).toBe('ARRIVED');
  });

  it('shows a delivered shipment with every step done', () => {
    const p = shipmentProgress({ ...base, status: 'DELIVERED', events: [] });
    expect(p.steps.every((s) => s.state === 'done')).toBe(true);
  });
});
