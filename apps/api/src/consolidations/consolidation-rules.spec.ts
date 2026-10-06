import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  atOrPastOnSeaLeg,
  basisValueOf,
  consolidationMoves,
  isClosed,
  isOpen,
  shipmentStatusFor,
  splitContainerCost,
} from './consolidation-rules.js';

describe('consolidation rules', () => {
  it('moves a container one step at a time and maps each step to its shipments', () => {
    expect(consolidationMoves('OPEN')).toEqual(['CLOSED']);
    expect(consolidationMoves('ARRIVED')).toEqual(['DECONSOLIDATED']);
    expect(consolidationMoves('DECONSOLIDATED')).toEqual([]);
    expect(consolidationMoves('CANCELLED')).toEqual([]);
    expect(shipmentStatusFor('CLOSED')).toBe('CONSOLIDATED');
    expect(shipmentStatusFor('ARRIVED')).toBe('ARRIVED_PORT');
    expect(shipmentStatusFor('DECONSOLIDATED')).toBeNull();
    expect(isOpen('OPEN')).toBe(true);
    expect(isClosed('OPEN')).toBe(false);
    expect(isClosed('CANCELLED')).toBe(false);
    expect(isClosed('DECONSOLIDATED')).toBe(true);
  });

  it('leaves a shipment already at or past the target, never one behind it', () => {
    expect(atOrPastOnSeaLeg('LOADED', 'LOADED')).toBe(true);
    expect(atOrPastOnSeaLeg('IN_TRANSIT', 'DEPARTED')).toBe(true);
    expect(atOrPastOnSeaLeg('CUSTOMS_IN_PROGRESS', 'ARRIVED_PORT')).toBe(true);
    expect(atOrPastOnSeaLeg('CONSOLIDATED', 'LOADED')).toBe(false);
    expect(atOrPastOnSeaLeg('ON_HOLD', 'LOADED')).toBe(false);
    expect(atOrPastOnSeaLeg('CANCELLED', 'LOADED')).toBe(false);
  });

  it('takes the basis from the cargo lines, null when none has it', () => {
    const items = [
      { volumeCbm: dec('1.5'), weightKg: dec('200') },
      { volumeCbm: null, weightKg: dec('100') },
    ];
    expect(basisValueOf('CBM', items)?.toFixed()).toBe('1.5');
    expect(basisValueOf('WEIGHT', items)?.toFixed()).toBe('300');
    expect(basisValueOf('CBM', [{ volumeCbm: null, weightKg: dec('1') }])).toBeNull();
    expect(basisValueOf('CBM', [{ volumeCbm: dec('0'), weightKg: null }])).toBeNull();
  });

  it('splits a cost in proportion, adding up exactly, the cent in a fixed place', () => {
    const shipments = [
      { shipmentId: 'b', basisValue: dec('1') },
      { shipmentId: 'a', basisValue: dec('1') },
      { shipmentId: 'c', basisValue: dec('1') },
    ];
    const shares = splitContainerCost(dec('100'), 2, shipments);
    expect(shares.map((s) => s.shipmentId)).toEqual(['a', 'b', 'c']);
    expect(shares.map((s) => s.amount.toFixed())).toEqual(['33.34', '33.33', '33.33']);
    expect(
      splitContainerCost(dec('1000'), 2, [
        { shipmentId: 'x', basisValue: dec('2') },
        { shipmentId: 'y', basisValue: dec('3') },
        { shipmentId: 'z', basisValue: dec('5') },
      ]).map((s) => s.amount.toFixed()),
    ).toEqual(['200', '300', '500']);
    expect(() => splitContainerCost(dec('1'), 2, [])).toThrow();
  });
});
