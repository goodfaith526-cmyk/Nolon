import { BadRequestException } from '@nestjs/common';
import { USD_DECIMALS } from '../accounting/journal-math.js';
import { type Decimal, roundMoney } from '../common/money.js';
import { relievedUsd } from './invoice-math.js';

/** The receipt whose advance is applied, as locked. */
export interface ApplyingReceipt {
  branchId: string;
  customerId: string;
  currency: string;
  fxRate: Decimal;
  /** YYYY-MM-DD */
  receiptDate: string;
}

/** The invoice it is applied to, as locked. Paid and credited amounts both settle it. */
export interface ApplyingInvoice {
  number: string | null;
  branchId: string;
  customerId: string;
  status: string;
  currency: string;
  fxRate: Decimal;
  /** YYYY-MM-DD */
  invoiceDate: string;
  total: Decimal;
  totalUsd: Decimal;
  paidAmount: Decimal;
  paidUsd: Decimal;
  creditedAmount: Decimal;
  creditedUsd: Decimal;
}

/**
 * The rules of applying part of a receipt's advance to a later invoice (decision z6), on rows
 * the caller has locked: the receipt first, then the invoice. The invoice is approved, of the
 * same customer, branch and currency, dated on or before the application, with at least the
 * amount left to pay; the amount is positive, in the currency's minor units, and no more than
 * the advance still held (the receipt's advance line less its active applications), so the same
 * balance is never applied twice. Returns the USD values cleared: of the advance at the
 * receipt's rate, and of the receivable at the invoice's rate; the last application of an
 * advance (or payment of an invoice) clears whatever USD is left, so rounding leaves no cents.
 */
export function checkApplication(input: {
  receipt: ApplyingReceipt;
  /** The receipt entry's advance line; null when the receipt allocated all of its amount. */
  advance: { amount: Decimal; amountUsd: Decimal } | null;
  /** The receipt's active applications so far. */
  applied: { amount: Decimal; advanceUsd: Decimal };
  invoice: ApplyingInvoice;
  amount: Decimal;
  currencyDecimals: number;
  applicationDate: string;
}): { advanceUsd: Decimal; relievedUsd: Decimal } {
  const { receipt, advance, applied, invoice, amount } = input;
  const label = invoice.number ?? '';
  if (!amount.gt(0) || !roundMoney(amount, input.currencyDecimals).eq(amount)) {
    throw new BadRequestException(
      `Amount must be positive with ${input.currencyDecimals} decimal places`,
    );
  }
  if (invoice.customerId !== receipt.customerId) {
    throw new BadRequestException('The invoice is of another customer');
  }
  if (invoice.branchId !== receipt.branchId) {
    throw new BadRequestException("The invoice is in another branch than the receipt's");
  }
  if (invoice.currency !== receipt.currency) {
    throw new BadRequestException(
      `Invoice ${label} is in ${invoice.currency}, the receipt in ${receipt.currency}`,
    );
  }
  if (invoice.status !== 'APPROVED') {
    throw new BadRequestException(`Invoice ${label} is not approved`);
  }
  if (input.applicationDate < receipt.receiptDate || input.applicationDate < invoice.invoiceDate) {
    throw new BadRequestException(
      'The application cannot be dated before the receipt or the invoice',
    );
  }
  const noAdvance = 'This receipt holds no advance left to apply';
  if (!advance) throw new BadRequestException(noAdvance);
  const left = advance.amount.minus(applied.amount);
  if (!left.gt(0)) throw new BadRequestException(noAdvance);
  if (amount.gt(left)) {
    throw new BadRequestException(
      `Only ${left.toFixed()} ${receipt.currency} of this receipt's advance is left to apply`,
    );
  }
  const settled = {
    total: invoice.total,
    totalUsd: invoice.totalUsd,
    paidAmount: invoice.paidAmount.plus(invoice.creditedAmount),
    paidUsd: invoice.paidUsd.plus(invoice.creditedUsd),
  };
  const outstanding = settled.total.minus(settled.paidAmount);
  if (amount.gt(outstanding)) {
    throw new BadRequestException(
      `Invoice ${label} has ${outstanding.toFixed()} ${invoice.currency} left`,
    );
  }
  return {
    advanceUsd: relievedUsd(
      {
        total: advance.amount,
        totalUsd: advance.amountUsd,
        paidAmount: applied.amount,
        paidUsd: applied.advanceUsd,
      },
      amount,
      receipt.fxRate,
      receipt.currency,
      USD_DECIMALS,
    ),
    relievedUsd: relievedUsd(settled, amount, invoice.fxRate, invoice.currency, USD_DECIMALS),
  };
}
