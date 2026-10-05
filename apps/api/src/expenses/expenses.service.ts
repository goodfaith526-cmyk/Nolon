import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateExpenseRequest,
  ExpenseDto,
  ExpenseInput,
  ExpenseStatus,
  ExpenseSummaryDto,
  Page,
} from '@nolon/shared';
import { AccountsService } from '../accounting/accounts.service.js';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { ExpenseCategoriesService } from '../accounting/expense-categories.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { dec, requestedRate, roundMoney, sameRequestedRate } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Expense, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ExpenseFilters extends PageQuery {
  status?: ExpenseStatus;
  categoryCode?: string;
}

type Tx = Prisma.TransactionClient;

const details = {
  cashAccount: { select: { code: true, nameEn: true, nameAr: true } },
  journalEntry: { select: { number: true } },
  cancelJournal: { select: { number: true } },
} satisfies Prisma.ExpenseInclude;

type ExpenseWithDetails = Prisma.ExpenseGetPayload<{ include: typeof details }>;

/**
 * General expenses (scope 13, annex C rule 12): rent, utilities, office costs... not tied to a
 * shipment or a trip, paid from a cash or bank account of the branch. A draft is entered, then
 * approved, which numbers it and posts its entry. An approved expense is cancelled by its
 * reversing entry, dated today in the branch.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly accounts: AccountsService,
    private readonly categories: ExpenseCategoriesService,
    private readonly fxRates: FxRatesService,
    private readonly currencies: CurrenciesService,
  ) {}

  async list(user: AuthUser, filters: ExpenseFilters): Promise<Page<ExpenseSummaryDto>> {
    forbidDriver(user);
    const where: Prisma.ExpenseWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.categoryCode ? { categoryCode: filters.categoryCode } : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { description: { contains: filters.q, mode: 'insensitive' } },
              { reference: { contains: filters.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.expense.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<ExpenseDto> {
    forbidDriver(user);
    return toDto(await this.findScoped(user, id), user);
  }

  /**
   * A draft expense in one of the user's branches. The client's `requestId` becomes its id, so an
   * exact retry returns the first draft; anything else reusing the id is refused.
   */
  async create(user: AuthUser, input: CreateExpenseRequest): Promise<ExpenseDto> {
    forbidDriver(user);
    assertBranchAccess(user, input.branchId);
    const done = await this.prisma.expense.findUnique({ where: { id: input.requestId } });
    if (done) return this.retry(user, done, input);
    const fields = await this.checkDraft(input, input.branchId);
    try {
      await this.prisma.expense.create({
        data: { id: input.requestId, branchId: input.branchId, ...fields, createdById: user.id },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.expense.findUnique({ where: { id: input.requestId } });
      if (!raced) throw error;
      return this.retry(user, raced, input);
    }
    return this.get(user, input.requestId);
  }

  /** An exact retry returns the expense the request created; any other reuse is a 409. */
  private retry(
    user: AuthUser,
    existing: Expense,
    input: CreateExpenseRequest,
  ): Promise<ExpenseDto> {
    const same =
      existing.branchId === input.branchId &&
      existing.createdById === user.id &&
      fromDbDate(existing.expenseDate) === input.expenseDate &&
      existing.categoryCode === input.categoryCode &&
      existing.description === input.description &&
      existing.currency === input.currency &&
      sameRequestedRate(existing.requestedFxRate, input.fxRate) &&
      existing.amount.eq(dec(input.amount)) &&
      existing.cashAccountId === input.cashAccountId &&
      existing.reference === (input.reference ?? null);
    if (!same) throw new ConflictException('This request id was already used: send a new id');
    return this.get(user, existing.id);
  }

  /** Drafts only. */
  async update(user: AuthUser, id: string, input: ExpenseInput): Promise<ExpenseDto> {
    forbidDriver(user);
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') throw new ConflictException('Only a draft is edited');
    const fields = await this.checkDraft(input, existing.branchId);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, ['DRAFT']);
      await tx.expense.update({ where: { id }, data: fields });
    });
    return this.get(user, id);
  }

  /**
   * Numbers the expense and posts its entry, together. The category, the currency and the cash
   * account are checked again inside the transaction (category and currency share-locked).
   */
  async approve(user: AuthUser, id: string): Promise<ExpenseDto> {
    forbidDriver(user);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, ['DRAFT']);
      const expense = await tx.expense.findUniqueOrThrow({ where: { id } });
      const category = await this.categories.requireActiveInTx(tx, expense.categoryCode);
      await this.currencies.requireActiveInTx(tx, expense.currency);
      await this.accounts.requireCash(
        tx,
        expense.cashAccountId,
        expense.branchId,
        expense.currency,
      );
      const expenseDate = fromDbDate(expense.expenseDate);
      const year = expenseDate.slice(0, 4);
      const number = formatDocumentNumber(
        'EXP',
        await nextSequenceValue(tx, 'EXPENSE', year),
        year,
      );
      const entry = await this.autoJournal.expenseApproved(
        tx,
        {
          id,
          number,
          branchId: expense.branchId,
          expenseDate,
          description: expense.description,
          currency: expense.currency,
          fxRate: expense.fxRate,
          amount: expense.amount,
          expenseAccountId: category.accountId,
          cashAccountId: expense.cashAccountId,
        },
        user.id,
      );
      await tx.expense.update({
        where: { id },
        data: {
          status: 'APPROVED',
          number,
          journalEntryId: entry.id,
          approvedAt: new Date(),
          approvedById: user.id,
        },
      });
    });
    return this.get(user, id);
  }

  /** A draft is cancelled with a reason; an approved expense also gets its reversing entry. */
  async cancel(user: AuthUser, id: string, reason: string): Promise<ExpenseDto> {
    forbidDriver(user);
    const existing = await this.findScoped(user, id);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: existing.branchId },
      select: { timezone: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const status = await lockStatus(tx, id, ['DRAFT', 'APPROVED']);
      let cancelJournalEntryId: string | null = null;
      if (status === 'APPROVED') {
        const expense = await tx.expense.findUniqueOrThrow({ where: { id } });
        if (!expense.journalEntryId) throw new Error('An approved expense has an entry');
        const reversal = await this.autoJournal.reverseDocumentEntry(
          tx,
          expense.journalEntryId,
          todayIn(branch.timezone),
          user.id,
          `Cancellation of expense ${expense.number ?? ''}: ${reason}`,
        );
        cancelJournalEntryId = reversal.id;
      }
      await tx.expense.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: new Date(),
          cancelledById: user.id,
          cancelJournalEntryId,
        },
      });
    });
    return this.get(user, id);
  }

  /** The category (active), the currency and rate, the cash account and the amount. */
  private async checkDraft(input: ExpenseInput, branchId: string) {
    const category = (await this.categories.list()).find((c) => c.code === input.categoryCode);
    if (!category?.isActive) {
      throw new BadRequestException('Unknown or inactive expense category');
    }
    const currency = await this.currencies.requireActive(input.currency);
    const fxRate = await this.fxRates.resolve(currency.code, input.expenseDate, input.fxRate);
    await this.prisma.$transaction((tx) =>
      this.accounts.requireCash(tx, input.cashAccountId, branchId, currency.code),
    );
    const amount = dec(input.amount);
    if (!amount.gt(0) || !roundMoney(amount, currency.decimalPlaces).eq(amount)) {
      throw new BadRequestException(
        `The amount must be positive with ${currency.decimalPlaces} decimal places`,
      );
    }
    return {
      expenseDate: toDbDate(input.expenseDate),
      categoryCode: category.code,
      description: input.description,
      currency: currency.code,
      fxRate,
      requestedFxRate: requestedRate(input.fxRate),
      amount,
      cashAccountId: input.cashAccountId,
      reference: input.reference ?? null,
    };
  }

  private async findScoped(user: AuthUser, id: string): Promise<ExpenseWithDetails> {
    const expense = await this.prisma.expense.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }
}

