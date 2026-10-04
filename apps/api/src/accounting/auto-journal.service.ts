import { Injectable } from '@nestjs/common';
import { BASE_CURRENCY } from '@nolon/shared';
import { fromDbDate } from '../common/dates.js';
import { type Decimal, ZERO, dec } from '../common/money.js';
import type { JournalEntry, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';
import { type LineSpec, toUsd } from './journal-math.js';
import { JournalService } from './journal.service.js';

type Tx = Prisma.TransactionClient;

export interface InvoiceForPosting {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  shipmentId: string;
  currency: string;
  fxRate: Decimal;
  invoiceDate: Date;
  total: Decimal;
  totalUsd: Decimal;
  lines: readonly { chargeTypeCode: string; lineTotal: Decimal }[];
}

export interface ReceiptForPosting {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  receiptDate: Date;
  currency: string;
  fxRate: Decimal;
  amount: Decimal;
  cashAccountId: string;
  /** Each in the receipt currency, at the invoice's own rate, against its own receivable. */
  allocations: readonly {
    invoiceNumber: string;
    receivableAccountId: string;
    shipmentId: string;
    invoiceFxRate: Decimal;
    amount: Decimal;
    relievedUsd: Decimal;
  }[];
}

/**
 * Description of the line that books a receipt's realized exchange difference (annex C section 3).
 * Reports find realized FX by it, inside receipt entries and their reversals, so a later remap of
 * FX_GAIN or FX_LOSS does not hide earlier differences.
 */
export const FX_DIFFERENCE_LINE = 'Realized exchange difference';

/** A trip cost and how it is shared between the trip's shipments (rules 10 and 11). */
export interface TripCostForPosting {
  /** The expense (rule 10) or the trip (rule 11) the entry is made from. */
  sourceId: string;
  tripNumber: string;
  branchId: string;
  /** YYYY-MM-DD: the expense date, or the day the trip was completed. */
  entryDate: string;
  currency: string;
  fxRate: Decimal;
  amount: Decimal;
  description: string;
  /** In `currency`, adding up to `amount` (transport-rules splitTripCost). */
  shares: readonly { shipmentId: string; amount: Decimal }[];
}

/**
 * The automatic entry rules of annex C, in one service (AGENTS.md: journal entries come from the
 * auto-journal rules service). Other modules call it inside their own transaction, so a document
 * and its entry are written together or not at all.
 */
@Injectable()
export class AutoJournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly accounts: AccountsService,
  ) {}

  /**
   * How trip cost entries (rules 10 and 11) were shared between shipments: the debit lines that
   * carry a shipment of `branchId`, per entry, in the entry's currency.
   */
  async shipmentShares(
    entryIds: readonly string[],
    branchId: string,
  ): Promise<Map<string, { shipmentId: string; shipmentNumber: string; amount: Decimal }[]>> {
    const result = new Map<
      string,
      { shipmentId: string; shipmentNumber: string; amount: Decimal }[]
    >();
    if (entryIds.length === 0) return result;
    const lines = await this.prisma.journalLine.findMany({
      where: {
        entryId: { in: [...entryIds] },
        shipmentId: { not: null },
        debit: { gt: 0 },
        // Only the branch's own shipments: a share never shows another branch's shipment number.
        shipment: { branchId },
      },
      select: {
        entryId: true,
        shipmentId: true,
        debit: true,
        shipment: { select: { number: true } },
      },
      orderBy: [{ entryId: 'asc' }, { lineNo: 'asc' }],
    });
    for (const line of lines) {
      if (!line.shipmentId || !line.shipment) continue;
      const list = result.get(line.entryId) ?? [];
      list.push({
        shipmentId: line.shipmentId,
        shipmentNumber: line.shipment.number,
        amount: line.debit,
      });
      result.set(line.entryId, list);
    }
    return result;
  }

  /**
   * Rule 1 and 2, customer invoice approved: debit the receivable with the total; credit each
   * charge's revenue account (or the reimbursable clearing account). Returns the receivable
   * account used, which the invoice keeps: its receipts clear it there even after a remap.
   */
  async customerInvoiceApproved(
    tx: Tx,
    invoice: InvoiceForPosting,
    userId: string,
  ): Promise<{ entry: JournalEntry; receivableAccountId: string }> {
    const receivableAccountId = await this.accounts.roleAccount(tx, 'RECEIVABLE');
    const revenueByCharge = await this.accounts.revenueAccounts(
      tx,
      invoice.lines.map((l) => l.chargeTypeCode),
    );
    const byAccount = new Map<string, Decimal>();
    for (const line of invoice.lines) {
      if (line.lineTotal.isZero()) continue;
      const accountId = revenueByCharge.get(line.chargeTypeCode);
      if (!accountId) throw new Error(`No revenue account for ${line.chargeTypeCode}`);
      byAccount.set(accountId, (byAccount.get(accountId) ?? ZERO).plus(line.lineTotal));
    }
    const common = {
      branchId: invoice.branchId,
      currency: invoice.currency,
      fxRate: invoice.fxRate,
      customerId: invoice.customerId,
      shipmentId: invoice.shipmentId,
    };
    const lines: LineSpec[] = [
      {
        ...common,
        accountId: receivableAccountId,
        side: 'DEBIT',
        amount: invoice.total,
        amountUsd: invoice.totalUsd,
        description: invoice.number,
      },
      ...[...byAccount].map(([accountId, amount]): LineSpec => ({
        ...common,
        accountId,
        side: 'CREDIT',
        amount,
      })),
    ];
    const entry = await this.journal.post(
      tx,
      {
        branchId: invoice.branchId,
        entryDate: fromDbDate(invoice.invoiceDate),
        description: `Customer invoice ${invoice.number}`,
        source: 'CUSTOMER_INVOICE',
        sourceId: invoice.id,
        userId,
      },
      lines,
    );
    return { entry, receivableAccountId };
  }

  /**
   * Rules 3 and 4, receipt recorded: debit the cash account; credit the receivable each invoice
   * was posted to (not the role's current account) at the invoice's own USD value, and the customer advances account with the rest.
   * The USD difference between the cash received and the receivable cleared is the realized
   * exchange gain or loss (annex C section 3); when every rate is the same, it is only rounding.
   */
  async receiptRecorded(tx: Tx, receipt: ReceiptForPosting, userId: string): Promise<JournalEntry> {
    const advances = await this.accounts.roleAccount(tx, 'CUSTOMER_ADVANCES');
    const common = {
      branchId: receipt.branchId,
      currency: receipt.currency,
      customerId: receipt.customerId,
    };
    const cashUsd = toUsd(receipt.amount, receipt.fxRate, receipt.currency);
    const lines: LineSpec[] = [
      {
        ...common,
        accountId: receipt.cashAccountId,
        fxRate: receipt.fxRate,
        side: 'DEBIT',
        amount: receipt.amount,
        amountUsd: cashUsd,
        description: receipt.number,
      },
    ];
    let allocated = ZERO;
    let creditedUsd = ZERO;
    for (const a of receipt.allocations) {
      lines.push({
        ...common,
        accountId: a.receivableAccountId,
        fxRate: a.invoiceFxRate,
        shipmentId: a.shipmentId,
        side: 'CREDIT',
        amount: a.amount,
        amountUsd: a.relievedUsd,
        description: a.invoiceNumber,
      });
      allocated = allocated.plus(a.amount);
      creditedUsd = creditedUsd.plus(a.relievedUsd);
    }
    const advance = receipt.amount.minus(allocated);
    if (advance.lt(0)) throw new Error('Allocations exceed the receipt');
    if (advance.gt(0)) {
      const advanceUsd = toUsd(advance, receipt.fxRate, receipt.currency);
      lines.push({
        ...common,
        accountId: advances,
        fxRate: receipt.fxRate,
        side: 'CREDIT',
        amount: advance,
        amountUsd: advanceUsd,
        description: 'Advance',
      });
      creditedUsd = creditedUsd.plus(advanceUsd);
    }
    const difference = cashUsd.minus(creditedUsd);
    if (!difference.isZero()) {
      const sameRate = receipt.allocations.every((a) => a.invoiceFxRate.eq(receipt.fxRate));
      const role = sameRate ? 'ROUNDING' : difference.gt(0) ? 'FX_GAIN' : 'FX_LOSS';
      lines.push({
        branchId: receipt.branchId,
        customerId: receipt.customerId,
        accountId: await this.accounts.roleAccount(tx, role),
        currency: BASE_CURRENCY,
        fxRate: dec(1),
        side: difference.gt(0) ? 'CREDIT' : 'DEBIT',
        amount: difference.abs(),
        amountUsd: difference.abs(),
        description: sameRate ? 'Rounding' : FX_DIFFERENCE_LINE,
      });
    }
    return this.journal.post(
      tx,
      {
        branchId: receipt.branchId,
        entryDate: fromDbDate(receipt.receiptDate),
        description: `Receipt ${receipt.number}`,
        source: 'RECEIPT',
        sourceId: receipt.id,
        userId,
      },
      lines,
    );
  }

  /**
   * Rule 10, expense of an own-vehicle trip: debit transport cost, one line per shipment of the
   * trip with its share; credit the cash or bank account it was paid from.
   */
  tripExpensePosted(
    tx: Tx,
    expense: TripCostForPosting & { number: string; cashAccountId: string },
    userId: string,
  ): Promise<JournalEntry> {
    return this.postTripCost(
      tx,
      expense,
      { accountId: expense.cashAccountId, description: expense.number },
      'TRIP_EXPENSE',
      `Trip expense ${expense.number} (${expense.tripNumber}): ${expense.description}`,
      userId,
    );
  }

  /**
   * Rule 11, external carrier trip completed: debit transport cost, one line per shipment with
   * its share of the agreed cost; credit accrued transport costs, which the carrier's bill
   * (rule 11a) later clears.
   */
  async tripAccrued(tx: Tx, trip: TripCostForPosting, userId: string): Promise<JournalEntry> {
    const accrued = await this.accounts.roleAccount(tx, 'ACCRUED_TRANSPORT');
    return this.postTripCost(
      tx,
      trip,
      { accountId: accrued, description: trip.tripNumber },
      'TRIP_ACCRUAL',
      `Trip ${trip.tripNumber} completed: accrued carrier cost`,
      userId,
    );
  }

  /**
   * Transport cost goes to the DEFAULT_COST role: the accountant maps it in the settings (annex
   * C: account names are generic and remapped without code). Shares of zero (an amount with fewer
   * minor units than shipments) get no line. Per-line USD rounding goes to the rounding account.
   */
  private async postTripCost(
    tx: Tx,
    cost: TripCostForPosting,
    credit: { accountId: string; description: string },
    source: 'TRIP_EXPENSE' | 'TRIP_ACCRUAL',
    description: string,
    userId: string,
  ): Promise<JournalEntry> {
    const costAccount = await this.accounts.roleAccount(tx, 'DEFAULT_COST');
    const common = { branchId: cost.branchId, currency: cost.currency, fxRate: cost.fxRate };
    let shared = ZERO;
    const lines: LineSpec[] = [];
    for (const share of cost.shares) {
      shared = shared.plus(share.amount);
      if (share.amount.isZero()) continue;
      lines.push({
        ...common,
        accountId: costAccount,
        side: 'DEBIT',
        amount: share.amount,
        shipmentId: share.shipmentId,
        description: cost.tripNumber,
      });
    }
    if (!shared.eq(cost.amount)) throw new Error('The shares do not add up to the trip cost');
    lines.push({
      ...common,
      accountId: credit.accountId,
      side: 'CREDIT',
      amount: cost.amount,
      description: credit.description,
    });
    return this.journal.post(
      tx,
      {
        branchId: cost.branchId,
        entryDate: cost.entryDate,
        description,
        source,
        sourceId: cost.sourceId,
        userId,
      },
      lines,
    );
  }

  /** A cancelled document's entry is reversed, dated the day it is cancelled. */
  reverseDocumentEntry(
    tx: Tx,
    entryId: string,
    entryDate: string,
    userId: string,
    description: string,
  ): Promise<JournalEntry> {
    return this.journal.reverse(tx, entryId, entryDate, userId, description);
  }
}
