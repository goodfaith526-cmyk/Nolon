import { BadRequestException } from '@nestjs/common';
import type { RateCardInput } from '@nolon/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CurrenciesService } from '../currencies/currencies.service.js';
import type { MasterDataService } from '../master-data/master-data.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { RatesService, rateKey } from './rates.service.js';

const JEA = '00000000-0000-4000-8000-000000000001';
const PZU = '00000000-0000-4000-8000-000000000002';
const OLD = '00000000-0000-4000-8000-000000000003';

function service() {
  const refuse = (message: string) => Promise.reject(new BadRequestException(message));
  const requireLocation = vi.fn((id: string) =>
    id === OLD ? refuse('Unknown or inactive location') : Promise.resolve({ id }),
  );
  const masterData = {
    requireLocation,
    requireRoute: vi.fn(async (o: string, d: string) => {
      if (o === d) return refuse('Origin and destination must differ');
      await requireLocation(o);
      await requireLocation(d);
    }),
    requireContainerType: vi.fn((code: string) =>
      code === '40HC'
        ? Promise.resolve({ code })
        : refuse(`Unknown or inactive container type: ${code}`),
    ),
    requireChargeType: vi.fn((code: string) =>
      code === 'FREIGHT'
        ? Promise.resolve({ code })
        : refuse(`Unknown or inactive charge type: ${code}`),
    ),
  };
  const currencies = {
    requireActive: vi.fn((code: string) =>
      code === 'USD' ? Promise.resolve({ code }) : refuse(`Unknown or inactive currency: ${code}`),
    ),
  };
  const rates = new RatesService(
    {} as PrismaService,
    masterData as unknown as MasterDataService,
    currencies as unknown as CurrenciesService,
  );
  return { rates, masterData, currencies };
}

const good: RateCardInput = {
  originLocationId: JEA,
  destinationLocationId: PZU,
  mode: 'SEA',
  loadType: 'FCL',
  cargoType: 'CONTAINER',
  containerTypeCode: '40HC',
  unit: 'PER_CONTAINER',
  price: '1250.5',
  currency: 'USD',
  validFrom: '2026-01-01',
};

describe('RatesService.ruleChecker', () => {
  it('passes a valid rate', async () => {
    await expect(service().rates.ruleChecker()(good)).resolves.toEqual([]);
  });

  it('reports every broken rule by field', async () => {
    const issues = await service().rates.ruleChecker()({
      ...good,
      originLocationId: OLD,
      mode: 'ROAD',
      cargoType: 'GENERAL',
      chargeTypeCode: 'NOPE',
      currency: 'XYZ',
      validTo: '2025-12-31',
    });
    expect(issues.map((i) => [i.field, i.code])).toEqual([
      ['originLocationId', 'UNKNOWN_LOCATION'],
      ['loadType', 'LOAD_TYPE_SEA_ONLY'],
      ['containerTypeCode', 'CONTAINER_TYPE_NOT_APPLICABLE'],
      ['chargeTypeCode', 'UNKNOWN_CHARGE_TYPE'],
      ['currency', 'UNKNOWN_CURRENCY'],
      ['validTo', 'VALID_TO_BEFORE_FROM'],
    ]);
  });

  it('reports a same-place route and a missing or unknown container type', async () => {
    const check = service().rates.ruleChecker();
    expect(
      (await check({ ...good, destinationLocationId: JEA })).map((i) => [i.field, i.code]),
    ).toEqual([['destinationLocationId', 'SAME_ROUTE']]);
    expect((await check({ ...good, containerTypeCode: null })).map((i) => i.code)).toEqual([
      'CONTAINER_TYPE_REQUIRED',
    ]);
    expect((await check({ ...good, containerTypeCode: '99XX' })).map((i) => i.code)).toEqual([
      'UNKNOWN_CONTAINER_TYPE',
    ]);
  });

  it('asks the master data services once per distinct value', async () => {
    const { rates, masterData, currencies } = service();
    const check = rates.ruleChecker();
    for (let i = 0; i < 50; i++) await check(good);
    expect(masterData.requireRoute).toHaveBeenCalledTimes(1);
    expect(masterData.requireContainerType).toHaveBeenCalledTimes(1);
    expect(currencies.requireActive).toHaveBeenCalledTimes(1);
  });
});

describe('rate duplicates', () => {
  const offer = {
    branchId: 'b1',
    originLocationId: JEA,
    destinationLocationId: PZU,
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    containerTypeCode: '40HC',
    unit: 'PER_CONTAINER',
    currency: 'USD',
    validFrom: '2031-01-01',
  };

  it('keys an offer by every field but the price; the charge type defaults to FREIGHT', () => {
    expect(rateKey(offer)).toBe(rateKey({ ...offer, chargeTypeCode: 'FREIGHT' }));
    expect(rateKey(offer)).not.toBe(rateKey({ ...offer, chargeTypeCode: 'THC' }));
    expect(rateKey(offer)).not.toBe(rateKey({ ...offer, branchId: 'b2' }));
    expect(rateKey(offer)).not.toBe(rateKey({ ...offer, validFrom: '2031-01-02' }));
    expect(rateKey({ ...offer, loadType: null })).toBe(rateKey({ ...offer, loadType: undefined }));
  });

  it('finds draft and approved rates of the offer, except the rate being edited', async () => {
    const findMany = vi.fn(() =>
      Promise.resolve([
        {
          ...offer,
          id: 'r1',
          chargeTypeCode: 'FREIGHT',
          validFrom: new Date('2031-01-01T00:00:00Z'),
        },
      ]),
    );
    const client = { rateCard: { findMany } } as unknown as Prisma.TransactionClient;
    const issues = await service().rates.duplicateIssues(client, [
      offer,
      { ...offer, excludeId: 'r1' },
      { ...offer, unit: 'PER_CBM' },
    ]);
    expect(issues.map((list) => list.map((i) => [i.field, i.code]))).toEqual([
      [['validFrom', 'DUPLICATE_IN_DB']],
      [],
      [],
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: { in: ['DRAFT', 'APPROVED'] } }) as unknown,
    });
  });
});
