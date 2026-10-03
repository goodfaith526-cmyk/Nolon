import { type Decimal, ZERO, roundMoney } from '../common/money.js';

export interface LineAmountsInput {
  quantity: Decimal;
  unitPrice: Decimal;
  minimumCharge: Decimal;
  discount: Decimal;
}

export interface LineAmounts {
  /** max(round(quantity × unitPrice), round(minimumCharge)). */
  gross: Decimal;
  discount: Decimal;
  lineTotal: Decimal;
}

export interface QuotationAmounts {
  lines: LineAmounts[];
  subtotal: Decimal;
  discountTotal: Decimal;
  total: Decimal;
}

export class DiscountExceedsLineError extends Error {
  constructor(readonly lineNo: number) {
    super(`Discount on line ${lineNo} is larger than the line amount`);
  }
}

/**
 * Quotation arithmetic, in one place. Each line amount is rounded once to the currency's minor
 * units; the totals are exact sums of the rounded lines, so total = subtotal - discountTotal
 * always holds (the database checks it too).
 */
export function computeQuotationAmounts(
  lines: readonly LineAmountsInput[],
  decimalPlaces: number,
): QuotationAmounts {
  let subtotal = ZERO;
  let discountTotal = ZERO;
  const result = lines.map((line, index): LineAmounts => {
    const extended = roundMoney(line.quantity.mul(line.unitPrice), decimalPlaces);
    const minimum = roundMoney(line.minimumCharge, decimalPlaces);
    const gross = extended.lt(minimum) ? minimum : extended;
    const discount = roundMoney(line.discount, decimalPlaces);
    if (discount.gt(gross)) throw new DiscountExceedsLineError(index + 1);
    subtotal = subtotal.add(gross);
    discountTotal = discountTotal.add(discount);
    return { gross, discount, lineTotal: gross.sub(discount) };
  });
  return { lines: result, subtotal, discountTotal, total: subtotal.sub(discountTotal) };
}
