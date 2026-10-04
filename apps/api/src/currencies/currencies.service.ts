import { BadRequestException, Injectable } from '@nestjs/common';
import { isCurrencyCodeFormat, type CurrencyCode } from '@nolon/shared';
import type { Currency, Prisma } from '../generated/prisma/client.js';
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

  /**
   * Like requireActive, inside the caller's transaction with the currency row share-locked: a
   * concurrent deactivation either commits first and is seen here, or waits for the caller.
   */
  async requireActiveInTx(tx: Prisma.TransactionClient, code: CurrencyCode): Promise<Currency> {
    if (isCurrencyCodeFormat(code)) {
      await tx.$queryRaw`SELECT 1 FROM "currencies" WHERE "code" = ${code} FOR SHARE`;
    }
    const currency = isCurrencyCodeFormat(code)
      ? await tx.currency.findUnique({ where: { code } })
      : null;
    if (!currency?.isActive) {
      throw new BadRequestException(`Unknown or inactive currency: ${code}`);
    }
    return currency;
  }

  /**
   * A currency an amount was already recorded in, active or not: settling or posting that amount
   * later must not depend on whether the currency is still offered for new documents.
   */
  async requireRecorded(code: CurrencyCode): Promise<Currency> {
    const currency = isCurrencyCodeFormat(code)
      ? await this.prisma.currency.findUnique({ where: { code } })
      : null;
    if (!currency) throw new BadRequestException(`Unknown currency: ${code}`);
    return currency;
  }
}
