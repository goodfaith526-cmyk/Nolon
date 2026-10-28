import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Access } from '../access-control/access.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { AuditService } from '../audit/audit.service.js';
import type { CurrenciesService } from '../currencies/currencies.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CustomersService } from './customers.service.js';

function service() {
  const requireActive = vi.fn((code: string) =>
    code === 'USD' || code === 'SDG'
      ? Promise.resolve({ code })
      : Promise.reject(new BadRequestException(`Unknown or inactive currency: ${code}`)),
  );
  const customers = new CustomersService(
    {} as PrismaService,
    { requireActive } as unknown as CurrenciesService,
    {} as AuditService,
  );
  return { customers, requireActive };
}

describe('CustomersService.referenceChecker', () => {
  it('passes active currencies and a complete credit limit', async () => {
    const check = service().customers.referenceChecker();
    await expect(
      check({ preferredCurrency: 'SDG', creditLimit: '5000', creditLimitCurrency: 'USD' }),
    ).resolves.toEqual([]);
    await expect(check({})).resolves.toEqual([]);
  });

  it('reports unknown currencies and a credit limit without its currency', async () => {
    const check = service().customers.referenceChecker();
    expect(
      (await check({ preferredCurrency: 'XYZ', creditLimit: '10' })).map((i) => [i.field, i.code]),
    ).toEqual([
      ['preferredCurrency', 'UNKNOWN_CURRENCY'],
      ['creditLimitCurrency', 'CREDIT_LIMIT_PAIR'],
    ]);
    expect((await check({ creditLimitCurrency: 'ABC' })).map((i) => [i.field, i.code])).toEqual([
      ['creditLimit', 'CREDIT_LIMIT_PAIR'],
      ['creditLimitCurrency', 'UNKNOWN_CURRENCY'],
    ]);
  });

  it('asks the currency master once per code', async () => {
    const { customers, requireActive } = service();
    const check = customers.referenceChecker();
    for (let i = 0; i < 20; i++) await check({ preferredCurrency: 'USD' });
    expect(requireActive).toHaveBeenCalledTimes(1);
  });
});

describe('CustomersService.duplicateIssues', () => {
  const held = [
    {
      id: 'c1',
      branchId: 'b1',
      number: 'CS00001',
      phone: '+249900000001',
      taxNumber: 'TX-1',
      acquiredViaOutletId: 'o1',
    },
  ];
  const staff = (allowedOutletIds?: string[]): AuthUser => ({
    id: 'u',
    email: 'u@nolon.example',
    fullName: 'U',
    preferredLocale: 'ar',
    sessionId: 's',
    credentialStamp: 'c',
    roles: allowedOutletIds ? ['OUTLET_STAFF'] : ['SALES'],
    access: Access.uniform([], ['b1']),
    allBranches: false,
    allowedBranchIds: ['b1'],
    ...(allowedOutletIds && { allowedOutletIds }),
  });
  const client = {
    customer: { findMany: vi.fn(() => Promise.resolve(held)) },
  } as unknown as Prisma.TransactionClient;

  it('reports a phone or tax number (any case and spacing) another customer of the branch holds', async () => {
    const issues = await service().customers.duplicateIssues(
      client,
      [
        { branchId: 'b1', phone: '+249900000001' },
        { branchId: 'b1', phone: '+249900000002', taxNumber: ' tx-1 ' },
        { branchId: 'b2', phone: '+249900000001', taxNumber: 'TX-1' },
        { branchId: 'b1', phone: '+249900000001', taxNumber: 'TX-1', excludeId: 'c1' },
      ],
      staff(),
    );
    expect(issues.map((list) => list.map((i) => [i.field, i.code]))).toEqual([
      [['phone', 'DUPLICATE_IN_DB']],
      [['taxNumber', 'DUPLICATE_IN_DB']],
      [],
      [],
    ]);
    expect(issues[0]?.[0]?.message).toContain('CS00001');
  });

  it('names the holder to Outlet Staff of its outlet only; to others it is "another customer"', async () => {
    const keys = [{ branchId: 'b1', phone: '+249900000001', taxNumber: 'TX-1' }];
    const own = await service().customers.duplicateIssues(client, keys, staff(['o1']));
    expect(own[0]?.map((i) => i.message)).toEqual([
      'Customer CS00001 of this branch has this phone',
      'Customer CS00001 of this branch has this tax number',
    ]);
    const other = await service().customers.duplicateIssues(client, keys, staff(['o2']));
    expect(other[0]?.map((i) => [i.field, i.code, i.message])).toEqual([
      ['phone', 'DUPLICATE_IN_DB', 'Another customer of this branch has this phone'],
      ['taxNumber', 'DUPLICATE_IN_DB', 'Another customer of this branch has this tax number'],
    ]);
    expect(JSON.stringify(other)).not.toContain('CS00001');
  });
});
