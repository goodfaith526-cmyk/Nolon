import { describe, expect, it } from 'vitest';
import { InvalidLineError, splitAmount } from '../accounting/journal-math.js';
import { dec } from '../common/money.js';
import {
  atOrPastOnLeg,
  defaultPodStatus,
  measuresOf,
  podStatusOptions,
  shipmentStatusFor,
  splitBasis,
  splitTripCost,
  tripMoves,
  tripTakesPod,
} from './transport-rules.js';

const m = (shipmentId: string, cbm: string | null, kg: string | null) => ({
  shipmentId,
  volumeCbm: cbm === null ? null : dec(cbm),
  weightKg: kg === null ? null : dec(kg),
});

const fixed = (values: { amount: { toFixed: () => string } }[]) =>
  values.map((v) => v.amount.toFixed());

describe('splitAmount', () => {
  it('splits in proportion and always adds up to the total', () => {
    const shares = splitAmount(dec('100'), [dec('1'), dec('1'), dec('1')], 2);
    expect(shares.map((s) => s.toFixed())).toEqual(['33.34', '33.33', '33.33']);
    const sum = shares.reduce((acc, s) => acc.plus(s), dec(0));
    expect(sum.toFixed()).toBe('100');
  });

  it('gives the leftover minor units to the largest remainders', () => {
    // 10 split 1:2 → 3.333… and 6.666…: the second has the larger remainder.
    expect(splitAmount(dec('10'), [dec('1'), dec('2')], 2).map((s) => s.toFixed())).toEqual([
      '3.33',
      '6.67',
    ]);
    // A currency without minor units.
    expect(splitAmount(dec('1000'), [dec('1'), dec('2')], 0).map((s) => s.toFixed())).toEqual([
      '333',
      '667',
    ]);
  });

  it('splits equally when no weight is positive', () => {
    expect(splitAmount(dec('9'), [dec(0), dec(0), dec(0)], 2).map((s) => s.toFixed())).toEqual([
      '3',
      '3',
      '3',
    ]);
  });

  it('refuses negative or over-precise amounts and empty splits', () => {
    expect(() => splitAmount(dec('1'), [], 2)).toThrow(InvalidLineError);
    expect(() => splitAmount(dec('-1'), [dec(1)], 2)).toThrow(InvalidLineError);
    expect(() => splitAmount(dec('1.005'), [dec(1)], 2)).toThrow(InvalidLineError);
    expect(() => splitAmount(dec('1'), [dec(-1), dec(2)], 2)).toThrow(InvalidLineError);
  });
});

describe('trip cost split', () => {
  it('sums the cargo lines of a shipment; a measure no line has is null', () => {
    const measures = measuresOf('s', [
      { volumeCbm: dec('1.5'), weightKg: null },
      { volumeCbm: dec('2'), weightKg: null },
    ]);
    expect(measures.volumeCbm?.toFixed()).toBe('3.5');
    expect(measures.weightKg).toBeNull();
  });

  it('uses CBM by default', () => {
    expect(splitBasis([m('a', '1', '500'), m('b', '3', '100')])).toBe('CBM');
    const { basis, shares } = splitTripCost(dec('1000'), 2, [
      m('a', '1', '500'),
      m('b', '3', '100'),
    ]);
    expect(basis).toBe('CBM');
    expect(fixed(shares)).toEqual(['250', '750']);
  });

  it('falls back to weight when a shipment has no volume', () => {
    const { basis, shares } = splitTripCost(dec('1000'), 2, [
      m('a', '1', '600'),
      m('b', null, '400'),
    ]);
    expect(basis).toBe('WEIGHT');
    expect(fixed(shares)).toEqual(['600', '400']);
  });

  it('falls back to equal shares when a shipment has neither', () => {
    const { basis, shares } = splitTripCost(dec('100'), 2, [
      m('a', '1', '600'),
      m('b', null, null),
      m('c', '0', '0'),
    ]);
    expect(basis).toBe('EQUAL');
    expect(fixed(shares)).toEqual(['33.34', '33.33', '33.33']);
  });

  it('a zero measure counts as missing', () => {
    expect(splitBasis([m('a', '0', '5'), m('b', '2', '5')])).toBe('WEIGHT');
  });

  it('orders shares by shipment id, so rounding is deterministic', () => {
    const { shares } = splitTripCost(dec('0.01'), 2, [m('b', '1', null), m('a', '1', null)]);
    expect(shares.map((s) => s.shipmentId)).toEqual(['a', 'b']);
    expect(fixed(shares)).toEqual(['0.01', '0']);
  });

  it('one shipment carries the whole cost', () => {
    expect(fixed(splitTripCost(dec('123.45'), 2, [m('a', null, null)]).shares)).toEqual(['123.45']);
  });
});

