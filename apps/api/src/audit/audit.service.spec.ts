import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { changedFields, codeEntityId } from './audit.service.js';

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

describe('codeEntityId', () => {
  it('is the RFC 9562 version 5 uuid of the entity and code (as Python uuid.uuid5 computes it)', () => {
    expect(codeEntityId('CURRENCY', 'USD')).toBe('189704f0-fd18-5d0c-b291-8459a4215eb6');
  });

  it('is the same for the same entry and differs between entries and between masters', () => {
    const id = codeEntityId('CONTAINER_TYPE', '20GP');
    expect(codeEntityId('CONTAINER_TYPE', '20GP')).toBe(id);
    expect(codeEntityId('CONTAINER_TYPE', '40GP')).not.toBe(id);
    expect(codeEntityId('CHARGE_TYPE', '20GP')).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
