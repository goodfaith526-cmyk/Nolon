import { Injectable } from '@nestjs/common';
import { BASE_CURRENCY } from '@nolon/shared';
import { fromDbDate } from '../common/dates.js';
import { type Decimal, ZERO, dec } from '../common/money.js';
import type { JournalEntry, Prisma } from '../generated/prisma/client.js';
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
 * The automatic entry rules of annex C, in one service (AGENTS.md: journal entries come from the
 * auto-journal rules service). Other modules call it inside their own transaction, so a document
 * and its entry are written together or not at all.
 */
@Injectable()
export class AutoJournalService {
  constructor(
    private readonly journal: JournalService,
    private readonly accounts: AccountsService,
  ) {}

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
        description: sameRate ? 'Rounding' : 'Realized exchange difference',
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
