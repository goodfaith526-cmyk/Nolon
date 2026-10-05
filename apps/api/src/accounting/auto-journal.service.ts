import { Injectable } from '@nestjs/common';
import { BASE_CURRENCY } from '@nolon/shared';
import { fromDbDate } from '../common/dates.js';
import { type Decimal, ZERO, dec } from '../common/money.js';
import type { JournalEntry, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';
import { type LineSpec, USD_DECIMALS, splitAmount, toUsd } from './journal-math.js';
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

/** Rule 6: an approved credit note against an approved invoice. */
export interface CreditNoteForPosting {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  shipmentId: string | null;
  invoiceNumber: string;
  /** The invoice's entry: its revenue lines are the accounts the credit note debits. */
  invoiceEntryId: string;
  /**
   * An opening item (rule 15): its entry credited opening equity, so the credit note debits
   * OPENING_EQUITY back rather than any revenue account.
   */
  isOpening: boolean;
  receivableAccountId: string;
  currency: string;
  /** The invoice's rate. */
  fxRate: Decimal;
  currencyDecimals: number;
  creditDate: string;
  amount: Decimal;
  /** The receivable's USD carrying value the credit note clears. */
  relievedUsd: Decimal;
}

/** A supplier bill line, resolved to what it posts (rules 7, 8, 11a and 12). */
export type BillLineForPosting =
  | { kind: 'SHIPMENT_COST'; chargeTypeCode: string; shipmentId: string; amount: Decimal }
  | { kind: 'EXPENSE'; accountId: string; amount: Decimal }
  | {
      kind: 'TRIP';
      tripId: string;
      tripNumber: string;
      /** The trip's rule 11 entry, which the line clears. */
      accrualEntryId: string;
      amount: Decimal;
    };

export interface SupplierBillForPosting {
  id: string;
  number: string;
  branchId: string;
  supplierId: string;
  currency: string;
  fxRate: Decimal;
  billDate: string;
  total: Decimal;
  totalUsd: Decimal;
  lines: readonly (BillLineForPosting & { description: string | null })[];
}

export interface SupplierPaymentForPosting {
  id: string;
  number: string;
  branchId: string;
  supplierId: string;
  paymentDate: string;
  currency: string;
  fxRate: Decimal;
  amount: Decimal;
  cashAccountId: string;
  /** Each in the payment currency, at the bill's own rate, against its own payable. */
  allocations: readonly {
    billNumber: string;
    payableAccountId: string;
    billFxRate: Decimal;
    amount: Decimal;
    relievedUsd: Decimal;
  }[];
}

export interface ExpenseForPosting {
  id: string;
  number: string;
  branchId: string;
  expenseDate: string;
  description: string;
  currency: string;
  fxRate: Decimal;
  amount: Decimal;
  expenseAccountId: string;
  cashAccountId: string;
}

/** A customer's or supplier's open item at go-live (rule 15). */
export interface OpeningItemForPosting {
  sourceId: string;
  number: string;
  reference: string;
  branchId: string;
  entryDate: string;
  currency: string;
  fxRate: Decimal;
  amount: Decimal;
  amountUsd: Decimal;
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
   * carry a shipment visible in `branchId`, per entry, in the entry's currency.
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
        // Only shipments visible in the branch (owned or received): a share never shows the
        // number of a shipment the branch cannot see.
        shipment: { OR: [{ branchId }, { sharedBranches: { some: { branchId } } }] },
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
   * Transport cost goes to the TRANSPORT_COST role (annex C rules 10 and 11, "transport cost"):
   * the accountant maps it in the settings (account names are generic and remapped without code).
   * The difference of a carrier bill (rule 11a) follows the accrual's cost lines. Shares of zero (an amount with fewer
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
    const costAccount = await this.accounts.roleAccount(tx, 'TRANSPORT_COST');
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

  /**
   * Rule 6, credit note approved: debit the revenue (or reimbursable) accounts the invoice
   * credited, sharing the amount in proportion to what each received, at the invoice's rate;
   * credit the invoice's own receivable with the USD carrying value cleared. A credit note on an
   * opening item debits OPENING_EQUITY instead, the account the opening item credited: reducing a
   * balance brought forward is not revenue of the current period. The carrying value cleared can differ
   * from the debits at the invoice rate by the cents earlier partial settlements rounded; that
   * difference is booked to the rounding account explicitly, as a receipt does.
   */
  async creditNoteApproved(
    tx: Tx,
    note: CreditNoteForPosting,
    userId: string,
  ): Promise<JournalEntry> {
    const common = {
      branchId: note.branchId,
      currency: note.currency,
      fxRate: note.fxRate,
      customerId: note.customerId,
      shipmentId: note.shipmentId,
    };
    const lines: LineSpec[] = [];
    if (note.isOpening) {
      lines.push({
        ...common,
        accountId: await this.accounts.roleAccount(tx, 'OPENING_EQUITY'),
        side: 'DEBIT',
        amount: note.amount,
      });
    } else {
      const invoiceLines = await tx.journalLine.findMany({
        where: {
          entryId: note.invoiceEntryId,
          credit: { gt: 0 },
          currency: note.currency,
          NOT: { accountId: note.receivableAccountId },
        },
        orderBy: { lineNo: 'asc' },
      });
      // The rounding line of an invoice entry is in USD at rate 1; only charge lines remain.
      const revenue = invoiceLines.filter(
        (l) => l.fxRate.eq(note.fxRate) && l.description !== 'Rounding',
      );
      if (revenue.length === 0) {
        throw new Error(`Invoice ${note.invoiceNumber} has no revenue lines`);
      }
      const shares = splitAmount(
        note.amount,
        revenue.map((l) => l.credit),
        note.currencyDecimals,
      );
      revenue.forEach((line, index) => {
        const amount = shares[index] ?? ZERO;
        if (amount.isZero()) return;
        lines.push({ ...common, accountId: line.accountId, side: 'DEBIT', amount });
      });
    }
    let debitUsd = ZERO;
    for (const line of lines)
      debitUsd = debitUsd.plus(toUsd(line.amount, line.fxRate, line.currency));
    lines.push({
      ...common,
      accountId: note.receivableAccountId,
      side: 'CREDIT',
      amount: note.amount,
      amountUsd: note.relievedUsd,
      description: note.invoiceNumber,
    });
    const difference = debitUsd.minus(note.relievedUsd);
    if (!difference.isZero()) {
      lines.push({
        branchId: note.branchId,
        customerId: note.customerId,
        accountId: await this.accounts.roleAccount(tx, 'ROUNDING'),
        currency: BASE_CURRENCY,
        fxRate: dec(1),
        side: difference.gt(0) ? 'CREDIT' : 'DEBIT',
        amount: difference.abs(),
        amountUsd: difference.abs(),
        description: 'Rounding',
      });
    }
    return this.journal.post(
      tx,
      {
        branchId: note.branchId,
        entryDate: note.creditDate,
        description: `Credit note ${note.number} on invoice ${note.invoiceNumber}`,
        source: 'CREDIT_NOTE',
        sourceId: note.id,
        userId,
      },
      lines,
    );
  }

  /**
   * Rules 7, 8, 11a and 12, supplier bill approved: credit the payable with the total (supplier
   * dimension) and debit, per line,
   * - a shipment cost: the charge type's cost account (the reimbursable clearing account for a
   *   reimbursable charge), with the shipment;
   * - a general expense: the category's expense account;
   * - a carrier's trip: the accrued transport account, with exactly what the trip's rule 11
   *   entry accrued there (amount, rate and USD value), so the accrual is cleared. Any USD
   *   difference between the billed and the accrued cost goes to the transport cost account the
   *   accrual debited, shared by the trip's shipments as the accrual was.
   * Returns the payable account used, which the bill keeps: its payments clear it there.
   */
  async supplierBillApproved(
    tx: Tx,
    bill: SupplierBillForPosting,
    userId: string,
  ): Promise<{ entry: JournalEntry; payableAccountId: string }> {
    const payableAccountId = await this.accounts.roleAccount(tx, 'PAYABLE');
    const costAccounts = await this.accounts.costAccounts(
      tx,
      bill.lines.flatMap((l) => (l.kind === 'SHIPMENT_COST' ? [l.chargeTypeCode] : [])),
    );
    const common = { branchId: bill.branchId, currency: bill.currency, fxRate: bill.fxRate };
    const lines: LineSpec[] = [];
    for (const line of bill.lines) {
      if (line.kind === 'SHIPMENT_COST') {
        const accountId = costAccounts.get(line.chargeTypeCode);
        if (!accountId) throw new Error(`No cost account for ${line.chargeTypeCode}`);
        lines.push({
          ...common,
          accountId,
          side: 'DEBIT',
          amount: line.amount,
          shipmentId: line.shipmentId,
          supplierId: bill.supplierId,
          description: line.description,
        });
      } else if (line.kind === 'EXPENSE') {
        lines.push({
          ...common,
          accountId: line.accountId,
          side: 'DEBIT',
          amount: line.amount,
          supplierId: bill.supplierId,
          description: line.description,
        });
      } else {
        lines.push(...(await this.accrualClearingLines(tx, bill, line)));
      }
    }
    lines.push({
      ...common,
      accountId: payableAccountId,
      side: 'CREDIT',
      amount: bill.total,
      amountUsd: bill.totalUsd,
      supplierId: bill.supplierId,
      description: bill.number,
    });
    const entry = await this.journal.post(
      tx,
      {
        branchId: bill.branchId,
        entryDate: bill.billDate,
        description: `Supplier bill ${bill.number}`,
        source: 'SUPPLIER_BILL',
        sourceId: bill.id,
        userId,
      },
      lines,
    );
    return { entry, payableAccountId };
  }

  /** Rule 11a: the lines that clear one trip's accrual, and the cost difference if any. */
  private async accrualClearingLines(
    tx: Tx,
    bill: SupplierBillForPosting,
    line: Extract<BillLineForPosting, { kind: 'TRIP' }>,
  ): Promise<LineSpec[]> {
    const accrual = await tx.journalLine.findMany({
      where: { entryId: line.accrualEntryId },
      orderBy: { lineNo: 'asc' },
    });
    const accrued = accrual.find(
      (l) => l.shipmentId === null && l.credit.gt(0) && l.description !== 'Rounding',
    );
    const costs = accrual.filter((l) => l.shipmentId !== null && l.debit.gt(0));
    if (!accrued || costs.length === 0) {
      throw new Error(`Trip ${line.tripNumber} has no accrual to clear`);
    }
    if (accrued.currency !== bill.currency) {
      throw new Error(`Trip ${line.tripNumber} was accrued in ${accrued.currency}`);
    }
    const lines: LineSpec[] = [
      {
        accountId: accrued.accountId,
        branchId: accrued.branchId,
        currency: accrued.currency,
        fxRate: accrued.fxRate,
        side: 'DEBIT',
        amount: accrued.credit,
        amountUsd: accrued.creditUsd,
        tripId: line.tripId,
        supplierId: bill.supplierId,
        description: line.tripNumber,
      },
    ];
    const difference = toUsd(line.amount, bill.fxRate, bill.currency).minus(accrued.creditUsd);
    if (difference.isZero()) return lines;
    const shares = splitAmount(
      difference.abs(),
      costs.map((c) => c.debitUsd),
      USD_DECIMALS,
    );
    costs.forEach((cost, index) => {
      const amount = shares[index] ?? ZERO;
      if (amount.isZero()) return;
      lines.push({
        accountId: cost.accountId,
        branchId: bill.branchId,
        currency: BASE_CURRENCY,
        fxRate: dec(1),
        side: difference.gt(0) ? 'DEBIT' : 'CREDIT',
        amount,
        amountUsd: amount,
        shipmentId: cost.shipmentId,
        supplierId: bill.supplierId,
        description: `${line.tripNumber}: billed cost difference`,
      });
    });
    return lines;
  }

  /**
   * Rule 9, supplier payment recorded: debit the payable each bill was posted to at the bill's
   * own USD value, credit the cash account. The USD difference is the realized exchange gain or
   * loss (annex C section 3, the reverse of a receipt): paying more USD than the bill carried is
   * a loss. When every rate is the same, it is only rounding.
   */
  async supplierPaymentRecorded(
    tx: Tx,
    payment: SupplierPaymentForPosting,
    userId: string,
  ): Promise<JournalEntry> {
    const common = {
      branchId: payment.branchId,
      currency: payment.currency,
      supplierId: payment.supplierId,
    };
    const cashUsd = toUsd(payment.amount, payment.fxRate, payment.currency);
    let allocated = ZERO;
    let relievedUsd = ZERO;
    const lines: LineSpec[] = payment.allocations.map((a) => {
      allocated = allocated.plus(a.amount);
      relievedUsd = relievedUsd.plus(a.relievedUsd);
      return {
        ...common,
        accountId: a.payableAccountId,
        fxRate: a.billFxRate,
        side: 'DEBIT',
        amount: a.amount,
        amountUsd: a.relievedUsd,
        description: a.billNumber,
      };
    });
    if (!allocated.eq(payment.amount)) throw new Error('A payment is allocated in full');
    lines.push({
      ...common,
      accountId: payment.cashAccountId,
      fxRate: payment.fxRate,
      side: 'CREDIT',
      amount: payment.amount,
      amountUsd: cashUsd,
      description: payment.number,
    });
    const difference = relievedUsd.minus(cashUsd);
    if (!difference.isZero()) {
      const sameRate = payment.allocations.every((a) => a.billFxRate.eq(payment.fxRate));
      const role = sameRate ? 'ROUNDING' : difference.gt(0) ? 'FX_GAIN' : 'FX_LOSS';
      lines.push({
        branchId: payment.branchId,
        supplierId: payment.supplierId,
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
        branchId: payment.branchId,
        entryDate: payment.paymentDate,
        description: `Supplier payment ${payment.number}`,
        source: 'SUPPLIER_PAYMENT',
        sourceId: payment.id,
        userId,
      },
      lines,
    );
  }

  /** Rule 12, general expense approved: debit the category's account, credit the cash account. */
  expenseApproved(tx: Tx, expense: ExpenseForPosting, userId: string): Promise<JournalEntry> {
    const common = {
      branchId: expense.branchId,
      currency: expense.currency,
      fxRate: expense.fxRate,
      amount: expense.amount,
    };
    return this.journal.post(
      tx,
      {
        branchId: expense.branchId,
        entryDate: expense.expenseDate,
        description: `Expense ${expense.number}: ${expense.description}`,
        source: 'EXPENSE',
        sourceId: expense.id,
        userId,
      },
      [
        {
          ...common,
          accountId: expense.expenseAccountId,
          side: 'DEBIT',
          description: expense.description,
        },
        {
          ...common,
          accountId: expense.cashAccountId,
          side: 'CREDIT',
          description: expense.number,
        },
      ],
    );
  }

  /**
   * Rule 15, opening balances of ledger accounts: the lines as entered, and the difference
   * between their USD debits and credits on the OPENING_EQUITY account.
   */
  async openingAccounts(
    tx: Tx,
    opening: { id: string; branchId: string; entryDate: string; description: string },
    specs: readonly LineSpec[],
    userId: string,
  ): Promise<JournalEntry> {
    const equity = await this.accounts.roleAccount(tx, 'OPENING_EQUITY');
    let net = ZERO;
    for (const line of specs) {
      const usd = line.amountUsd ?? toUsd(line.amount, line.fxRate, line.currency);
      net = line.side === 'DEBIT' ? net.plus(usd) : net.minus(usd);
    }
    const lines: LineSpec[] = [...specs];
    if (!net.isZero()) {
      lines.push({
        accountId: equity,
        branchId: opening.branchId,
        currency: BASE_CURRENCY,
        fxRate: dec(1),
        side: net.gt(0) ? 'CREDIT' : 'DEBIT',
        amount: net.abs(),
        description: 'Opening balance equity',
      });
    }
    return this.journal.post(
      tx,
      {
        branchId: opening.branchId,
        entryDate: opening.entryDate,
        description: opening.description,
        source: 'OPENING_BALANCE',
        sourceId: opening.id,
        userId,
      },
      lines,
    );
  }

  /**
   * Rule 15, a customer's open invoice at go-live: debit the receivable (customer dimension),
   * credit opening equity. Returns the receivable account, which the item keeps.
   */
  async openingCustomerItem(
    tx: Tx,
    item: OpeningItemForPosting & { customerId: string },
    userId: string,
  ): Promise<{ entry: JournalEntry; receivableAccountId: string }> {
    const receivableAccountId = await this.accounts.roleAccount(tx, 'RECEIVABLE');
    const entry = await this.openingItem(
      tx,
      item,
      { accountId: receivableAccountId, side: 'DEBIT', customerId: item.customerId },
      `Opening balance: customer invoice ${item.reference} (${item.number})`,
      userId,
    );
    return { entry, receivableAccountId };
  }

  /**
   * Rule 15, a supplier's open bill at go-live: credit the payable (supplier dimension), debit
   * opening equity. Returns the payable account, which the item keeps.
   */
  async openingSupplierItem(
    tx: Tx,
    item: OpeningItemForPosting & { supplierId: string },
    userId: string,
  ): Promise<{ entry: JournalEntry; payableAccountId: string }> {
    const payableAccountId = await this.accounts.roleAccount(tx, 'PAYABLE');
    const entry = await this.openingItem(
      tx,
      item,
      { accountId: payableAccountId, side: 'CREDIT', supplierId: item.supplierId },
      `Opening balance: supplier bill ${item.reference} (${item.number})`,
      userId,
    );
    return { entry, payableAccountId };
  }

  private async openingItem(
    tx: Tx,
    item: OpeningItemForPosting,
    party: Pick<LineSpec, 'accountId' | 'side' | 'customerId' | 'supplierId'>,
    description: string,
    userId: string,
  ): Promise<JournalEntry> {
    const equity = await this.accounts.roleAccount(tx, 'OPENING_EQUITY');
    const common = {
      branchId: item.branchId,
      currency: item.currency,
      fxRate: item.fxRate,
      amount: item.amount,
      amountUsd: item.amountUsd,
      customerId: party.customerId ?? null,
      supplierId: party.supplierId ?? null,
    };
    return this.journal.post(
      tx,
      {
        branchId: item.branchId,
        entryDate: item.entryDate,
        description,
        source: 'OPENING_BALANCE',
        sourceId: item.sourceId,
        userId,
      },
      [
        { ...common, accountId: party.accountId, side: party.side, description: item.reference },
        {
          ...common,
          accountId: equity,
          side: party.side === 'DEBIT' ? 'CREDIT' : 'DEBIT',
          description: item.number,
        },
      ],
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
