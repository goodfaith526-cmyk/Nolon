import { HttpException } from '@nestjs/common';
import type { LocationDto, MarketingPriceDto, PriceCategoryDto } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  type BookingCountRow,
  buildSummary,
  monthlyRows,
  periodMonths,
  type RequestCountRow,
  routesOf,
} from './marketing-summary.js';

const price = (over: Partial<MarketingPriceDto>): MarketingPriceDto => ({
  originId: 'o1',
  destinationId: 'd1',
  mode: 'SEA',
  loadType: 'LCL',
  category: 'BARREL',
  unit: 'PER_BARREL',
  price: '100',
  minimumCharge: '0',
  currency: 'USD',
  validFrom: '2026-01-01',
  validTo: null,
  transitDays: null,
  ...over,
});

const place = (id: string): LocationDto => ({
  id,
  code: id.toUpperCase(),
  kind: 'CITY',
  nameEn: id,
  nameAr: id,
  countryCode: 'SD',
  isActive: true,
  cityId: null,
  shortCode: null,
});

const category = (code: string): PriceCategoryDto =>
  ({
    code,
    nameEn: code,
    nameAr: code,
    cargoType: 'GENERAL',
    defaultUnit: 'PER_PIECE',
  }) as PriceCategoryDto;

/** The body of the HttpException `run` throws. */
function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    if (e instanceof HttpException) return e.getResponse();
    throw e;
  }
  throw new Error('Expected a refusal');
}

describe('marketing summary period', () => {
  it('lists the calendar months from the first day to the last', () => {
    expect(periodMonths('2026-11-15', '2027-02-01')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(periodMonths('2026-03-05', '2026-03-05')).toEqual(['2026-03']);
  });

  it('allows 12 calendar months and refuses 13', () => {
    expect(periodMonths('2026-01-01', '2026-12-31')).toHaveLength(12);
    expect(periodMonths('2026-01-31', '2026-12-01')).toHaveLength(12);
    expect(refusal(() => periodMonths('2026-01-31', '2027-01-01'))).toMatchObject({
      code: 'RANGE_TOO_LONG',
    });
  });

  it('refuses a period that ends before it starts', () => {
    expect(refusal(() => periodMonths('2026-02-01', '2026-01-31'))).toMatchObject({
      code: 'BAD_RANGE',
    });
  });
});

describe('marketing summary routes', () => {
  it('groups the prices by route and mode with their load and shipment types', () => {
    const routes = routesOf([
      price({ category: 'CARTON', loadType: null }),
      price({ category: 'BARREL' }),
      price({ category: 'BARREL', loadType: 'FCL' }),
      price({ mode: 'ROAD', category: 'BARREL', loadType: null }),
    ]);
    expect(routes).toEqual([
      {
        originId: 'o1',
        destinationId: 'd1',
        mode: 'SEA',
        loadTypes: ['FCL', 'LCL'],
        categories: ['BARREL', 'CARTON'],
      },
      { originId: 'o1', destinationId: 'd1', mode: 'ROAD', loadTypes: [], categories: ['BARREL'] },
    ]);
  });
});

describe('marketing summary months', () => {
  const req = (over: Partial<RequestCountRow>): RequestCountRow => ({
    month: '2026-10',
    originId: 'o1',
    destinationId: 'd1',
    category: 'BARREL',
    source: 'bot',
    count: 1,
    ...over,
  });
  const booking = (over: Partial<BookingCountRow>): BookingCountRow => ({
    month: '2026-10',
    originId: 'o1',
    destinationId: 'd1',
    category: 'BARREL',
    fromRequest: false,
    status: 'CONFIRMED',
    count: 1,
    ...over,
  });

  it('adds bot, website and branch requests, and bookings by status', () => {
    const rows = monthlyRows(
      [req({ count: 3 }), req({ source: 'website', count: 2 })],
      [
        booking({ count: 4 }),
        booking({ status: 'COMPLETED' }),
        booking({ status: 'CANCELLED', count: 2 }),
        booking({ status: 'DRAFT' }),
        // A bot request's booking is a booking, not a second request.
        booking({ fromRequest: true, count: 5 }),
      ],
    );
    expect(rows).toEqual([
      {
        month: '2026-10',
        originId: 'o1',
        destinationId: 'd1',
        category: 'BARREL',
        requests: { total: 13, bot: 3, website: 2, branch: 8 },
        bookings: { confirmed: 10, cancelled: 2 },
      },
    ]);
  });

  it('keeps months, routes and types apart, unnamed ones last', () => {
    const rows = monthlyRows(
      [
        req({ month: '2026-11' }),
        req({ originId: null, destinationId: null, category: null }),
        req({ category: null }),
      ],
      [booking({ category: 'CARTON' })],
    );
    expect(rows.map((r) => [r.month, r.originId, r.category])).toEqual([
      ['2026-10', 'o1', 'CARTON'],
      ['2026-10', 'o1', null],
      ['2026-10', null, null],
      ['2026-11', 'o1', 'BARREL'],
    ]);
  });
});

describe('marketing summary', () => {
  const base = {
    from: '2026-09-10',
    to: '2026-11-03',
    pricesOn: '2026-11-04',
    months: ['2026-09', '2026-10', '2026-11'],
    locations: [place('o1'), place('d1'), place('o2'), place('unused')],
    categories: [category('BARREL'), category('CARTON'), category('UNUSED')],
    prices: [price({})],
    requests: [
      {
        month: '2026-10',
        originId: 'o2',
        destinationId: 'd1',
        category: 'CARTON',
        source: 'website' as const,
        count: 1,
      },
    ],
    bookings: [],
    newCustomers: new Map([['2026-10', 7]]),
  };

  it('leaves revenue out for a key without the revenue scope', () => {
    const summary = buildSummary({ ...base, revenue: null });
    expect(summary).not.toHaveProperty('revenue');
    expect(summary.newCustomers).toEqual([
      { month: '2026-09', count: 0 },
      { month: '2026-10', count: 7 },
      { month: '2026-11', count: 0 },
    ]);
    expect(summary.places.map((p) => p.id)).toEqual(['o1', 'd1', 'o2']);
    expect(summary.categories.map((c) => c.code)).toEqual(['BARREL', 'CARTON']);
  });

  it('gives revenue as decimal strings, net of credit notes, with no rounding through numbers', () => {
    const summary = buildSummary({
      ...base,
      revenue: [
        {
          month: '2026-10',
          originId: 'o1',
          destinationId: 'd1',
          currency: 'SDG',
          invoiced: dec('1234567890123.1234'),
          credited: dec('0.1234'),
        },
      ],
    });
    expect(summary.revenue).toEqual([
      {
        month: '2026-10',
        originId: 'o1',
        destinationId: 'd1',
        currency: 'SDG',
        invoiced: '1234567890123.1234',
        credited: '0.1234',
        net: '1234567890123',
      },
    ]);
  });

  it('names no customer: only places, types and numbers', () => {
    const summary = buildSummary({ ...base, revenue: null });
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/customerId|customerName|phone|NOL-CUS/);
  });
});
