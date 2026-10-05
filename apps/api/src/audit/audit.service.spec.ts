import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { changedFields } from './audit.service.js';

describe('changedFields', () => {
  it('lists every set field of a new record, in the given order', () => {
    expect(
      changedFields(null, { name: 'A', price: new Prisma.Decimal('2300.50'), notes: null }, [
        'price',
        'name',
        'notes',
      ]),
    ).toEqual([
      { field: 'price', before: null, after: '2300.5' },
      { field: 'name', before: null, after: 'A' },
    ]);
  });

  it('compares decimals by value, dates by day and lists in any order', () => {
    const before = {
      price: new Prisma.Decimal('2300.00'),
      validFrom: new Date('2026-10-01T00:00:00Z'),
      roles: ['SALES', 'OPERATIONS'],
      isActive: true,
    };
    const after = {
      price: new Prisma.Decimal('2300'),
      validFrom: new Date('2026-10-01T00:00:00Z'),
      roles: ['OPERATIONS', 'SALES'],
      isActive: false,
    };
    expect(changedFields(before, after, ['price', 'validFrom', 'roles', 'isActive'])).toEqual([
      { field: 'isActive', before: 'true', after: 'false' },
    ]);
  });

  it('records a cleared field with an empty after', () => {
    expect(
      changedFields<{ notes: string | null }>({ notes: 'Peak' }, { notes: null }, ['notes']),
    ).toEqual([{ field: 'notes', before: 'Peak', after: null }]);
  });
});
