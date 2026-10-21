import { describe, expect, it } from 'vitest';
import {
  EVENT_BOUND_SHIPMENT_STATUSES,
  SHIPMENT_STATUSES,
  SHIPMENT_STATUS_DRAFT_EXCLUDED,
  SHIPMENT_STATUS_RECORD,
  SHIPPING_MODES,
  hasRoadLeg,
  hasSeaLeg,
  isBranchCode,
  isCurrencyCodeFormat,
  isEventBoundShipmentStatus,
  isLocale,
  isManualShipmentStatus,
  loadTypeOf,
  localeDirection,
  modeOfLegs,
} from './index.js';

describe('shared constants', () => {
  it('accepts only known branch codes', () => {
    expect(isBranchCode('DXB')).toBe(true);
    expect(isBranchCode('KRT')).toBe(true);
    expect(isBranchCode('dxb')).toBe(false);
    expect(isBranchCode('XXX')).toBe(false);
    expect(isBranchCode(1)).toBe(false);
  });

  it('checks only the shape of a currency code, not whether it exists', () => {
    expect(isCurrencyCodeFormat('SDG')).toBe(true);
    expect(isCurrencyCodeFormat('GBP')).toBe(true);
    expect(isCurrencyCodeFormat('sdg')).toBe(false);
    expect(isCurrencyCodeFormat('US')).toBe(false);
    expect(isCurrencyCodeFormat(840)).toBe(false);
  });

  it('maps locales to text direction', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });
});

describe('shipping mode legs (sea, road, or both)', () => {
  it('maps the two ticks to a mode and back', () => {
    expect(modeOfLegs(true, false)).toBe('SEA');
    expect(modeOfLegs(false, true)).toBe('ROAD');
    expect(modeOfLegs(true, true)).toBe('SEA_ROAD');
    expect(modeOfLegs(false, false)).toBeNull();
    for (const mode of SHIPPING_MODES) {
      expect(modeOfLegs(hasSeaLeg(mode), hasRoadLeg(mode))).toBe(mode);
    }
  });
});

describe('load type left unchosen (functional review B2)', () => {
  it('is FCL for a container and LCL otherwise, on a sea leg only', () => {
    expect(loadTypeOf('SEA', 'CONTAINER')).toBe('FCL');
    expect(loadTypeOf('SEA_ROAD', 'CONTAINER')).toBe('FCL');
    expect(loadTypeOf('SEA', 'PALLET')).toBe('LCL');
    expect(loadTypeOf('SEA', 'BARREL')).toBe('LCL');
    expect(loadTypeOf('SEA', 'GENERAL')).toBe('LCL');
    expect(loadTypeOf('ROAD', 'CONTAINER')).toBeNull();
    expect(loadTypeOf('ROAD', 'PALLET')).toBeNull();
  });
});

describe('shipment statuses set by their own record (functional review Z1, E7)', () => {
  const noTrip = { onOpenTrip: false };
  const onTrip = { onOpenTrip: true };

  it('locks the warehouse, container, customs and delivery statuses whatever the trip', () => {
    for (const status of [
      'RECEIVED_ORIGIN_WAREHOUSE',
      'RECEIVED_DESTINATION_WAREHOUSE',
      'CONSOLIDATED',
      'CUSTOMS_IN_PROGRESS',
      'CUSTOMS_CLEARED',
      'PARTIALLY_DELIVERED',
      'DELIVERED',
    ] as const) {
      expect(isManualShipmentStatus(status, noTrip)).toBe(false);
      expect(isManualShipmentStatus(status, onTrip)).toBe(false);
    }
  });

  it('keeps the trip statuses manual for a shipment on no open trip (external carrier)', () => {
    for (const status of ['TRIP_SCHEDULED', 'ROAD_DEPARTED', 'ROAD_ARRIVED'] as const) {
      expect(isManualShipmentStatus(status, noTrip)).toBe(true);
      expect(isManualShipmentStatus(status, onTrip)).toBe(false);
    }
  });

  it('keeps every status no record sets manual', () => {
    const manual = SHIPMENT_STATUSES.filter((s) => !isEventBoundShipmentStatus(s));
    expect(manual).toEqual([
      'CREATED',
      'PICKUP_SCHEDULED',
      'LOADED',
      'DEPARTED',
      'IN_TRANSIT',
      'ARRIVED_PORT',
      'ROAD_IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'CLOSED',
      'ON_HOLD',
      'CANCELLED',
    ]);
    for (const status of manual) {
      expect(isManualShipmentStatus(status, onTrip)).toBe(true);
    }
  });

  it('names the record of every event-bound status', () => {
    expect(Object.keys(SHIPMENT_STATUS_RECORD).sort()).toEqual(
      [...EVENT_BOUND_SHIPMENT_STATUSES].sort(),
    );
  });

  it('never lets a status draft propose a status that is locked whatever the trip', () => {
    const excluded: readonly string[] = SHIPMENT_STATUS_DRAFT_EXCLUDED;
    for (const status of EVENT_BOUND_SHIPMENT_STATUSES) {
      const lockedAlways = !isManualShipmentStatus(status, noTrip);
      expect(excluded.includes(status)).toBe(lockedAlways);
    }
  });
});
