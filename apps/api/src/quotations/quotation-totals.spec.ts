import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { DiscountExceedsLineError, computeQuotationAmounts } from './quotation-totals.js';

const line = (quantity: string, unitPrice: string, minimumCharge = '0', discount = '0') => ({
  quantity: dec(quantity),
  unitPrice: dec(unitPrice),
  minimumCharge: dec(minimumCharge),
  discount: dec(discount),
});

describe('computeQuotationAmounts', () => {
  it('multiplies, sums and subtracts discounts exactly', () => {
    const r = computeQuotationAmounts([line('2', '1250.50'), line('1', '75', '0', '25')], 2);
    expect(r.lines.map((l) => l.lineTotal.toFixed())).toEqual(['2501', '50']);
    expect(r.subtotal.toFixed()).toBe('2576');
    expect(r.discountTotal.toFixed()).toBe('25');
    expect(r.total.toFixed()).toBe('2551');
  });

  it('has no binary floating point error', () => {
    // 0.1 + 0.2 style inputs: 3 × 0.1 = 0.3 exactly.
    const r = computeQuotationAmounts([line('3', '0.1'), line('1', '0.2')], 2);
    expect(r.total.toFixed()).toBe('0.5');
  });

  it('rounds each line half away from zero to the currency minor units', () => {
    const r = computeQuotationAmounts([line('3', '0.335')], 2); // 1.005
    expect(r.lines[0]?.gross.toFixed()).toBe('1.01');
    const zeroDecimals = computeQuotationAmounts([line('1.5', '1001')], 0); // 1501.5
    expect(zeroDecimals.total.toFixed()).toBe('1502');
  });

  it('applies the minimum charge when the extended amount is below it', () => {
    const r = computeQuotationAmounts([line('2.5', '40', '150')], 2); // 100 < 150
    expect(r.lines[0]?.gross.toFixed()).toBe('150');
    const above = computeQuotationAmounts([line('5', '40', '150')], 2); // 200 > 150
    expect(above.lines[0]?.gross.toFixed()).toBe('200');
  });

  it('allows a discount equal to the line and rejects a larger one', () => {
    expect(computeQuotationAmounts([line('1', '100', '0', '100')], 2).total.toFixed()).toBe('0');
    expect(() =>
      computeQuotationAmounts([line('1', '10'), line('1', '100', '0', '100.01')], 2),
    ).toThrow(DiscountExceedsLineError);
  });

  it('keeps total = subtotal - discountTotal on many lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(`${i + 1}.333`, '7.777', '0', '0.005'));
    const r = computeQuotationAmounts(lines, 2);
    const sumOfLines = r.lines.reduce((acc, l) => acc.add(l.lineTotal), dec(0));
    expect(r.total.eq(sumOfLines)).toBe(true);
    expect(r.total.eq(r.subtotal.sub(r.discountTotal))).toBe(true);
  });
});
