import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BASE_CURRENCY,
  type FxRateDto,
  type FxRateInput,
  type FxRateLookupDto,
} from '@nolon/shared';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, dec } from '../common/money.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { FxRate } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Daily exchange rates (scope 13, currencies): units of each currency per 1 USD. A document uses
 * the rate entered on it, or else the latest rate on or before its date.
 */
@Injectable()
export class FxRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrenciesService,
  ) {}

  async list(filters: { currency?: string; from?: string; to?: string }): Promise<FxRateDto[]> {
    const rates = await this.prisma.fxRate.findMany({
      where: {
        ...(filters.currency ? { currency: filters.currency } : {}),
        ...(filters.from || filters.to
          ? {
              rateDate: {
                ...(filters.from ? { gte: toDbDate(filters.from) } : {}),
                ...(filters.to ? { lte: toDbDate(filters.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ rateDate: 'desc' }, { currency: 'asc' }],
      take: 200,
    });
    return rates.map(toDto);
  }

  /** One rate per currency and day: entering it again replaces it. */
  async upsert(userId: string, input: FxRateInput): Promise<FxRateDto> {
    if (input.currency === BASE_CURRENCY) {
      throw new BadRequestException('USD is the reporting currency: its rate is always 1');
    }
    await this.currencies.requireActive(input.currency);
    const rateDate = toDbDate(input.rateDate);
    const rate = dec(input.rate);
    const saved = await this.prisma.fxRate.upsert({
      where: { currency_rateDate: { currency: input.currency, rateDate } },
      create: { currency: input.currency, rateDate, rate, createdById: userId },
      update: { rate },
    });
    return toDto(saved);
  }

  async lookup(currency: string, date: string): Promise<FxRateLookupDto | null> {
    if (currency === BASE_CURRENCY) return { currency, rate: '1', rateDate: date };
    const row = await this.prisma.fxRate.findFirst({
      where: { currency, rateDate: { lte: toDbDate(date) } },
      orderBy: { rateDate: 'desc' },
    });
    return row ? { currency, rate: row.rate.toFixed(), rateDate: fromDbDate(row.rateDate) } : null;
  }

  /**
   * The rate a document uses: 1 for USD, the rate entered on the document, or the table's rate
   * for its date. 400 when there is none.
   */
  async resolve(currency: string, date: string, entered?: string | null): Promise<Decimal> {
    if (currency === BASE_CURRENCY) {
      if (entered && !dec(entered).eq(1)) throw new BadRequestException('The USD rate is 1');
      return dec(1);
    }
    if (entered) {
      const rate = dec(entered);
      if (!rate.gt(0)) throw new BadRequestException('Exchange rate must be positive');
      return rate;
    }
    const found = await this.lookup(currency, date);
    if (!found) {
      throw new BadRequestException(
        `No exchange rate for ${currency} on or before ${date}: add one or enter the rate`,
      );
    }
    return dec(found.rate);
  }
}

function toDto(r: FxRate): FxRateDto {
  return {
    id: r.id,
    currency: r.currency,
    rateDate: fromDbDate(r.rateDate),
    rate: r.rate.toFixed(),
  };
}
