import { Injectable } from '@nestjs/common';
import type { AccountType, TrialBalanceDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import { toDbDate } from '../common/dates.js';
import { ZERO } from '../common/money.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface Row {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  debitUsd: Prisma.Decimal;
  creditUsd: Prisma.Decimal;
}

/**
 * Trial balance in USD (scope 13): posted lines up to a date, per account. Lines are filtered on
 * their own branch, limited to the user's branches (or one of them).
 */
@Injectable()
export class TrialBalanceService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthUser, asOf: string, branchId?: string): Promise<TrialBalanceDto> {
    if (branchId) assertBranchAccess(user, branchId);
    const branchIds = branchId ? [branchId] : [...user.allowedBranchIds];
    const rows =
      branchIds.length === 0
        ? []
        : await this.prisma.$queryRaw<Row[]>`
            SELECT a."id" AS "accountId", a."code", a."name_en" AS "nameEn", a."name_ar" AS "nameAr",
                   a."type"::text AS "type",
                   sum(l."debit_usd") AS "debitUsd", sum(l."credit_usd") AS "creditUsd"
            FROM "journal_lines" l
            JOIN "journal_entries" e ON e."id" = l."entry_id"
            JOIN "accounts" a ON a."id" = l."account_id"
            WHERE e."status" = 'POSTED'
              AND e."entry_date" <= ${toDbDate(asOf)}
              AND l."branch_id" IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
            GROUP BY a."id"
            ORDER BY a."code"`;
    let totalDebit = ZERO;
    let totalCredit = ZERO;
    const result = rows.map((r) => {
      const debit = new Prisma.Decimal(r.debitUsd);
      const credit = new Prisma.Decimal(r.creditUsd);
      totalDebit = totalDebit.plus(debit);
      totalCredit = totalCredit.plus(credit);
      return {
        accountId: r.accountId,
        code: r.code,
        nameEn: r.nameEn,
        nameAr: r.nameAr,
        type: r.type,
        debitUsd: debit.toFixed(),
        creditUsd: credit.toFixed(),
        balanceUsd: debit.minus(credit).toFixed(),
      };
    });
    return {
      asOf,
      branchId: branchId ?? null,
      rows: result,
      totalDebitUsd: totalDebit.toFixed(),
      totalCreditUsd: totalCredit.toFixed(),
    };
  }
}
