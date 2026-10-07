import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  beforeLocalToday,
  branchPeriodFields,
  dateRange,
  localDayRange,
  nextDay,
  optionalFlag,
  periodInOrder,
  periodsInOrder,
  startOfDayIn,
} from './list-filters.js';
import { pageQuery, withoutLocale } from './validation.js';

const zones = [
  { id: 'dxb', timezone: 'Asia/Dubai' },
  { id: 'krt', timezone: 'Africa/Khartoum' },
];

describe('list queries', () => {
  const listQuery = pageQuery
    .extend({ ...branchPeriodFields, etaFrom: z.string().optional(), etaTo: z.string().optional() })
    .superRefine(periodsInOrder(['from', 'to'], ['etaFrom', 'etaTo']));

  it('reject unknown keys, also when extended and refined', () => {
    expect(pageQuery.safeParse({ pageSize: '10', bogus: 'x' }).success).toBe(false);
    expect(listQuery.safeParse({ from: '2026-01-01', branch: 'x' }).success).toBe(false);
    expect(listQuery.safeParse({ from: '2026-01-01', to: '2026-01-31' }).success).toBe(true);
  });

  it('refuse a period whose start is after its end, on the end field', () => {
    const result = listQuery.safeParse({ from: '2026-02-01', to: '2026-01-31' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['to']);
    expect(listQuery.safeParse({ etaFrom: '2026-02-02', etaTo: '2026-02-01' }).success).toBe(false);
    expect(listQuery.safeParse({ from: '2026-02-01', to: '2026-02-01' }).success).toBe(true);
    expect(listQuery.safeParse({ to: '2026-02-01' }).success).toBe(true);
    const plain = pageQuery.extend(branchPeriodFields).superRefine(periodInOrder);
    expect(plain.safeParse({ from: '2026-03-01', to: '2026-02-01' }).success).toBe(false);
  });

  it('check dates and branch ids', () => {
    expect(listQuery.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(listQuery.safeParse({ branchId: 'DXB' }).success).toBe(false);
  });

  it('read an optional flag as true, false or no filter', () => {
    expect(optionalFlag.parse('true')).toBe(true);
    expect(optionalFlag.parse('false')).toBe(false);
    expect(optionalFlag.parse(undefined)).toBeUndefined();
    expect(optionalFlag.safeParse('yes').success).toBe(false);
  });

  it('drop only the locale of an export query', () => {
    expect(withoutLocale({ from: '2026-01-01', locale: 'ar' })).toEqual({ from: '2026-01-01' });
    expect(withoutLocale(undefined)).toBeUndefined();
  });
});

describe('date filters', () => {
  it('a DATE period includes both ends; no period is no filter', () => {
    expect(dateRange('2026-01-01', '2026-01-31')).toEqual({
      gte: new Date('2026-01-01T00:00:00Z'),
      lte: new Date('2026-01-31T00:00:00Z'),
    });
    expect(dateRange(undefined, '2026-01-31')).toEqual({ lte: new Date('2026-01-31T00:00:00Z') });
    expect(dateRange()).toBeUndefined();
  });

  it('the next day crosses months and leap days', () => {
    expect(nextDay('2026-01-31')).toBe('2026-02-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });

  it('a day starts at local midnight of the time zone', () => {
    expect(startOfDayIn('2026-03-10', 'Asia/Dubai').toISOString()).toBe('2026-03-09T20:00:00.000Z');
    expect(startOfDayIn('2026-03-10', 'Africa/Khartoum').toISOString()).toBe(
      '2026-03-09T22:00:00.000Z',
    );
    expect(startOfDayIn('2026-03-10', 'UTC').toISOString()).toBe('2026-03-10T00:00:00.000Z');
    // Across a daylight saving change: New York is UTC-4 on 2026-03-09 (DST began on the 8th).
    expect(startOfDayIn('2026-03-09', 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
    expect(startOfDayIn('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('a timestamp period is the local days of each branch, the end day included', () => {
    expect(localDayRange(zones, 'createdAt', '2026-03-10', '2026-03-10')).toEqual({
      OR: [
        {
          branchId: 'dxb',
          createdAt: {
            gte: new Date('2026-03-09T20:00:00Z'),
            lt: new Date('2026-03-10T20:00:00Z'),
          },
        },
        {
          branchId: 'krt',
          createdAt: {
            gte: new Date('2026-03-09T22:00:00Z'),
            lt: new Date('2026-03-10T22:00:00Z'),
          },
        },
      ],
    });
    expect(localDayRange(zones, 'createdAt')).toBeUndefined();
    expect(localDayRange(zones, 'plannedDeparture', '2026-03-10')).toEqual({
      OR: [
        { branchId: 'dxb', plannedDeparture: { gte: new Date('2026-03-09T20:00:00Z') } },
        { branchId: 'krt', plannedDeparture: { gte: new Date('2026-03-09T22:00:00Z') } },
      ],
    });
  });

  it("overdue is before today in each branch's time zone", () => {
    // 21:00 UTC on 9 March is already 10 March in Dubai, still 9 March in Khartoum (23:00).
    const now = new Date('2026-03-09T21:00:00Z');
    expect(beforeLocalToday(zones, 'dueDate', now)).toEqual({
      OR: [
        { branchId: 'dxb', dueDate: { lt: new Date('2026-03-10T00:00:00Z') } },
        { branchId: 'krt', dueDate: { lt: new Date('2026-03-09T00:00:00Z') } },
      ],
    });
  });
});
