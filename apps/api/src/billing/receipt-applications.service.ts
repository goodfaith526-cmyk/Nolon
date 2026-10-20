import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ApplyReceiptRequest, ReceiptApplicableInvoiceDto, ReceiptDto } from '@nolon/shared';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { ZERO, dec } from '../common/money.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma, ReceiptApplication } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { checkApplication } from './receipt-application-rules.js';
import { ReceiptsService, lockInvoices, requireReceivable } from './receipts.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Applying a receipt's advance to a later invoice, and reversing that (decision z6). A receipt
 * holds as an advance what it did not allocate when recorded; staff later apply part of it to an
 * approved invoice of the same customer, branch and currency. Each application posts its own
 * entry (advance to receivable) and pays the invoice as an allocation does. A mistaken one is
 * reversed: the reversing entry is posted and the invoice reopened; nothing is deleted.
 *
 * Every write locks the receipt row first, then the invoice, as cancelling a receipt does, so two
 * applications of one receipt run one after the other and never apply the same balance twice.
 */
@Injectable()
export class ReceiptApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly currencies: CurrenciesService,
    private readonly receipts: ReceiptsService,
  ) {}

  /**
   * The approved invoices the receipt's advance can be paid to now: the receipt's customer,
   * branch and currency, with a balance left, oldest first. Read only; applying checks again.
   */
  async applicableInvoices(
    user: AuthUser,
    receiptId: string,
  ): Promise<ReceiptApplicableInvoiceDto[]> {
    const receipt = await this.findReceipt(user, receiptId);
    if (receipt.status !== 'POSTED') return [];
    const invoices = await this.prisma.customerInvoice.findMany({
      where: {
        ...branchScope(user),
        branchId: receipt.branchId,
        customerId: receipt.customerId,
        currency: receipt.currency,
        status: 'APPROVED',
      },
      select: {
        id: true,
        number: true,
        invoiceDate: true,
        dueDate: true,
        total: true,
        paidAmount: true,
        creditedAmount: true,
      },
      orderBy: [{ invoiceDate: 'asc' }, { number: 'asc' }, { id: 'asc' }],
    });
    return invoices.flatMap((i) => {
      const balance = i.total.minus(i.paidAmount).minus(i.creditedAmount);
      if (!balance.gt(0)) return [];
      return [
        {
          invoiceId: i.id,
          invoiceNumber: i.number ?? '',
          invoiceDate: fromDbDate(i.invoiceDate),
          dueDate: fromDbDate(i.dueDate),
          balance: balance.toFixed(),
        },
      ];
    });
  }

  /**
   * Applies part of the receipt's advance to an invoice, in one transaction: the entry, the
   * application and the invoice's paid amounts. The request id becomes the application's id: a
   * retry of the same request returns the receipt without posting again; another request with
   * that id is refused (409). Returns the receipt.
   */
  async apply(user: AuthUser, receiptId: string, input: ApplyReceiptRequest): Promise<ReceiptDto> {
    const receipt = await this.findReceipt(user, receiptId);
    const existing = await this.prisma.receiptApplication.findUnique({
      where: { id: input.requestId },
    });
    if (existing) {
      sameRequest(user, receiptId, existing, input);
      return this.receipts.get(user, receiptId);
    }
    const currency = await this.currencies.requireRecorded(receipt.currency);
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockPostedReceipt(tx, receiptId);
        // A retry that waited on the lock behind its own first attempt replays it here, before
        // the balances that attempt used up are checked again.
        const replay = await tx.receiptApplication.findUnique({ where: { id: input.requestId } });
        if (replay) {
          sameRequest(user, receiptId, replay, input);
          return;
        }
        const invoices = await lockInvoices(tx, [input.invoiceId]);
        const invoice = invoices.get(input.invoiceId);
        if (!invoice) throw new NotFoundException('Invoice not found');
        const advance = await this.autoJournal.advanceOf(tx, receipt.journalEntryId);
        if (!advance) throw new BadRequestException('This receipt holds no advance to apply');
        const applied = await tx.receiptApplication.aggregate({
          where: { receiptId, status: 'ACTIVE' },
          _sum: { amount: true, advanceUsd: true },
        });
        const amount = dec(input.amount);
        const usd = checkApplication({
          receipt: {
            branchId: receipt.branchId,
            customerId: receipt.customerId,
            currency: receipt.currency,
            fxRate: receipt.fxRate,
            receiptDate: fromDbDate(receipt.receiptDate),
          },
          advance,
          applied: {
            amount: applied._sum.amount ?? ZERO,
            advanceUsd: applied._sum.advanceUsd ?? ZERO,
          },
          invoice: { ...invoice, invoiceDate: fromDbDate(invoice.invoiceDate) },
          amount,
          currencyDecimals: currency.decimalPlaces,
          applicationDate: input.applicationDate,
        });
        const entry = await this.autoJournal.receiptApplied(
          tx,
          {
            id: input.requestId,
            branchId: receipt.branchId,
            customerId: receipt.customerId,
            applicationDate: input.applicationDate,
            currency: receipt.currency,
            receiptNumber: receipt.number,
            receiptFxRate: receipt.fxRate,
            advanceAccountId: advance.accountId,
            invoiceNumber: invoice.number ?? '',
            invoiceFxRate: invoice.fxRate,
            receivableAccountId: requireReceivable(invoice),
            shipmentId: invoice.shipmentId,
            amount,
            advanceUsd: usd.advanceUsd,
            relievedUsd: usd.relievedUsd,
          },
          user.id,
        );
        await tx.receiptApplication.create({
          data: {
            id: input.requestId,
            receiptId,
            invoiceId: invoice.id,
            branchId: receipt.branchId,
            applicationDate: toDbDate(input.applicationDate),
            amount,
            advanceUsd: usd.advanceUsd,
            relievedUsd: usd.relievedUsd,
            journalEntryId: entry.id,
            createdById: user.id,
          },
        });
        await tx.customerInvoice.update({
          where: { id: invoice.id },
          data: {
            paidAmount: { increment: amount },
            paidUsd: { increment: usd.relievedUsd },
          },
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The same request id, applied meanwhile by a concurrent retry.
      const raced = await this.prisma.receiptApplication.findUnique({
        where: { id: input.requestId },
      });
      if (!raced) throw error;
      sameRequest(user, receiptId, raced, input);
    }
    return this.receipts.get(user, receiptId);
  }

  /**
   * Reverses an active application: posts the reversing entry of its entry, dated today in the
   * receipt's branch, gives the amount back to the advance and reopens the invoice by it. The
   * application is kept, marked REVERSED with the reason.
   */
  async reverse(
    user: AuthUser,
    receiptId: string,
    applicationId: string,
    reason: string,
  ): Promise<ReceiptDto> {
    const receipt = await this.findReceipt(user, receiptId);
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: receipt.branchId } });
    const today = todayIn(branch.timezone);
    await this.prisma.$transaction(async (tx) => {
      // The receipt's lock orders this after any application or cancellation of the receipt.
      await tx.$queryRaw`SELECT "id" FROM "receipts" WHERE "id" = ${receiptId}::uuid FOR UPDATE`;
      const application = await tx.receiptApplication.findFirst({
        where: { id: applicationId, receiptId },
      });
      if (!application) throw new NotFoundException('Application not found');
      if (application.status !== 'ACTIVE') {
        throw new ConflictException('This application is already reversed');
      }
      await lockInvoices(tx, [application.invoiceId]);
      const reversal = await this.autoJournal.reverseDocumentEntry(
        tx,
        application.journalEntryId,
        today,
        user.id,
        `Reversal of the advance of receipt ${receipt.number} applied to an invoice: ${reason}`,
      );
      await tx.receiptApplication.update({
        where: { id: application.id },
        data: {
          status: 'REVERSED',
          reverseJournalEntryId: reversal.id,
          reverseReason: reason,
          reversedAt: new Date(),
          reversedById: user.id,
        },
      });
      await tx.customerInvoice.update({
        where: { id: application.invoiceId },
        data: {
          paidAmount: { decrement: application.amount },
          paidUsd: { decrement: application.relievedUsd },
        },
      });
    });
    return this.receipts.get(user, receiptId);
  }

  /** 404 unless the receipt is in one of the user's branches. */
  private async findReceipt(user: AuthUser, id: string) {
    const receipt = await this.prisma.receipt.findFirst({ where: { id, ...branchScope(user) } });
    if (!receipt) throw new NotFoundException('Receipt not found');
    return receipt;
  }
}

/** Locks the receipt row; 409 once it is cancelled. */
async function lockPostedReceipt(tx: Tx, receiptId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "receipts" WHERE "id" = ${receiptId}::uuid FOR UPDATE`;
  if (rows[0]?.status !== 'POSTED') {
    throw new ConflictException('The receipt is cancelled: its advance cannot be applied');
  }
}

/** A retry is the same request by the same user; anything else reusing the id is refused. */
function sameRequest(
  user: AuthUser,
  receiptId: string,
  existing: ReceiptApplication,
  input: ApplyReceiptRequest,
): void {
  const same =
    existing.receiptId === receiptId &&
    existing.invoiceId === input.invoiceId &&
    existing.createdById === user.id &&
    existing.amount.eq(dec(input.amount)) &&
    fromDbDate(existing.applicationDate) === input.applicationDate;
  if (!same) throw new ConflictException('This request id was already used: send a new id');
}
