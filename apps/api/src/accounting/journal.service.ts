import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  JournalEntryDto,
  JournalEntrySummaryDto,
  JournalSource,
  JournalStatus,
  Page,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { ZERO } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import type { JournalEntry, JournalLine, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';
import {
  InvalidLineError,
  type LineSpec,
  type PreparedLine,
  UnbalancedEntryError,
  prepareLines,
  reverseLines,
} from './journal-math.js';
import { PeriodsService } from './periods.service.js';

type Tx = Prisma.TransactionClient;

export interface EntryHeader {
  branchId: string;
  entryDate: string;
  description: string;
  source: JournalSource;
  sourceId?: string | null;
  userId: string;
}

export interface JournalFilters extends PageQuery {
  status?: JournalStatus;
  source?: JournalSource;
  from?: string;
  to?: string;
}

const details = {
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      account: { select: { code: true, nameEn: true, nameAr: true } },
      shipment: { select: { number: true } },
      customer: { select: { name: true } },
    },
  },
  createdBy: { select: { fullName: true } },
  postedBy: { select: { fullName: true } },
  reversalOf: { select: { number: true } },
  reversedBy: { select: { id: true, number: true } },
  invoice: { select: { number: true } },
  receipt: { select: { number: true } },
  receiptCancel: { select: { number: true } },
} satisfies Prisma.JournalEntryInclude;

type EntryWithDetails = Prisma.JournalEntryGetPayload<{ include: typeof details }>;

