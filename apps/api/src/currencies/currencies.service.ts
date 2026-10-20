import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  BASE_CURRENCY,
  isCurrencyCodeFormat,
  type CurrencyCode,
  type CurrencyDto,
  type CurrencyInput,
  type CurrencyUpdate,
} from '@nolon/shared';
import { AuditService, changedFields, codeEntityId } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { codedRefusal } from '../common/validation.js';
import type { Currency, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** The fields the audit log shows for a currency, in this order. */
const AUDITED_FIELDS = ['code', 'nameEn', 'nameAr', 'symbol', 'decimalPlaces', 'isActive'] as const;

/**
 * Currency master. The only place that decides whether a currency code is usable: other modules
 * call `requireActive` instead of checking against a hard-coded list.
 *
 * The master data screen adds, renames and deactivates currencies here, each change in the audit
 * log. A currency is never deleted: deactivating it stops new documents in it (requireActive),
 * while amounts already recorded in it keep it (requireRecorded).
 */
@Injectable()
export class CurrenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A new, active currency. Its code and decimal places never change afterwards. */
  async create(user: AuthUser, input: CurrencyInput): Promise<CurrencyDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.currency.create({
          data: {
            code: input.code,
            nameEn: input.nameEn,
            nameAr: input.nameAr,
            symbol: input.symbol ?? null,
            decimalPlaces: input.decimalPlaces,
          },
        });
        await this.log(tx, user, 'CREATED', null, created);
        return toCurrencyDto(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'MASTER_CODE_TAKEN',
          `Currency ${input.code} already exists`,
          { code: input.code },
        );
      }
      throw error;
    }
  }

  /** Renames a currency or changes its symbol. */
  async update(user: AuthUser, code: string, input: CurrencyUpdate): Promise<CurrencyDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await lockCurrency(tx, code);
      const after = await tx.currency.update({ where: { code }, data: input });
      await this.log(tx, user, 'UPDATED', before, after);
      return toCurrencyDto(after);
    });
  }

  /**
   * Deactivates or reactivates a currency. The base currency stays active: every journal entry
   * balances in it. A deactivation waits for documents being saved in the currency
   * (requireActiveInTx share-locks it) and stops the ones after it.
   */
  async setActive(user: AuthUser, code: string, isActive: boolean): Promise<CurrencyDto> {
    if (!isActive && code === BASE_CURRENCY) {
      throw codedRefusal(
        HttpStatus.BAD_REQUEST,
        'BASE_CURRENCY_STAYS_ACTIVE',
        `${BASE_CURRENCY} is the base currency and stays active`,
        { code },
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const before = await lockCurrency(tx, code);
      if (before.isActive === isActive) return toCurrencyDto(before);
      const after = await tx.currency.update({ where: { code }, data: { isActive } });
      await this.log(tx, user, 'UPDATED', before, after);
      return toCurrencyDto(after);
    });
  }

  private async log(
    tx: Tx,
    user: AuthUser,
    action: 'CREATED' | 'UPDATED',
    before: Currency | null,
    after: Currency,
  ): Promise<void> {
    await this.audit.record(tx, user, {
      branchId: null,
      entity: 'CURRENCY',
      entityId: codeEntityId('CURRENCY', after.code),
      reference: `${after.code} ${after.nameEn}`,
      action,
      changes: changedFields(before, after, AUDITED_FIELDS),
    });
  }

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

/** The currency row locked for update until the caller commits; 404 when there is none. */
async function lockCurrency(tx: Tx, code: string): Promise<Currency> {
  const rows = isCurrencyCodeFormat(code)
    ? await tx.$queryRaw<{ code: string }[]>`
        SELECT "code" FROM "currencies" WHERE "code" = ${code} FOR UPDATE`
    : [];
  if (rows.length === 0) throw new NotFoundException('Currency not found');
  return tx.currency.findUniqueOrThrow({ where: { code } });
}

function toCurrencyDto(c: Currency): CurrencyDto {
  return {
    code: c.code,
    nameEn: c.nameEn,
    nameAr: c.nameAr,
    isActive: c.isActive,
    symbol: c.symbol,
    decimalPlaces: c.decimalPlaces,
  };
}
