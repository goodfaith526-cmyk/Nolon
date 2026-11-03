import { WAREHOUSE_KINDS } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { BRANCHES } from './branches.js';
import { SOFT_LAUNCH_PLACES } from './soft-launch.js';
import { ADDABLE_PLACES, TRIAL_FACILITIES } from './trial-facilities.js';

/** Rough bounds per country, to catch a swapped or mistyped position. */
const BOUNDS: Record<string, { lat: [number, number]; lng: [number, number] }> = {
  SA: { lat: [16, 33], lng: [34, 56] },
  AE: { lat: [22, 27], lng: [51, 57] },
  EG: { lat: [22, 32], lng: [24, 37] },
  CN: { lat: [18, 54], lng: [73, 135] },
  SD: { lat: [8, 23], lng: [21, 39] },
};

describe('trial facilities', () => {
  const places = new Map([...SOFT_LAUNCH_PLACES, ...ADDABLE_PLACES].map((p) => [p.code, p]));

  it('has unique trial codes the warehouse code rule accepts', () => {
    const codes = TRIAL_FACILITIES.map((f) => f.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^TR-[A-Z0-9]+(-[A-Z0-9]+)*$/);
      expect(code.length).toBeLessThanOrEqual(20);
    }
  });

  it('covers every kind, the five origins, Suakin and the four destinations', () => {
    expect(new Set(TRIAL_FACILITIES.map((f) => f.kind))).toEqual(new Set(WAREHOUSE_KINDS));
    const at = (kind: string) =>
      new Set(TRIAL_FACILITIES.filter((f) => f.kind === kind).map((f) => f.place));
    expect(at('COLLECTION_CENTER')).toEqual(new Set(['SAJED', 'AEDXB', 'AESHJ', 'EGCAI', 'CNCAN']));
    expect(at('DISTRIBUTION_HUB')).toEqual(new Set(['SDSWA']));
    expect(at('DELIVERY_CENTER')).toEqual(new Set(['SDPZU', 'SDATB', 'SDKRT', 'SDDOG']));
    // A window in every city of the network but the hub's town.
    expect(at('DROP_OFF_POINT')).toEqual(new Set([...places.keys()].filter((p) => p !== 'SDSWA')));
  });

  it('uses known branches and places, unique E.164 phones and positions inside the country', () => {
    const branchCodes = new Set<string>(BRANCHES.map((b) => b.code));
    const phones = TRIAL_FACILITIES.map((f) => f.phone);
    expect(new Set(phones).size).toBe(phones.length);
    for (const f of TRIAL_FACILITIES) {
      expect(branchCodes.has(f.branchCode), f.code).toBe(true);
      const place = places.get(f.place);
      expect(place, f.code).toBeDefined();
      expect(f.phone).toMatch(/^\+[1-9]\d{7,14}$/);
      expect(f.latitude).toMatch(/^-?\d{1,2}\.\d{6}$/);
      expect(f.longitude).toMatch(/^-?\d{1,3}\.\d{6}$/);
      const bounds = BOUNDS[place?.countryCode ?? ''];
      expect(bounds, f.code).toBeDefined();
      const lat = Number(f.latitude);
      const lng = Number(f.longitude);
      expect(lat >= (bounds?.lat[0] ?? 0) && lat <= (bounds?.lat[1] ?? 0), f.code).toBe(true);
      expect(lng >= (bounds?.lng[0] ?? 0) && lng <= (bounds?.lng[1] ?? 0), f.code).toBe(true);
    }
  });
});
