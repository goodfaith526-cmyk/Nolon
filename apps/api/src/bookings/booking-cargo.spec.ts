import { describe, expect, it } from 'vitest';
import { bookingCargoHeader, type BookingCargo } from './booking-cargo.js';

const container = { cargoType: 'CONTAINER' as const };
const pallet = { cargoType: 'PALLET' as const };
const barrel = { cargoType: 'BARREL' as const };

const lines = (mode: BookingCargo['mode'], items: BookingCargo['items']) => ({ mode, items });
const saved = (fields: Partial<BookingCargo>): BookingCargo => ({
  mode: 'SEA',
  loadType: null,
  cargoType: null,
  cargoDescription: null,
  items: [],
  ...fields,
});

describe('bookingCargoHeader on a new booking', () => {
  it('keeps what is given', () => {
    expect(
      bookingCargoHeader({
        ...lines('SEA', [{ ...container, description: 'Cars' }]),
        loadType: 'LCL',
        cargoType: 'BARREL',
        cargoDescription: 'Chemicals',
      }),
    ).toEqual({ loadType: 'LCL', cargoType: 'BARREL', cargoDescription: 'Chemicals' });
  });

  it("takes the first line's cargo type, and FCL when a line is a container, else LCL", () => {
    expect(bookingCargoHeader(lines('SEA', [pallet, container]))).toMatchObject({
      cargoType: 'PALLET',
      loadType: 'FCL',
    });
    expect(bookingCargoHeader(lines('SEA_ROAD', [pallet, barrel]))).toMatchObject({
      cargoType: 'PALLET',
      loadType: 'LCL',
    });
  });

  it('gives no FCL/LCL to a road booking, and nothing without lines', () => {
    expect(bookingCargoHeader(lines('ROAD', [container]))).toMatchObject({ loadType: null });
    expect(bookingCargoHeader(lines('SEA', []))).toEqual({
      loadType: null,
      cargoType: null,
      cargoDescription: null,
    });
  });

  it('passes a road load type given through, for the sea-only check to refuse', () => {
    expect(bookingCargoHeader({ ...lines('ROAD', []), loadType: 'FCL' })).toMatchObject({
      loadType: 'FCL',
    });
  });

  it("joins the lines' descriptions, each once, in line order, within 2000 characters", () => {
    expect(
      bookingCargoHeader(
        lines('SEA', [
          { ...pallet, description: ' Tyres ' },
          { ...barrel, description: null },
          { ...pallet, description: 'Oil' },
          { ...pallet, description: 'Tyres' },
          { ...pallet, description: '  ' },
        ]),
      ).cargoDescription,
    ).toBe('Tyres\nOil');
    const long = Array.from({ length: 10 }, (_, n) => ({
      ...pallet,
      description: `${n}`.repeat(500),
    }));
    expect(bookingCargoHeader(lines('SEA', long)).cargoDescription).toHaveLength(2000);
  });
});

describe('bookingCargoHeader on an edit that leaves the header out (Codex F91-1..4)', () => {
  it('follows the lines when the saved header followed them', () => {
    const stored = saved({
      loadType: 'LCL',
      cargoType: 'PALLET',
      cargoDescription: 'Tyres',
      items: [{ ...pallet, description: 'Tyres' }],
    });
    expect(
      bookingCargoHeader(lines('SEA', [{ ...container, description: 'Cars' }]), stored),
    ).toEqual({ loadType: 'FCL', cargoType: 'CONTAINER', cargoDescription: 'Cars' });
    // Untouched, it stays as saved.
    expect(bookingCargoHeader(lines('SEA', stored.items), stored)).toEqual({
      loadType: 'LCL',
      cargoType: 'PALLET',
      cargoDescription: 'Tyres',
    });
  });

  it('keeps an FCL/LCL saved apart from the lines (F91-2)', () => {
    const lcl = saved({ loadType: 'LCL', cargoType: 'CONTAINER', items: [container] });
    expect(bookingCargoHeader(lines('SEA', [container]), lcl).loadType).toBe('LCL');
    const fcl = saved({ loadType: 'FCL', cargoType: 'PALLET', items: [pallet] });
    expect(bookingCargoHeader(lines('SEA_ROAD', [pallet, barrel]), fcl).loadType).toBe('FCL');
    // A road booking has none, whatever was saved.
    expect(bookingCargoHeader(lines('ROAD', [pallet]), fcl).loadType).toBeNull();
  });

  it("keeps a general description saved apart from the lines', whole (F91-1, F91-3)", () => {
    const general = 'x'.repeat(2000);
    const stored = saved({
      cargoType: 'PALLET',
      cargoDescription: general,
      items: [{ ...pallet, description: 'Line-level detail' }, pallet],
    });
    expect(
      bookingCargoHeader(
        lines('SEA', [{ ...pallet, description: 'Line-level detail' }, pallet]),
        stored,
      ).cargoDescription,
    ).toBe(general);
    // With no line described, the saved one stays too.
    const undescribed = saved({ cargoType: 'PALLET', cargoDescription: 'Legacy', items: [pallet] });
    expect(bookingCargoHeader(lines('SEA', [pallet]), undescribed).cargoDescription).toBe('Legacy');
  });

  it('keeps the cargo type of a booking with no lines (F91-4)', () => {
    const headerOnly = saved({ loadType: 'LCL', cargoType: 'GENERAL' });
    expect(bookingCargoHeader(lines('SEA', []), headerOnly)).toEqual({
      loadType: 'LCL',
      cargoType: 'GENERAL',
      cargoDescription: null,
    });
  });

  it('keeps saved nulls the lines would fill (F91-5)', () => {
    const items = [container, { ...pallet, description: 'Line detail' }];
    const stored = saved({ cargoType: 'CONTAINER', items });
    expect(bookingCargoHeader(lines('SEA', items), stored)).toEqual({
      loadType: null,
      cargoType: 'CONTAINER',
      cargoDescription: null,
    });
    // Saved apart from the lines, they stay apart when the lines change.
    expect(bookingCargoHeader(lines('SEA', [pallet]), stored)).toMatchObject({
      loadType: null,
      cargoDescription: null,
    });
  });

  it('clears an FCL/LCL or description given as null (F91-6)', () => {
    const stored = saved({
      loadType: 'LCL',
      cargoType: 'PALLET',
      cargoDescription: 'Remove this description',
      items: [pallet],
    });
    expect(
      bookingCargoHeader(
        { ...lines('SEA', [pallet]), loadType: null, cargoDescription: null },
        stored,
      ),
    ).toEqual({ loadType: null, cargoType: 'PALLET', cargoDescription: null });
    // A booking has a cargo type: null is taken as left out.
    expect(bookingCargoHeader({ ...lines('SEA', [barrel]), cargoType: null }).cargoType).toBe(
      'BARREL',
    );
  });

  it('still takes a value given over the saved one', () => {
    const stored = saved({ loadType: 'LCL', cargoType: 'CONTAINER', items: [container] });
    expect(
      bookingCargoHeader({ ...lines('SEA', [container]), loadType: 'FCL' }, stored).loadType,
    ).toBe('FCL');
  });
});
