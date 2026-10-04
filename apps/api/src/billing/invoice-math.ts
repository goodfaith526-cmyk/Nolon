import { type Decimal, ZERO, roundMoney } from '../common/money.js';

/**
 * Invoice arithmetic, in one place. Each line is quantity × unit price rounded once to the
 * currency's minor units; the total is the exact sum of the rounded lines.
 */
export function computeInvoiceAmounts(
  lines: readonly { quantity: Decimal; unitPrice: Decimal }[],
  decimalPlaces: number,
): { lineTotals: Decimal[]; total: Decimal } {
  const lineTotals = lines.map((l) => roundMoney(l.quantity.times(l.unitPrice), decimalPlaces));
  return { lineTotals, total: lineTotals.reduce((sum, t) => sum.plus(t), ZERO) };
}

/**
 * The USD carrying value a payment clears on an invoice (annex C section 3). The payment that
 * settles the invoice clears whatever is left, so rounding never leaves cents on a paid
 * invoice; a partial payment clears its share at the invoice rate.
 */
export function relievedUsd(
  invoice: { total: Decimal; totalUsd: Decimal; paidAmount: Decimal; paidUsd: Decimal },
  amount: Decimal,
  fxRate: Decimal,
  currency: string,
  usdDecimals: number,
): Decimal {
  const remainingUsd = invoice.totalUsd.minus(invoice.paidUsd);
  if (amount.eq(invoice.total.minus(invoice.paidAmount))) return remainingUsd;
  const share = currency === 'USD' ? amount : roundMoney(amount.div(fxRate), usdDecimals);
  return share.gt(remainingUsd) ? remainingUsd : share;
}
