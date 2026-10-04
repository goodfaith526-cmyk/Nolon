import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateCreditNoteRequest,
  CreditNoteDto,
  CreditNoteInput,
  CreditNoteStatus,
  CreditNoteSummaryDto,
  Page,
} from '@nolon/shared';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { USD_DECIMALS } from '../accounting/journal-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, dec, roundMoney } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { relievedUsd } from './invoice-math.js';

export interface CreditNoteFilters extends PageQuery {
  status?: CreditNoteStatus;
  invoiceId?: string;
  customerId?: string;
}

type Tx = Prisma.TransactionClient;

const details = {
  customer: { select: { name: true } },
  invoice: {
    select: {
      number: true,
      currency: true,
      fxRate: true,
      total: true,
      paidAmount: true,
      creditedAmount: true,
    },
  },
  journalEntry: { select: { number: true } },
} satisfies Prisma.CreditNoteInclude;

type CreditNoteWithDetails = Prisma.CreditNoteGetPayload<{ include: typeof details }>;

/**
 * Credit notes (scope 13, annex C rule 6): cancel or reduce an approved customer invoice. A credit
 * note is written as a DRAFT against the invoice for at most what it still has open, and approving
 * it numbers it and posts the reversing entry in the same transaction, which also lowers the
 * invoice's balance. Only drafts are cancelled.
 */
@Injectable()
export class CreditNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly currencies: CurrenciesService,
  ) {}

  async list(user: AuthUser, filters: CreditNoteFilters): Promise<Page<CreditNoteSummaryDto>> {
    const where: Prisma.CreditNoteWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.invoiceId ? { invoiceId: filters.invoiceId } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { invoice: { number: { contains: filters.q, mode: 'insensitive' } } },
              { customer: { name: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.creditNote.findMany({
        where,
        include: details,
        orderBy: [{ creditDate: 'desc' }, { createdAt: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.creditNote.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<CreditNoteDto> {
    return toDto(await this.findScoped(user, id), user);
  }

  /**
   * A draft against an approved invoice of the user's branches. The client's `requestId` becomes
   * the credit note's id, so an exact retry returns the first draft; anything else reusing the id
   * is refused.
   */
  async create(user: AuthUser, input: CreateCreditNoteRequest): Promise<CreditNoteDto> {
    const invoice = await this.prisma.customerInvoice.findFirst({
      where: { id: input.invoiceId, ...branchScope(user) },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    const done = await this.prisma.creditNote.findUnique({ where: { id: input.requestId } });
    if (done) return this.retry(user, done, input);
    if (invoice.status !== 'APPROVED') {
      throw new ConflictException('Only an approved invoice takes a credit note');
    }
    const amount = await this.checkInput(input, invoice);
    try {
      await this.prisma.creditNote.create({
        data: {
          id: input.requestId,
          branchId: invoice.branchId,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          creditDate: toDbDate(input.creditDate),
          amount,
          reason: input.reason,
          createdById: user.id,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.creditNote.findUnique({ where: { id: input.requestId } });
      if (!raced) throw error;
      return this.retry(user, raced, input);
    }
    return this.get(user, input.requestId);
  }

  /** An exact retry returns the credit note the request created; any other reuse is a 409. */
  private retry(
    user: AuthUser,
    existing: {
      id: string;
      invoiceId: string;
      createdById: string;
      creditDate: Date;
      amount: Decimal;
      reason: string;
    },
    input: CreateCreditNoteRequest,
  ): Promise<CreditNoteDto> {
    const same =
      existing.invoiceId === input.invoiceId &&
      existing.createdById === user.id &&
      fromDbDate(existing.creditDate) === input.creditDate &&
      existing.amount.eq(dec(input.amount)) &&
      existing.reason === input.reason;
    if (!same) throw new ConflictException('This request id was already used: send a new id');
    return this.get(user, existing.id);
  }

  async update(user: AuthUser, id: string, input: CreditNoteInput): Promise<CreditNoteDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('Only a draft credit note is edited');
    }
    const invoice = await this.prisma.customerInvoice.findUniqueOrThrow({
      where: { id: existing.invoiceId },
    });
    const amount = await this.checkInput(input, invoice);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, 'DRAFT');
      await tx.creditNote.update({
        where: { id },
        data: { creditDate: toDbDate(input.creditDate), amount, reason: input.reason },
      });
    });
    return this.get(user, id);
  }

  /**
   * Numbers the credit note and posts its entry (rule 6), with the invoice locked: the amount must
   * still fit what the invoice has open, after any payment or credit note approved meanwhile.
   */
  async approve(user: AuthUser, id: string): Promise<CreditNoteDto> {
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, 'DRAFT');
      const note = await tx.creditNote.findUniqueOrThrow({ where: { id } });
      const invoice = await lockInvoice(tx, note.invoiceId);
      if (
        invoice.status !== 'APPROVED' ||
        !invoice.journalEntryId ||
        !invoice.receivableAccountId
      ) {
        throw new ConflictException('The invoice is not approved');
      }
      const open = openAmount(invoice);
      if (note.amount.gt(open)) {
        throw new BadRequestException(
          `Invoice ${invoice.number ?? ''} has ${open.toFixed()} ${invoice.currency} left`,
        );
      }
      const currency = await this.currencies.requireRecorded(invoice.currency);
      const cleared = relievedUsd(
        {
          total: invoice.total,
          totalUsd: invoice.totalUsd,
          paidAmount: invoice.paidAmount.plus(invoice.creditedAmount),
          paidUsd: invoice.paidUsd.plus(invoice.creditedUsd),
        },
        note.amount,
        invoice.fxRate,
        invoice.currency,
        USD_DECIMALS,
      );
      const creditDate = fromDbDate(note.creditDate);
      const year = creditDate.slice(0, 4);
      const number = formatDocumentNumber(
        'CN',
        await nextSequenceValue(tx, 'CREDIT_NOTE', year),
        year,
      );
      const entry = await this.autoJournal.creditNoteApproved(
        tx,
        {
          id,
          number,
          branchId: invoice.branchId,
          customerId: invoice.customerId,
          shipmentId: invoice.shipmentId,
          invoiceNumber: invoice.number ?? '',
          invoiceEntryId: invoice.journalEntryId,
          isOpening: invoice.isOpening,
          receivableAccountId: invoice.receivableAccountId,
          currency: invoice.currency,
          fxRate: invoice.fxRate,
          currencyDecimals: currency.decimalPlaces,
          creditDate,
          amount: note.amount,
          relievedUsd: cleared,
        },
        user.id,
      );
      await tx.creditNote.update({
        where: { id },
        data: {
          status: 'APPROVED',
          number,
          amountUsd: cleared,
          journalEntryId: entry.id,
          approvedAt: new Date(),
          approvedById: user.id,
        },
      });
      await tx.customerInvoice.update({
        where: { id: invoice.id },
        data: {
          creditedAmount: { increment: note.amount },
          creditedUsd: { increment: cleared },
        },
      });
    });
    return this.get(user, id);
  }

  /** A draft is cancelled with a reason; an approved credit note has posted and stays. */
  async cancel(user: AuthUser, id: string, reason: string): Promise<CreditNoteDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('Only a draft credit note is cancelled');
    }
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, 'DRAFT');
      await tx.creditNote.update({
        where: { id },
        data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() },
      });
    });
    return this.get(user, id);
  }

  /** The amount, checked against the invoice as it is now (approval checks again under lock). */
  private async checkInput(
    input: CreditNoteInput,
    invoice: {
      number: string | null;
      currency: string;
      invoiceDate: Date;
      total: Decimal;
      paidAmount: Decimal;
      creditedAmount: Decimal;
    },
  ): Promise<Decimal> {
    const currency = await this.currencies.requireRecorded(invoice.currency);
    const amount = dec(input.amount);
    if (!amount.gt(0) || !roundMoney(amount, currency.decimalPlaces).eq(amount)) {
      throw new BadRequestException(
        `Amount must be positive with ${currency.decimalPlaces} decimal places`,
      );
    }
    if (input.creditDate < fromDbDate(invoice.invoiceDate)) {
      throw new BadRequestException('A credit note cannot be dated before its invoice');
    }
    const open = openAmount(invoice);
    if (amount.gt(open)) {
      throw new BadRequestException(
        `Invoice ${invoice.number ?? ''} has ${open.toFixed()} ${invoice.currency} left`,
      );
    }
    return amount;
  }

  private async findScoped(user: AuthUser, id: string): Promise<CreditNoteWithDetails> {
    const note = await this.prisma.creditNote.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!note) throw new NotFoundException('Credit note not found');
    return note;
  }
}

