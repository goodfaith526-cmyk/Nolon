import { describe, expect, it } from 'vitest';
import {
  canLeave,
  carries,
  palletActions,
  palletNumber,
  type ActionInput,
} from './pallet-rules.js';

const all = { update: true, cancel: true, container: true, trip: true };
const none = { update: false, cancel: false, container: false, trip: false };

function actions(over: Partial<ActionInput>) {
  return palletActions({
    status: 'CLOSED',
    shipmentCount: 2,
    carrier: null,
    used: false,
    can: all,
    ...over,
  });
}

describe('pallet rules (plan 15-3)', () => {
  it('numbers pallets by branch code and serial', () => {
    expect(palletNumber('JED', 1n)).toBe('JED-P0001');
    expect(palletNumber('PTS', 12345n)).toBe('PTS-P12345');
  });

  it('a container carries until unpacked or cancelled; a trip while planned or under way', () => {
    expect(carries(null)).toBe(false);
    for (const status of ['OPEN', 'CLOSED', 'LOADED', 'DEPARTED', 'ARRIVED'] as const) {
      expect(carries({ kind: 'CONTAINER', status })).toBe(true);
    }
    expect(carries({ kind: 'CONTAINER', status: 'DECONSOLIDATED' })).toBe(false);
    expect(carries({ kind: 'CONTAINER', status: 'CANCELLED' })).toBe(false);
    expect(carries({ kind: 'TRIP', status: 'PLANNED' })).toBe(true);
    expect(carries({ kind: 'TRIP', status: 'DEPARTED' })).toBe(true);
    expect(carries({ kind: 'TRIP', status: 'ARRIVED' })).toBe(false);
    expect(carries({ kind: 'TRIP', status: 'COMPLETED' })).toBe(false);
  });

  it('a whole pallet leaves only an open container or a planned trip', () => {
    expect(canLeave({ kind: 'CONTAINER', status: 'OPEN' })).toBe(true);
    expect(canLeave({ kind: 'CONTAINER', status: 'CLOSED' })).toBe(false);
    expect(canLeave({ kind: 'TRIP', status: 'PLANNED' })).toBe(true);
    expect(canLeave({ kind: 'TRIP', status: 'DEPARTED' })).toBe(false);
  });

  it('an open pallet is filled and closed, never carried', () => {
    const open = actions({ status: 'OPEN' });
    expect(open).toMatchObject({ addShipments: true, close: true, unpack: false, takeOut: false });
    expect(open.putInContainer || open.putOnTrip).toBe(false);
    expect(actions({ status: 'OPEN', shipmentCount: 0 }).close).toBe(false);
  });

  it('a closed free pallet goes in a carrier or unpacks; a carried one does neither', () => {
    const free = actions({});
    expect(free).toMatchObject({ putInContainer: true, putOnTrip: true, unpack: true });
    const carried = actions({ carrier: { kind: 'CONTAINER', status: 'LOADED' }, used: true });
    expect(carried).toMatchObject({
      putInContainer: false,
      putOnTrip: false,
      unpack: false,
      takeOut: false,
      cancel: false,
    });
    expect(actions({ carrier: { kind: 'TRIP', status: 'PLANNED' } }).takeOut).toBe(true);
    // A finished carrier no longer holds the pallet.
    expect(actions({ carrier: { kind: 'TRIP', status: 'ARRIVED' } }).unpack).toBe(true);
  });

  it('cancel only while never carried; nothing without the permissions', () => {
    expect(actions({}).cancel).toBe(true);
    expect(actions({ used: true }).cancel).toBe(false);
    expect(actions({ status: 'UNPACKED' }).cancel).toBe(false);
    expect(Object.values(actions({ can: none })).some(Boolean)).toBe(false);
    expect(actions({ can: { ...all, container: false } }).putInContainer).toBe(false);
  });
});
