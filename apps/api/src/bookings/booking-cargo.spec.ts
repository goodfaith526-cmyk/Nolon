import { describe, expect, it } from 'vitest';
import { bookingCargoDescription, bookingCargoType, bookingLoadType } from './booking-cargo.js';

const container = { cargoType: 'CONTAINER' as const };
const pallet = { cargoType: 'PALLET' as const };
const barrel = { cargoType: 'BARREL' as const };

describe('bookingCargoType', () => {
  it('keeps the one given', () => {
    expect(bookingCargoType('BARREL', [container])).toBe('BARREL');
  });

  it("takes the first line's when none is given", () => {
    expect(bookingCargoType(undefined, [pallet, container])).toBe('PALLET');
    expect(bookingCargoType(null, [container])).toBe('CONTAINER');
  });

  it('is null with neither', () => {
    expect(bookingCargoType(undefined, [])).toBeNull();
  });
});

describe('bookingLoadType', () => {
  it('keeps the one given', () => {
    expect(bookingLoadType('SEA', 'LCL', [container])).toBe('LCL');
  });

  it('is FCL when a line is a container, else LCL, for any mode with a sea leg', () => {
    expect(bookingLoadType('SEA', undefined, [container])).toBe('FCL');
    expect(bookingLoadType('SEA_ROAD', null, [pallet, container])).toBe('FCL');
    expect(bookingLoadType('SEA', undefined, [pallet, barrel])).toBe('LCL');
    expect(bookingLoadType('SEA_ROAD', undefined, [barrel])).toBe('LCL');
  });

  it('is null for a road booking or with no lines', () => {
    expect(bookingLoadType('ROAD', undefined, [container])).toBeNull();
    expect(bookingLoadType('SEA', undefined, [])).toBeNull();
  });

  it('passes a road load type through for the sea-only check to refuse', () => {
    expect(bookingLoadType('ROAD', 'FCL', [])).toBe('FCL');
  });
});

describe('bookingCargoDescription', () => {
  it('keeps the one given', () => {
    expect(bookingCargoDescription('Spare parts', [{ ...pallet, description: 'Tyres' }])).toBe(
      'Spare parts',
    );
  });

  it("joins the lines' descriptions, each once, in line order", () => {
    expect(
      bookingCargoDescription(undefined, [
        { ...pallet, description: ' Tyres ' },
        { ...barrel, description: null },
        { ...pallet, description: 'Oil' },
        { ...pallet, description: 'Tyres' },
        { ...pallet, description: '  ' },
      ]),
    ).toBe('Tyres\nOil');
  });

  it('is null when no line describes the goods', () => {
    expect(bookingCargoDescription(null, [pallet])).toBeNull();
  });

  it('stays within the 2000 characters the API takes', () => {
    const lines = Array.from({ length: 10 }, (_, n) => ({
      ...pallet,
      description: `${n}`.repeat(500),
    }));
    expect(bookingCargoDescription(undefined, lines)).toHaveLength(2000);
  });
});
