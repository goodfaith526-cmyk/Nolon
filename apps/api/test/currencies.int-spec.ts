import 'dotenv/config';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CurrenciesService } from '../src/currencies/currencies.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Currency master against a real database', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let currencies: CurrenciesService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    currencies = app.get(CurrenciesService);
  });

  afterAll(async () => {
    await prisma.branch.deleteMany({ where: { code: 'ZZT' } });
    await prisma.currency.deleteMany({ where: { code: 'ZZZ' } });
    await app.close();
  });

  it('has the initial five currencies from the migration', async () => {
    const codes = (await currencies.listActive()).map((currency) => currency.code);
    expect(codes).toEqual(expect.arrayContaining(['AED', 'EUR', 'SAR', 'SDG', 'USD']));
  });

  it('accepts a newly added currency without a code change, and stops on deactivation', async () => {
    await prisma.currency.create({ data: { code: 'ZZZ', nameEn: 'Test', nameAr: 'تجربة' } });
    await expect(currencies.isActive('ZZZ')).resolves.toBe(true);

    await prisma.currency.update({ where: { code: 'ZZZ' }, data: { isActive: false } });
    await expect(currencies.isActive('ZZZ')).resolves.toBe(false);
    await expect(currencies.requireActive('ZZZ')).rejects.toThrow(/inactive/);
  });

  it('rejects a branch whose currency is not in the master', async () => {
    await expect(
      prisma.branch.create({
        data: {
          code: 'ZZT',
          nameEn: 'Test',
          nameAr: 'تجربة',
          countryCode: 'AE',
          city: 'Test',
          defaultCurrency: 'QQQ',
          timezone: 'Asia/Dubai',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses to delete a currency that branches use', async () => {
    await prisma.branch.upsert({
      where: { code: 'ZZT' },
      create: {
        code: 'ZZT',
        nameEn: 'Test',
        nameAr: 'تجربة',
        countryCode: 'AE',
        city: 'Test',
        defaultCurrency: 'AED',
        timezone: 'Asia/Dubai',
      },
      update: { defaultCurrency: 'AED' },
    });
    await expect(prisma.currency.delete({ where: { code: 'AED' } })).rejects.toThrow();
  });

  it('enforces the code format in the database', async () => {
    await expect(
      prisma.currency.create({ data: { code: 'ab1', nameEn: 'Bad', nameAr: 'خطأ' } }),
    ).rejects.toThrow();
  });
});