/**
 * The general journal. Every entry, manual or automatic, is written here: as a DRAFT with its
 * lines, then posted by one update the database checks (balanced in USD, open period). Posted
 * entries are never changed; `reverse` posts the mirror entry instead.
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly periods: PeriodsService,
  ) {}

  /** Writes and posts an entry inside the caller's transaction. */
  async post(tx: Tx, header: EntryHeader, specs: readonly LineSpec[]): Promise<JournalEntry> {
    const lines = await this.balance(tx, header.branchId, specs);
    const entry = await this.createDraft(tx, header, lines);
    return this.markPosted(tx, entry.id, header.userId);
  }

  /**
   * Posts the reversing entry of a posted entry, dated `entryDate` (which must fall in an open
   * period). 409 if it is not posted or already reversed.
   */
  async reverse(
    tx: Tx,
    entryId: string,
    entryDate: string,
    userId: string,
    description: string,
  ): Promise<JournalEntry> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "journal_entries" WHERE "id" = ${entryId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Journal entry not found');
    const original = await tx.journalEntry.findUniqueOrThrow({
      where: { id: entryId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: { select: { id: true } } },
    });
    if (original.status !== 'POSTED')
      throw new ConflictException('Only a posted entry is reversed');
    if (original.reversedBy) throw new ConflictException('This entry is already reversed');
    if (original.source === 'REVERSAL') throw new ConflictException('A reversal is not reversed');
    if (entryDate < fromDbDate(original.entryDate)) {
      throw new BadRequestException('A reversal cannot be dated before the entry it reverses');
    }
    const lines = reverseLines(original.lines.map(toPrepared));
    const reversal = await this.createDraft(
      tx,
      {
        branchId: original.branchId,
        entryDate,
        description,
        source: 'REVERSAL',
        userId,
      },
      lines,
      original.id,
    );
    return this.markPosted(tx, reversal.id, userId);
  }

  /** Converts to USD and adds the rounding line when needed; 400 if unbalanced. */
  async balance(tx: Tx, branchId: string, specs: readonly LineSpec[]): Promise<PreparedLine[]> {
    const roundingAccountId = await this.accounts.roleAccount(tx, 'ROUNDING');
    try {
      return prepareLines(specs, { accountId: roundingAccountId, branchId });
    } catch (error) {
      if (error instanceof UnbalancedEntryError || error instanceof InvalidLineError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async createDraft(
    tx: Tx,
    header: EntryHeader,
    lines: readonly PreparedLine[],
    reversalOfId: string | null = null,
  ): Promise<JournalEntry> {
    const periodId = await this.periods.requireOpen(tx, header.entryDate);
    const year = header.entryDate.slice(0, 4);
    const number = formatDocumentNumber('JE', await nextSequenceValue(tx, 'JOURNAL', year), year);
    const entry = await tx.journalEntry.create({
      data: {
        number,
        branchId: header.branchId,
        entryDate: toDbDate(header.entryDate),
        periodId,
        description: header.description,
        source: header.source,
        sourceId: header.sourceId ?? null,
        reversalOfId,
        createdById: header.userId,
      },
    });
    await this.writeLines(tx, entry.id, lines);
    return entry;
  }

  async writeLines(tx: Tx, entryId: string, lines: readonly PreparedLine[]): Promise<void> {
    // 400 rather than the database trigger's error when an account is inactive or a header; the
    // share locks also keep the accounts from changing until this entry commits.
    await this.accounts.lockForPosting(
      tx,
      lines.map((line) => line.accountId),
    );
    await tx.journalLine.createMany({
      data: lines.map((line, index) => ({
        entryId,
        lineNo: index + 1,
        accountId: line.accountId,
        branchId: line.branchId,
        shipmentId: line.shipmentId ?? null,
        customerId: line.customerId ?? null,
        description: line.description ?? null,
        currency: line.currency,
        fxRate: line.fxRate,
        debit: line.side === 'DEBIT' ? line.amount : ZERO,
        credit: line.side === 'CREDIT' ? line.amount : ZERO,
        debitUsd: line.side === 'DEBIT' ? line.amountUsd : ZERO,
        creditUsd: line.side === 'CREDIT' ? line.amountUsd : ZERO,
      })),
    });
  }

  /** DRAFT → POSTED. The database trigger re-checks balance and period. */
  async markPosted(tx: Tx, entryId: string, userId: string): Promise<JournalEntry> {
    const { count } = await tx.journalEntry.updateMany({
      where: { id: entryId, status: 'DRAFT' },
      data: { status: 'POSTED', postedAt: new Date(), postedById: userId },
    });
    if (count !== 1) throw new ConflictException('The entry is no longer a draft');
    return tx.journalEntry.findUniqueOrThrow({ where: { id: entryId } });
  }

  async list(user: AuthUser, filters: JournalFilters): Promise<Page<JournalEntrySummaryDto>> {
    const where: Prisma.JournalEntryWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.from || filters.to
        ? {
            entryDate: {
              ...(filters.from ? { gte: toDbDate(filters.from) } : {}),
              ...(filters.to ? { lte: toDbDate(filters.to) } : {}),
            },
          }
        : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { description: { contains: filters.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where,
        include: { lines: { select: { debitUsd: true } }, reversedBy: { select: { id: true } } },
        orderBy: [{ entryDate: 'desc' }, { number: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.journalEntry.count({ where }),
    ]);
    return {
      items: items.map((e) => toSummary(e, e.lines, e.reversedBy?.id ?? null)),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async get(user: AuthUser, id: string): Promise<JournalEntryDto> {
    return toDto(await this.findScoped(user, id), user);
  }

  /** 404 unless the entry belongs to one of the user's branches. */
  async findScoped(user: AuthUser, id: string): Promise<EntryWithDetails> {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!entry) throw new NotFoundException('Journal entry not found');
    return entry;
  }
}

export function toPrepared(line: JournalLine): PreparedLine {
  const isDebit = line.debit.gt(0);
  return {
    accountId: line.accountId,
    branchId: line.branchId,
    currency: line.currency,
    fxRate: line.fxRate,
    side: isDebit ? 'DEBIT' : 'CREDIT',
    amount: isDebit ? line.debit : line.credit,
    amountUsd: isDebit ? line.debitUsd : line.creditUsd,
    shipmentId: line.shipmentId,
    customerId: line.customerId,
    description: line.description,
  };
}

function toSummary(
  e: JournalEntry,
  lines: readonly { debitUsd: Prisma.Decimal }[],
  reversedById: string | null,
): JournalEntrySummaryDto {
  const totalUsd = lines.reduce((sum, l) => sum.plus(l.debitUsd), ZERO);
  return {
    id: e.id,
    number: e.number,
    branchId: e.branchId,
    entryDate: fromDbDate(e.entryDate),
    description: e.description,
    source: e.source,
    sourceId: e.sourceId,
    status: e.status,
    totalUsd: totalUsd.toFixed(),
    reversalOfId: e.reversalOfId,
    reversedById,
  };
}

function toDto(e: EntryWithDetails, user: AuthUser): JournalEntryDto {
  const isManualDraft = e.source === 'MANUAL' && e.status === 'DRAFT';
  const can = (p: 'update' | 'approve' | 'cancel') => user.permissions.has(`manual_journals:${p}`);
  return {
    ...toSummary(e, e.lines, e.reversedBy?.id ?? null),
    sourceNumber: e.invoice?.number ?? e.receipt?.number ?? e.receiptCancel?.number ?? null,
    reversalOfNumber: e.reversalOf?.number ?? null,
    reversedByNumber: e.reversedBy?.number ?? null,
    createdByName: e.createdBy.fullName,
    postedByName: e.postedBy?.fullName ?? null,
    postedAt: e.postedAt?.toISOString() ?? null,
    lines: e.lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.account.code,
      accountNameEn: l.account.nameEn,
      accountNameAr: l.account.nameAr,
      branchId: l.branchId,
      shipmentId: l.shipmentId,
      shipmentNumber: l.shipment?.number ?? null,
      customerId: l.customerId,
      customerName: l.customer?.name ?? null,
      description: l.description,
      currency: l.currency,
      fxRate: l.fxRate.toFixed(),
      debit: l.debit.toFixed(),
      credit: l.credit.toFixed(),
      debitUsd: l.debitUsd.toFixed(),
      creditUsd: l.creditUsd.toFixed(),
    })),
    actions: {
      canEdit: isManualDraft && can('update'),
      canDelete: isManualDraft && can('update'),
      canPost: isManualDraft && can('approve'),
      canReverse: e.source === 'MANUAL' && e.status === 'POSTED' && !e.reversedBy && can('cancel'),
    },
  };
}
