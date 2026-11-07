import { describe, expect, it } from 'vitest';
import { contentsOf, kindOfNames } from './booking-review.service.js';

describe('the booking line description (trial BK00070)', () => {
  const kind = { ar: 'كراتين', en: 'Cartons' };

  it("takes the customer's own words for the contents first", () => {
    expect(contentsOf('  ملابس ', kind, 'ar')).toBe('ملابس');
  });

  it('else names the kind the customer gave, in the request language', () => {
    expect(contentsOf(null, kind, 'ar')).toBe('كراتين');
    expect(contentsOf('  ', kind, 'en')).toBe('Cartons');
    expect(contentsOf(null, kind, null)).toBe('كراتين');
  });

  it('is null when the bot sent neither, or a kind of another shape', () => {
    expect(contentsOf(null, null, 'ar')).toBeNull();
    expect(contentsOf(null, { ar: ' ', en: ' ' }, 'ar')).toBeNull();
    expect(contentsOf(null, 'كراتين', 'ar')).toBeNull();
    expect(contentsOf(null, { ar: 1 }, 'ar')).toBeNull();
  });

  it("reads a request by names' kind", () => {
    expect(kindOfNames({ origin: { ar: 'جدة', en: 'Jeddah' }, kind })).toEqual(kind);
    expect(kindOfNames(null)).toBeNull();
    expect(kindOfNames([kind])).toBeNull();
    expect(kindOfNames({ origin: kind })).toBeNull();
  });
});
