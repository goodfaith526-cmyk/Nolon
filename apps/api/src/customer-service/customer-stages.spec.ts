import { describe, expect, it } from 'vitest';
import { SHIPMENT_STATUSES } from '@nolon/shared';
import { type PlaceRow, type StageRow, type TrackInput, trackOf } from './customer-stages.js';

const stage = (code: string, sortOrder: number, isActive = true): StageRow => ({
  code,
  nameAr: `ع ${code}`,
  nameEn: `E ${code}`,
  sortOrder,
  isActive,
});
const stages = new Map(
  ['BOOKED', 'CONFIRMED', 'AT_ORIGIN_HUB', 'AT_SEA', 'ON_ROAD', 'DELIVERED'].map((c, i) => [
    c,
    stage(c, i + 1),
  ]),
);
const mapping = new Map([
  ['CREATED', 'CONFIRMED'],
  ['RECEIVED_ORIGIN_WAREHOUSE', 'AT_ORIGIN_HUB'],
  ['DEPARTED', 'AT_SEA'],
  ['ROAD_DEPARTED', 'ON_ROAD'],
  ['DELIVERED', 'DELIVERED'],
]);
const city = (en: string): PlaceRow => ({ kind: 'CITY', nameAr: en, nameEn: en, city: null });
const port: PlaceRow = {
  kind: 'PORT',
  nameAr: 'ميناء',
  nameEn: 'Port',
  city: { nameAr: 'جدة', nameEn: 'Jeddah' },
};
const at = new Date('2026-11-03T00:00:00Z');
function approved(bookingStatus: string, status: string | null): TrackInput {
  return {
    state: 'approved',
    booking: {
      status: bookingStatus,
      shipment:
        status === null
          ? null
          : {
              number: 'BK00001',
              status,
              destination: city('Khartoum'),
              currentLocation: port,
              updatedAt: at,
            },
    },
  };
}

describe('trackOf (plan 09 section 3)', () => {
  it('is BOOKED while undecided, and while the approved booking is a draft (F161-2)', () => {
    for (const state of ['pending', 'awaiting_routing'] as const) {
      expect(trackOf({ state, booking: null }, stages, mapping).stage?.code).toBe('BOOKED');
    }
    const draft = trackOf(approved('DRAFT', null), stages, mapping);
    expect(draft).toMatchObject({ stage: { code: 'BOOKED' }, attention: null, shipment: null });
  });

  it('has no stage once rejected, cancelled or expired', () => {
    for (const state of ['rejected', 'cancelled', 'expired'] as const) {
      expect(trackOf({ state, booking: null }, stages, mapping)).toEqual({
        stage: null,
        attention: null,
        shipment: null,
      });
    }
  });

  it('sends a cancelled booking to staff, never "confirmed"', () => {
    expect(trackOf(approved('CANCELLED', null), stages, mapping)).toEqual({
      stage: null,
      attention: 'staff',
      shipment: null,
    });
  });

  it('shows the confirmed shipment’s mapped stage, with where it was last seen', () => {
    const track = trackOf(approved('CONFIRMED', 'RECEIVED_ORIGIN_WAREHOUSE'), stages, mapping);
    expect(track).toEqual({
      stage: { code: 'AT_ORIGIN_HUB', ar: 'ع AT_ORIGIN_HUB', en: 'E AT_ORIGIN_HUB', order: 3 },
      attention: null,
      shipment: {
        number: 'BK00001',
        stage: track.stage,
        city: { ar: 'جدة', en: 'Jeddah' },
        updatedAt: at.toISOString(),
      },
    });
  });

  it('names the destination city on the road and after', () => {
    for (const status of ['ROAD_DEPARTED', 'DELIVERED']) {
      expect(trackOf(approved('CONFIRMED', status), stages, mapping).shipment?.city).toEqual({
        ar: 'Khartoum',
        en: 'Khartoum',
      });
    }
  });

  it('sends every unmapped status (on hold, cancelled, partly delivered) to staff', () => {
    for (const status of SHIPMENT_STATUSES.filter((s) => !mapping.has(s))) {
      const track = trackOf(approved('CONFIRMED', status), stages, mapping);
      expect(track.stage).toBeNull();
      expect(track.attention).toBe('staff');
      expect(track.shipment?.number).toBe('BK00001');
      expect(track.shipment?.city).toBeNull();
    }
  });

  it('treats an inactive stage as no stage, whatever its order', () => {
    const off = new Map(stages);
    off.set('AT_SEA', stage('AT_SEA', 0, false));
    expect(trackOf(approved('CONFIRMED', 'DEPARTED'), off, mapping).attention).toBe('staff');
  });

  it('keeps on hold, partly delivered and cancelled with staff even when mapped (F164-1)', () => {
    for (const status of ['ON_HOLD', 'PARTIALLY_DELIVERED', 'CANCELLED']) {
      const mapped = new Map([...mapping, [status, 'DELIVERED']]);
      expect(trackOf(approved('CONFIRMED', status), stages, mapped)).toMatchObject({
        stage: null,
        attention: 'staff',
        shipment: { number: 'BK00001', stage: null, city: null },
      });
    }
  });
});
