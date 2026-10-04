import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateManualJournalRequest,
  JournalEntryDto,
  ManualJournalInput,
  ReverseJournalRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { dec, roundMoney } from '../common/money.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';
import { FxRatesService } from './fx-rates.service.js';
import { type LineSpec, type PreparedLine, toUsd } from './journal-math.js';
import { JournalService, toPrepared } from './journal.service.js';
import { PeriodsService } from './periods.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Manual journal entries (scope 13): written as drafts, posted by someone holding
 * manual_journals:approve, and corrected by reversal. They never touch the receivable, payable
 * or advances accounts, which only their documents post to.
 */
@Injectable()
export class ManualJournalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly accounts: AccountsService,
    private readonly fxRates: FxRatesService,
    private readonly currencies: CurrenciesService,
    private readonly periods: PeriodsService,
  ) {}

  async create(user: AuthUser, input: CreateManualJournalRequest): Promise<JournalEntryDto> {
    assertBranchAccess(user, input.branchId);
    const lines = await this.prepareDraftLines(input.branchId, input);
    const entry = await this.prisma.$transaction((tx) =>
      this.journal.createDraft(
        tx,
        {
          branchId: input.branchId,
          entryDate: input.entryDate,
          description: input.description,
          source: 'MANUAL',
          userId: user.id,
        },
        lines,
      ),
    );
    return this.journal.get(user, entry.id);
  }

  async update(user: AuthUser, id: string, input: ManualJournalInput): Promise<JournalEntryDto> {
    const existing = await this.findManual(user, id);
    const lines = await this.prepareDraftLines(existing.branchId, input);
    await this.prisma.$transaction(async (tx) => {
      await this.lockDraft(tx, id);
      const periodId = await this.periods.requireOpen(tx, input.entryDate);
      await tx.journalLine.deleteMany({ where: { entryId: id } });
      await tx.journalEntry.update({
        where: { id },
        data: {
          entryDate: toDbDate(input.entryDate),
          periodId,
          description: input.description,
        },
      });
      await this.journal.writeLines(tx, id, lines);
    });
    return this.journal.get(user, id);
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    await this.findManual(user, id);
    await this.prisma.$transaction(async (tx) => {
      await this.lockDraft(tx, id);
      await tx.journalEntry.delete({ where: { id } });
    });
  }

  /** Balances the draft (adding a rounding line if needed) and posts it. */
  async post(user: AuthUser, id: string): Promise<JournalEntryDto> {
    const existing = await this.findManual(user, id);
    await this.prisma.$transaction(async (tx) => {
      await this.lockDraft(tx, id);
      await this.periods.requireOpen(tx, fromDbDate(existing.entryDate));
      const stored = await tx.journalLine.findMany({
        where: { entryId: id },
        orderBy: { lineNo: 'asc' },
      });
      const controlIds = await this.accounts.controlAccountIds(tx);
      for (const line of stored) {
        await this.accounts.requirePostable(tx, line.accountId);
        if (controlIds.has(line.accountId)) {
          throw new BadRequestException('Manual entries cannot post to a control account');
        }
      }
      const balanced = await this.journal.balance(tx, existing.branchId, stored.map(toPrepared));
      if (balanced.length > stored.length) {
        await tx.journalLine.deleteMany({ where: { entryId: id } });
        await this.journal.writeLines(tx, id, balanced);
      }
      await this.journal.markPosted(tx, id, user.id);
    });
    return this.journal.get(user, id);
  }

  async reverse(
    user: AuthUser,
    id: string,
    input: ReverseJournalRequest,
  ): Promise<JournalEntryDto> {
    const existing = await this.journal.findScoped(user, id);
    if (existing.source !== 'MANUAL') {
      throw new ConflictException(
        'Entries from invoices and receipts are reversed by cancelling them',
      );
    }
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: existing.branchId } });
    const entryDate = input.entryDate ?? todayIn(branch.timezone);
    const reversal = await this.prisma.$transaction((tx) =>
      this.journal.reverse(
        tx,
        id,
        entryDate,
        user.id,
        `Reversal of ${existing.number}: ${input.reason}`,
      ),
    );
    return this.journal.get(user, reversal.id);
  }

  private async findManual(user: AuthUser, id: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, ...branchScope(user) },
    });
    if (!entry) throw new NotFoundException('Journal entry not found');
    if (entry.source !== 'MANUAL') throw new ConflictException('Not a manual entry');
    if (entry.status !== 'DRAFT') throw new ConflictException('A posted entry cannot be changed');
    return entry;
  }

  private async lockDraft(tx: Tx, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS "status" FROM "journal_entries" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows[0]?.status !== 'DRAFT') throw new ConflictException('The entry is no longer a draft');
  }

  /**
   * Checks each line and converts it to USD. A draft need not balance yet; posting checks that.
   * Amounts must already be in the currency's minor units.
   */
  private async prepareDraftLines(
    branchId: string,
    input: ManualJournalInput,
  ): Promise<PreparedLine[]> {
    const controlIds = await this.accounts.controlAccountIds(this.prisma);
    const result: PreparedLine[] = [];
    for (const [index, line] of input.lines.entries()) {
      const label = `Line ${index + 1}`;
      const account = await this.accounts.requirePostable(this.prisma, line.accountId);
      if (controlIds.has(account.id)) {
        throw new BadRequestException(
          `${label}: ${account.code} is a control account; use invoices and receipts`,
        );
      }
      if (account.isCash && account.currency !== line.currency) {
        throw new BadRequestException(`${label}: ${account.code} holds ${account.currency ?? ''}`);
      }
      const currency = await this.currencies.requireActive(line.currency);
      const debit = dec(line.debit ?? '0');
      const credit = dec(line.credit ?? '0');
      if (debit.gt(0) === credit.gt(0)) {
        throw new BadRequestException(`${label}: enter a debit or a credit`);
      }
      const amount = debit.gt(0) ? debit : credit;
      if (!roundMoney(amount, currency.decimalPlaces).eq(amount)) {
        throw new BadRequestException(
          `${label}: ${line.currency} has ${currency.decimalPlaces} decimal places`,
        );
      }
      const fxRate = await this.fxRates.resolve(line.currency, input.entryDate, line.fxRate);
      const spec: LineSpec = {
        accountId: account.id,
        branchId,
        currency: line.currency,
        fxRate,
        side: debit.gt(0) ? 'DEBIT' : 'CREDIT',
        amount,
        description: line.description ?? null,
      };
      result.push({ ...spec, amountUsd: toUsd(amount, fxRate, line.currency) });
    }
    if (result.length < 2) throw new BadRequestException('An entry needs at least two lines');
    return result;
  }
}
