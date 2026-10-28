import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  type ShipmentAmounts,
  byCategory,
  byCustomer,
  byOriginCountry,
  byOutlet,
  byRoute,
  cycleTime,
  daysBetween,
  incompleteReasons,
  marginPerUnit,
  missingCosts,
  profitFigures,
  shipmentCategory,
  totalOf,
  tripService,
} from './profitability.js';

const place = (id: string) => ({ id, code: id.toUpperCase(), nameEn: id, nameAr: id });

function shipment(
  customer: string,
  from: string,
  to: string,
  revenue: string,
  cost: string,
  extra: Partial<ShipmentAmounts> = {},
): ShipmentAmounts {
  return {
    customerId: customer,
    customerName: `Customer ${customer}`,
    origin: place(from),
    destination: place(to),
    revenueUsd: dec(revenue),
    costUsd: dec(cost),
    salesOutlet: null,
    originCountry: { code: 'SA', nameEn: 'Saudi Arabia', nameAr: 'السعودية' },
    category: { kind: 'UNSPECIFIED' },
    unit: null,
    units: null,
    incompleteReasons: [],
    missingCosts: [],
    cycleDays: null,
    ...extra,
  };
}

const carton = { code: 'CARTON', nameEn: 'Carton', nameAr: 'كرتون' };
const barrel = { code: 'BARREL', nameEn: 'Barrel', nameAr: 'برميل' };

