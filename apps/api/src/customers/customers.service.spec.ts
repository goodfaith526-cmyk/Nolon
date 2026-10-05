import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrenciesService } from '../currencies/currencies.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
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
