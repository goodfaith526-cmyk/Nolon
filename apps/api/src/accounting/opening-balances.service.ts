import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { BASE_CURRENCY, type JournalEntryDto, type OpeningAccountsRequest } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import { fromDbDate } from '../common/dates.js';
import { dec, roundMoney } from '../common/money.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';
import { AutoJournalService } from './auto-journal.service.js';
import { FxRatesService } from './fx-rates.service.js';
import type { LineSpec } from './journal-math.js';
import { JournalService } from './journal.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Opening balances of ledger accounts at go-live (scope 13, annex C rule 15). One posted entry per
 * request, with the difference on the OPENING_EQUITY account. Control accounts (receivable,
 * payable, advances) are left out: their opening balances are the customers' and suppliers' open
 * items, entered one by one so that receipts and payments can settle them.
 */
@Injectable()
export class OpeningBalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly autoJournal: AutoJournalService,
    private readonly accounts: AccountsService,
    private readonly fxRates: FxRatesService,
    private readonly currencies: CurrenciesService,
  ) {}

  /**
   * Posts the entry. The client's `requestId` is the entry's source id: a retry finds the entry
   * the first request posted (requests with the same id queue on a transaction lock).
   */
  async postAccounts(user: AuthUser, input: OpeningAccountsRequest): Promise<JournalEntryDto> {
    assertBranchAccess(user, input.branchId);
    const entryId = await this.prisma.$transaction(async (tx) => {
      const done = await previous(tx, input.requestId);
      if (done) {
        if (!sameRequest(done, input, user.id)) {
          throw new ConflictException('This request id was already used for another entry');
        }
        return done.id;
      }
      const lines = await this.lines(tx, input);
      const entry = await this.autoJournal.openingAccounts(
        tx,
        {
          id: input.requestId,
          branchId: input.branchId,
          entryDate: input.entryDate,
          description: input.description ?? 'Opening balances',
        },
        lines,
        user.id,
      );
      return entry.id;
    });
    return this.journal.get(user, entryId);
  }

  private async lines(tx: Tx, input: OpeningAccountsRequest): Promise<LineSpec[]> {
    const controlIds = await this.accounts.controlAccountIds(tx);
    const equity = await this.accounts.roleAccount(tx, 'OPENING_EQUITY');
    const specs: LineSpec[] = [];
    for (const [index, line] of input.lines.entries()) {
      const label = `Line ${index + 1}`;
      const account = await this.accounts.requirePostable(tx, line.accountId);
      if (controlIds.has(account.id)) {
        throw new BadRequestException(
          `${label}: ${account.code} is a control account; enter customer and supplier open items`,
        );
      }
      if (account.id === equity) {
        throw new BadRequestException(`${label}: opening equity takes the difference`);
      }
      if (account.isCash && account.currency !== line.currency) {
        throw new BadRequestException(`${label}: ${account.code} holds ${account.currency ?? ''}`);
      }
      if (account.isCash && account.branchId !== null && account.branchId !== input.branchId) {
        throw new BadRequestException(`${label}: ${account.code} belongs to another branch`);
      }
      const currency = await this.currencies.requireActiveInTx(tx, line.currency);
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
      specs.push({
        accountId: account.id,
        branchId: input.branchId,
        currency: currency.code,
        fxRate: await this.fxRates.resolve(currency.code, input.entryDate, line.fxRate),
        side: debit.gt(0) ? 'DEBIT' : 'CREDIT',
        amount,
        description: line.description ?? null,
      });
    }
    if (specs.length === 0) throw new BadRequestException('Enter at least one balance');
    return specs;
  }
}

type PreviousEntry = Prisma.JournalEntryGetPayload<{ include: { lines: true } }>;

/** The entry an earlier request with this id posted, after waiting for any in flight. */
async function previous(tx: Tx, requestId: string): Promise<PreviousEntry | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`;
  return tx.journalEntry.findFirst({
    where: { source: 'OPENING_BALANCE', sourceId: requestId },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
}

/**
 * Whether the entry found is the one this exact request posted: an opening-accounts entry (an open
 * item's entry shares the source and id but carries a customer or supplier on its lines) with the
 * same branch, author, date, text and lines, the opening equity line after them.
 */
function sameRequest(done: PreviousEntry, input: OpeningAccountsRequest, userId: string): boolean {
  if (done.lines.some((l) => l.customerId !== null || l.supplierId !== null)) return false;
  const extra = done.lines.length - input.lines.length;
  return (
    done.branchId === input.branchId &&
    done.createdById === userId &&
    fromDbDate(done.entryDate) === input.entryDate &&
    done.description === (input.description ?? 'Opening balances') &&
    (extra === 0 || extra === 1) &&
    input.lines.every((sent, index) => {
      const line = done.lines[index];
      return (
        line !== undefined &&
        line.accountId === sent.accountId &&
        line.currency === sent.currency &&
        line.debit.eq(dec(sent.debit ?? '0')) &&
        line.credit.eq(dec(sent.credit ?? '0')) &&
        (sent.currency === BASE_CURRENCY || !sent.fxRate || line.fxRate.eq(dec(sent.fxRate))) &&
        line.description === (sent.description ?? null)
      );
    })
  );
}