describe('shipment profitability', () => {
  it('margin is revenue - cost; the percentage is of revenue, to 2 places', () => {
    expect(profitFigures({ revenueUsd: dec('1500'), costUsd: dec('1000.5') })).toEqual({
      revenueUsd: '1500',
      costUsd: '1000.5',
      marginUsd: '499.5',
      marginPercent: '33.3',
    });
    // 1 / 3 = 33.333...% rounds half up to 33.33; a loss is negative.
    expect(profitFigures({ revenueUsd: dec('3'), costUsd: dec('2') }).marginPercent).toBe('33.33');
    expect(profitFigures({ revenueUsd: dec('200'), costUsd: dec('250') })).toMatchObject({
      marginUsd: '-50',
      marginPercent: '-25',
    });
  });

  it('has no percentage without revenue', () => {
    expect(profitFigures({ revenueUsd: dec('0'), costUsd: dec('80') })).toEqual({
      revenueUsd: '0',
      costUsd: '80',
      marginUsd: '-80',
      marginPercent: null,
    });
  });

  it('rolls shipments up per customer and per route', () => {
    const list = [
      shipment('a', 'pzu', 'krt', '1000', '400'),
      shipment('b', 'pzu', 'krt', '500', '600'),
      shipment('a', 'jed', 'pzu', '0.1', '0.2'),
    ];
    const customers = byCustomer(list);
    expect(customers.map((c) => [c.key.customerId, c.shipments, profitFigures(c)])).toEqual([
      [
        'a',
        2,
        { revenueUsd: '1000.1', costUsd: '400.2', marginUsd: '599.9', marginPercent: '59.98' },
      ],
      ['b', 1, { revenueUsd: '500', costUsd: '600', marginUsd: '-100', marginPercent: '-20' }],
    ]);
    const routes = byRoute(list);
    expect(
      routes.map((r) => [
        r.key.origin.code,
        r.key.destination.code,
        r.shipments,
        r.revenueUsd.toFixed(),
      ]),
    ).toEqual([
      ['PZU', 'KRT', 2, '1500'],
      ['JED', 'PZU', 1, '0.1'],
    ]);
  });

  it('puts a shipment in one category column, never split', () => {
    expect(shipmentCategory([{ category: carton }, { category: carton }])).toEqual({
      kind: 'SINGLE',
      ...carton,
    });
    expect(shipmentCategory([{ category: carton }, { category: barrel }])).toEqual({
      kind: 'MIXED',
    });
    // A line without a category beats a mix: the shipment is unspecified.
    expect(
      shipmentCategory([{ category: carton }, { category: barrel }, { category: null }]),
    ).toEqual({ kind: 'UNSPECIFIED' });
    expect(shipmentCategory([])).toEqual({ kind: 'UNSPECIFIED' });
  });

  it('adds the category columns up to the totals exactly, with a margin per unit for one unit', () => {
    const single = { kind: 'SINGLE' as const, ...carton };
    const list = [
      shipment('a', 'jed', 'pzu', '1000', '400', {
        category: single,
        unit: 'PER_PIECE',
        units: dec(10),
      }),
      shipment('b', 'jed', 'pzu', '500', '200', {
        category: single,
        unit: 'PER_PIECE',
        units: dec(5),
      }),
      shipment('c', 'jed', 'pzu', '300', '0', { category: { kind: 'MIXED' } }),
      // A reversal leaves a negative revenue on a shipment: it still counts in its column.
      shipment('d', 'jed', 'pzu', '-50', '10', { incompleteReasons: ['NOT_CLOSED'] }),
    ];
    const columns = byCategory(list);
    const total = totalOf(list);
    const added = columns.reduce((a, c) => a.plus(c.revenueUsd.minus(c.costUsd)), dec(0));
    expect(added.toFixed()).toBe(total.revenueUsd.minus(total.costUsd).toFixed());
    expect(columns.reduce((a, c) => a + c.shipments, 0)).toBe(4);
    const cartons = columns.find((c) => c.key.category.kind === 'SINGLE');
    expect(cartons?.units?.toFixed()).toBe('15');
    // (1500 - 600) / 15 = 60.
    expect(marginPerUnit(cartons ?? total, cartons?.units ?? null)).toBe('60');
    const mixed = columns.find((c) => c.key.category.kind === 'MIXED');
    expect(mixed?.units).toBeNull();
    expect(total.incompleteShipments).toBe(1);

    // One carton shipment without its units: no margin per unit for the column.
    const partial = byCategory([
      ...list,
      shipment('e', 'jed', 'pzu', '1', '0', { category: single, unit: 'PER_PIECE', units: null }),
    ]);
    expect(partial.find((c) => c.key.category.kind === 'SINGLE')?.units).toBeNull();
  });

  it('rolls up by outlet (none together) and by origin country', () => {
    const outlet = { id: 'o1', name: 'Outlet 1' };
    const list = [
      shipment('a', 'jed', 'pzu', '100', '50', { salesOutlet: outlet }),
      shipment('b', 'jed', 'pzu', '100', '50', { salesOutlet: outlet }),
      shipment('c', 'dxb', 'pzu', '100', '50', {
        originCountry: { code: 'AE', nameEn: 'UAE', nameAr: 'الإمارات' },
      }),
    ];
    expect(byOutlet(list).map((g) => [g.key.salesOutlet?.id ?? null, g.shipments])).toEqual([
      ['o1', 2],
      [null, 1],
    ]);
    expect(byOriginCountry(list).map((g) => [g.key.originCountry.code, g.shipments])).toEqual([
      ['SA', 2],
      ['AE', 1],
    ]);
  });

  it('lists each booked service no cost covers yet', () => {
    // A storage bill alone does not cover the freight (Codex F134-1).
    expect(missingCosts(['MAIN_FREIGHT', 'WAREHOUSE'], ['WAREHOUSE'])).toEqual(['MAIN_FREIGHT']);
    expect(missingCosts(['MAIN_FREIGHT'], ['MAIN_FREIGHT', null])).toEqual([]);
    // A cost line with no service covers nothing.
    expect(missingCosts(['CUSTOMS'], [null])).toEqual(['CUSTOMS']);
    expect(missingCosts([], [])).toEqual([]);
  });

  it('maps each trip to the one service its ends prove (Codex F134-4)', () => {
    const route = { from: 'jed', to: 'krt' };
    // The main haul of a road shipment is its freight; it proves no pickup or last mile.
    const haul = tripService('ROAD', route, { from: 'jed', to: 'krt' });
    expect(haul).toBe('MAIN_FREIGHT');
    expect(missingCosts(['MAIN_FREIGHT', 'PICKUP', 'LAST_MILE'], [haul])).toEqual([
      'PICKUP',
      'LAST_MILE',
    ]);
    // In town at the origin, or from elsewhere to it: pickup. Out of the destination: last mile.
    expect(tripService('ROAD', route, { from: 'jed', to: 'jed' })).toBe('PICKUP');
    expect(tripService('ROAD', route, { from: 'mak', to: 'jed' })).toBe('PICKUP');
    expect(tripService('ROAD', route, { from: 'krt', to: 'krt' })).toBe('LAST_MILE');
    expect(tripService('ROAD', route, { from: 'krt', to: 'omd' })).toBe('LAST_MILE');
    // By sea the road haul is the inland leg, never the freight.
    expect(tripService('SEA_ROAD', route, { from: 'pzu', to: 'krt' })).toBe('INLAND_TRANSPORT');
    expect(tripService('SEA', route, { from: 'jed', to: 'krt' })).toBe('INLAND_TRANSPORT');
    // A trip back from the destination to the origin, or any trip of a shipment within one
    // city, proves nothing.
    expect(tripService('ROAD', route, { from: 'krt', to: 'jed' })).toBeNull();
    expect(tripService('ROAD', { from: 'krt', to: 'krt' }, { from: 'krt', to: 'krt' })).toBeNull();
  });

  it('marks figures that are not final, with each reason', () => {
    expect(
      incompleteReasons({ missingCosts: ['CUSTOMS'], openAccrual: true, status: 'DELIVERED' }),
    ).toEqual(['MISSING_COST', 'OPEN_ACCRUAL', 'NOT_CLOSED']);
    expect(incompleteReasons({ missingCosts: [], openAccrual: false, status: 'CLOSED' })).toEqual(
      [],
    );
    expect(
      incompleteReasons({ missingCosts: [], openAccrual: false, status: 'CANCELLED' }),
    ).toEqual([]);
  });

  it('gives the cycle time over the measured shipments only', () => {
    const day = (d: string) => new Date(`2026-10-${d}T00:00:00Z`);
    const a = daysBetween(day('01'), day('11'));
    const b = daysBetween(day('01'), new Date('2026-10-04T12:00:00Z'));
    expect(cycleTime([a, b, null])).toEqual({
      measured: 2,
      averageDays: '6.8',
      minDays: '3.5',
      maxDays: '10',
    });
    expect(cycleTime([null])).toEqual({
      measured: 0,
      averageDays: null,
      minDays: null,
      maxDays: null,
    });
  });
});
