import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CurrenciesService } from './currencies.service.js';

function serviceWith(row: { code: string; isActive: boolean } | null) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const $transaction = vi.fn();
  const prisma = { currency: { findUnique }, $transaction } as unknown as PrismaService;
  const record = vi.fn();
  const audit = { record } as unknown as AuditService;
  return { service: new CurrenciesService(prisma, audit), findUnique, $transaction, record };
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

  it('refuses to deactivate the base currency, before touching the database', async () => {
    const { service, $transaction, record } = serviceWith(null);
    const admin = { id: 'u1' } as AuthUser;
    await expect(service.setActive(admin, 'USD', false)).rejects.toMatchObject({
      status: 400,
      response: { code: 'BASE_CURRENCY_STAYS_ACTIVE' },
    });
    expect($transaction).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