describe('trip status', () => {
  it('moves one step at a time; finished trips do not move', () => {
    expect(tripMoves('PLANNED')).toEqual(['DEPARTED']);
    expect(tripMoves('DEPARTED')).toEqual(['ARRIVED']);
    expect(tripMoves('ARRIVED')).toEqual(['COMPLETED']);
    expect(tripMoves('COMPLETED')).toEqual([]);
    expect(tripMoves('CANCELLED')).toEqual([]);
  });

  it('departing and arriving drive the shipments road statuses; completing does not', () => {
    expect(shipmentStatusFor('DEPARTED')).toBe('ROAD_DEPARTED');
    expect(shipmentStatusFor('ARRIVED')).toBe('ROAD_ARRIVED');
    expect(shipmentStatusFor('COMPLETED')).toBeNull();
  });
});

describe('proof of delivery', () => {
  it('offers the delivery statuses the state machine allows, DELIVERED first', () => {
    const options = podStatusOptions(['OUT_FOR_DELIVERY', 'PARTIALLY_DELIVERED', 'DELIVERED']);
    expect(options).toEqual(['PARTIALLY_DELIVERED', 'DELIVERED']);
    expect(defaultPodStatus(options)).toBe('DELIVERED');
    expect(defaultPodStatus(['PARTIALLY_DELIVERED'])).toBe('PARTIALLY_DELIVERED');
    expect(defaultPodStatus(podStatusOptions(['TRIP_SCHEDULED']))).toBeNull();
  });
});

describe('atOrPastOnLeg: a trip move leaves shipments already there or beyond', () => {
  it('counts the target itself and later road statuses of the leg', () => {
    expect(atOrPastOnLeg('ROAD_DEPARTED', 'ROAD_DEPARTED')).toBe(true);
    expect(atOrPastOnLeg('ROAD_IN_TRANSIT', 'ROAD_DEPARTED')).toBe(true);
    expect(atOrPastOnLeg('ROAD_ARRIVED', 'ROAD_DEPARTED')).toBe(true);
    expect(atOrPastOnLeg('ROAD_IN_TRANSIT', 'ROAD_ARRIVED')).toBe(false);
  });

  it('counts the statuses after the leg (customs, warehouse, delivery, closed)', () => {
    for (const status of [
      'CUSTOMS_IN_PROGRESS',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'CLOSED',
    ] as const) {
      expect(atOrPastOnLeg(status, 'ROAD_DEPARTED')).toBe(true);
      expect(atOrPastOnLeg(status, 'ROAD_ARRIVED')).toBe(true);
    }
  });

  it('does not count a shipment behind the target, on hold or cancelled', () => {
    expect(atOrPastOnLeg('TRIP_SCHEDULED', 'ROAD_DEPARTED')).toBe(false);
    expect(atOrPastOnLeg('ROAD_DEPARTED', 'ROAD_ARRIVED')).toBe(false);
    expect(atOrPastOnLeg('ARRIVED_PORT', 'ROAD_DEPARTED')).toBe(false);
    expect(atOrPastOnLeg('ON_HOLD', 'ROAD_DEPARTED')).toBe(false);
    expect(atOrPastOnLeg('CANCELLED', 'ROAD_ARRIVED')).toBe(false);
  });
});

describe('tripTakesPod', () => {
  it('only a trip that has left', () => {
    expect(tripTakesPod('PLANNED')).toBe(false);
    expect(tripTakesPod('CANCELLED')).toBe(false);
    expect(tripTakesPod('DEPARTED')).toBe(true);
    expect(tripTakesPod('ARRIVED')).toBe(true);
    expect(tripTakesPod('COMPLETED')).toBe(true);
  });
});
