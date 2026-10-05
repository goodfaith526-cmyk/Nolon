import { BadRequestException, Injectable } from '@nestjs/common';
import type { ExpenseCategoryDto, ExpenseCategoryInput } from '@nolon/shared';
import type { ExpenseCategory, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Expense categories (annex C rule 12): the kinds of general expense and the expense account each
 * posts to. Master data the client extends from the settings; a category in use is deactivated,
 * never deleted (foreign keys restrict it).
 */
@Injectable()
export class ExpenseCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async list(): Promise<ExpenseCategoryDto[]> {
    const rows = await this.prisma.expenseCategory.findMany({ orderBy: { code: 'asc' } });
    return rows.map(toDto);
  }

  /** Creates or replaces a category. Its account must be an active, postable expense account. */
  async upsert(input: ExpenseCategoryInput): Promise<ExpenseCategoryDto> {
    const saved = await this.prisma.$transaction(async (tx) => {
      const account = await this.accounts.requirePostable(tx, input.accountId);
      if (account.type !== 'EXPENSE' || account.isCash) {
        throw new BadRequestException('An expense category posts to an expense account');
      }
      const fields = {
        nameEn: input.nameEn,
        nameAr: input.nameAr,
        accountId: input.accountId,
        isActive: input.isActive ?? true,
      };
      return tx.expenseCategory.upsert({
        where: { code: input.code },
        create: { code: input.code, ...fields },
        update: fields,
      });
    });
    return toDto(saved);
  }

  /**
   * Inside the caller's transaction: an active category, share-locked so it is not deactivated or
   * remapped until the caller commits. Returns the expense account it posts to.
   */
  async requireActiveInTx(tx: Tx, code: string): Promise<ExpenseCategory> {
    await tx.$queryRaw`SELECT 1 FROM "expense_categories" WHERE "code" = ${code} FOR SHARE`;
    const category = await tx.expenseCategory.findUnique({ where: { code } });
    if (!category?.isActive) {
      throw new BadRequestException(`Unknown or inactive expense category: ${code}`);
    }
    return category;
  }
}

function toDto(c: ExpenseCategory): ExpenseCategoryDto {
  return {
    code: c.code,
    nameEn: c.nameEn,
    nameAr: c.nameAr,
    accountId: c.accountId,
    isActive: c.isActive,
  };
}