/** General expenses are office work: a Driver records the costs of their own trips only. */
function forbidDriver(user: AuthUser): void {
  if (limitedToOwnTrips(user, 'transport_trips')) {
    throw new ForbiddenException('A driver cannot manage general expenses');
  }
}

/** Row lock, then 409 unless the expense has one of the expected statuses; returns its status. */
async function lockStatus(
  tx: Tx,
  id: string,
  expected: readonly ExpenseStatus[],
): Promise<ExpenseStatus> {
  const rows = await tx.$queryRaw<{ status: ExpenseStatus }[]>`
    SELECT "status"::text AS "status" FROM "expenses" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const status = rows[0]?.status;
  if (!status || !expected.includes(status)) {
    throw new ConflictException('The expense was changed by someone else; reload it');
  }
  return status;
}

function toSummary(e: {
  id: string;
  number: string | null;
  branchId: string;
  expenseDate: Date;
  categoryCode: string;
  description: string;
  currency: string;
  amount: Prisma.Decimal;
  status: ExpenseStatus;
}): ExpenseSummaryDto {
  return {
    id: e.id,
    number: e.number,
    branchId: e.branchId,
    expenseDate: fromDbDate(e.expenseDate),
    categoryCode: e.categoryCode,
    description: e.description,
    currency: e.currency,
    amount: e.amount.toFixed(),
    status: e.status,
  };
}

function toDto(e: ExpenseWithDetails, user: AuthUser): ExpenseDto {
  const can = (p: 'update' | 'approve' | 'cancel') => user.permissions.has(`expenses:${p}`);
  const isDraft = e.status === 'DRAFT';
  return {
    ...toSummary(e),
    fxRate: e.fxRate.toFixed(),
    cashAccountId: e.cashAccountId,
    cashAccountCode: e.cashAccount.code,
    cashAccountNameEn: e.cashAccount.nameEn,
    cashAccountNameAr: e.cashAccount.nameAr,
    reference: e.reference,
    journalEntryId: e.journalEntryId,
    journalEntryNumber: e.journalEntry?.number ?? null,
    cancelJournalEntryId: e.cancelJournalEntryId,
    cancelJournalEntryNumber: e.cancelJournal?.number ?? null,
    approvedAt: e.approvedAt?.toISOString() ?? null,
    cancelReason: e.cancelReason,
    actions: {
      canEdit: isDraft && can('update'),
      canApprove: isDraft && can('approve'),
      canCancel: e.status !== 'CANCELLED' && can('cancel'),
    },
  };
}
