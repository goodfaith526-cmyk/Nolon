import { BadRequestException, Injectable } from '@nestjs/common';
import { isCurrencyCodeFormat, type CurrencyCode } from '@nolon/shared';
import type { Currency } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Currency master. The only place that decides whether a currency code is usable: other modules
 * call `requireActive` instead of checking against a hard-coded list.
 */
@Injectable()
export class CurrenciesService {
  constructor(private readonly prisma: PrismaService) {}

  listActive(): Promise<Currency[]> {
    return this.prisma.currency.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });
  }

  async isActive(code: CurrencyCode): Promise<boolean> {
    if (!isCurrencyCodeFormat(code)) return false;
    const currency = await this.prisma.currency.findUnique({ where: { code } });
    return currency?.isActive ?? false;
  }

  async requireActive(code: CurrencyCode): Promise<Currency> {
    const currency = isCurrencyCodeFormat(code)
      ? await this.prisma.currency.findUnique({ where: { code } })
      : null;
    if (!currency?.isActive) {
      throw new BadRequestException(`Unknown or inactive currency: ${code}`);
    }
    return currency;
  }
}
