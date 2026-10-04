import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { type ShipmentAmounts, byCustomer, byRoute, profitFigures } from './profitability.js';

const place = (id: string) => ({ id, code: id.toUpperCase(), nameEn: id, nameAr: id });

function shipment(
  customer: string,
  from: string,
  to: string,
  revenue: string,
  cost: string,
): ShipmentAmounts {
  return {
    customerId: customer,
    customerName: `Customer ${customer}`,
    origin: place(from),
    destination: place(to),
    revenueUsd: dec(revenue),
    costUsd: dec(cost),
  };
}

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
});