function openAmount(invoice: {
  total: Decimal;
  paidAmount: Decimal;
  creditedAmount: Decimal;
}): Decimal {
  return invoice.total.minus(invoice.paidAmount).minus(invoice.creditedAmount);
}

async function lockStatus(tx: Tx, id: string, status: CreditNoteStatus): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "credit_notes" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows[0]?.status !== status) {
    throw new ConflictException('The credit note was changed by someone else; reload it');
  }
}

/** The invoice under a row lock, as receipts take it, so payments and credits serialize. */
async function lockInvoice(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "customer_invoices" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return tx.customerInvoice.findUniqueOrThrow({ where: { id } });
}

function toSummary(n: CreditNoteWithDetails): CreditNoteSummaryDto {
  return {
    id: n.id,
    number: n.number,
    branchId: n.branchId,
    invoiceId: n.invoiceId,
    invoiceNumber: n.invoice.number ?? '',
    customerId: n.customerId,
    customerName: n.customer.name,
    creditDate: fromDbDate(n.creditDate),
    currency: n.invoice.currency,
    amount: n.amount.toFixed(),
    status: n.status,
  };
}

function toDto(n: CreditNoteWithDetails, user: AuthUser): CreditNoteDto {
  const isDraft = n.status === 'DRAFT';
  return {
    ...toSummary(n),
    fxRate: n.invoice.fxRate.toFixed(),
    amountUsd: n.amountUsd?.toFixed() ?? null,
    reason: n.reason,
    invoiceBalance: openAmount(n.invoice).toFixed(),
    journalEntryId: n.journalEntryId,
    journalEntryNumber: n.journalEntry?.number ?? null,
    approvedAt: n.approvedAt?.toISOString() ?? null,
    cancelReason: n.cancelReason,
    actions: {
      canEdit: isDraft && user.permissions.has('credit_notes:update'),
      canApprove: isDraft && user.permissions.has('credit_notes:approve'),
      canCancel: isDraft && user.permissions.has('credit_notes:cancel'),
    },
  };
}
