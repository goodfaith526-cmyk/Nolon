import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CurrenciesService } from './currencies.service.js';

function serviceWith(row: { code: string; isActive: boolean } | null) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const prisma = { currency: { findUnique } } as unknown as PrismaService;
  return { service: new CurrenciesService(prisma), findUnique };
}

describe('CurrenciesService', () => {
  it('accepts any active currency in the master, not a fixed list', async () => {
    const { service } = serviceWith({ code: 'GBP', isActive: true });
    await expect(service.isActive('GBP')).resolves.toBe(true);
    await expect(service.requireActive('GBP')).resolves.toMatchObject({ code: 'GBP' });
  });

  it('rejects inactive and unknown currencies', async () => {
    await expect(
      serviceWith({ code: 'EUR', isActive: false }).service.isActive('EUR'),
    ).resolves.toBe(false);
    await expect(serviceWith(null).service.requireActive('XYZ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects malformed codes without querying the database', async () => {
    const { service, findUnique } = serviceWith(null);
    await expect(service.isActive('usd')).resolves.toBe(false);
    await expect(service.requireActive('US')).rejects.toBeInstanceOf(BadRequestException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
