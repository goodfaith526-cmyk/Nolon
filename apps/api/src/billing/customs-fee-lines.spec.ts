import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  type FeeInvoice,
  feeLinesProblem,
  feesCurrency,
  unbilledFees,
} from './customs-fee-lines.js';

const fee = (id: string, currency = 'USD', at = 1) => ({
  id,
  description: `fee ${id}`,
  currency,
  createdAt: new Date(at * 1000),
});
const invoice = (
  id: string,
  over: Partial<FeeInvoice> & { fees?: string[]; charges?: string[] } = {},
): FeeInvoice => ({
  id,
  number: null,
  kind: 'ADDITIONAL',
  status: 'DRAFT',
  total: dec(100),
  paidAmount: dec(0),
  creditedAmount: dec(0),
  lines: [
    ...(over.fees ?? []).map((f) => ({ chargeTypeCode: 'CUSTOMS', customsFeeId: f })),
    ...(over.charges ?? []).map((c) => ({ chargeTypeCode: c, customsFeeId: null })),
  ],
  ...over,
});

describe('customs fees on the additional services invoice (plan 12 section 5)', () => {
  it('offers the fees no live invoice bills, oldest first', () => {
    const fees = [fee('b', 'USD', 2), fee('a', 'USD', 1), fee('c', 'USD', 3)];
    expect(unbilledFees(fees, []).map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(unbilledFees(fees, [invoice('x', { fees: ['b'] })]).map((f) => f.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('offers a fee again once its invoice is cancelled or credited in full', () => {
    const fees = [fee('a')];
    expect(unbilledFees(fees, [invoice('x', { fees: ['a'], status: 'CANCELLED' })])).toHaveLength(
      1,
    );
    const credited = invoice('x', { fees: ['a'], status: 'APPROVED', creditedAmount: dec(100) });
    expect(unbilledFees(fees, [credited])).toHaveLength(1);
  });

  it('leaves out the invoice being written', () => {
    expect(unbilledFees([fee('a')], [invoice('x', { fees: ['a'] })], 'x')).toHaveLength(1);
  });

  it('offers none while a live main invoice bills customs', () => {
    const main = invoice('m', { kind: 'MAIN', charges: ['FREIGHT', 'CUSTOMS'] });
    expect(unbilledFees([fee('a')], [main])).toEqual([]);
    const freightOnly = invoice('m', { kind: 'MAIN', charges: ['FREIGHT'] });
    expect(unbilledFees([fee('a')], [freightOnly])).toHaveLength(1);
  });

  it('takes the fees’ currency when they share one', () => {
    expect(feesCurrency([fee('a', 'SDG'), fee('b', 'SDG')], 'USD')).toBe('SDG');
    expect(feesCurrency([fee('a', 'SDG'), fee('b', 'AED')], 'USD')).toBe('USD');
    expect(feesCurrency([], 'USD')).toBe('USD');
  });

  it('accepts a fee line only once, under CUSTOMS, in its currency, on an additional invoice', () => {
    const fees = [fee('a', 'USD'), fee('b', 'SDG')];
    const line = (customsFeeId: string | null, chargeTypeCode = 'CUSTOMS') => ({
      chargeTypeCode,
      customsFeeId,
    });
    const check = (lines: ReturnType<typeof line>[], kind: 'MAIN' | 'ADDITIONAL' = 'ADDITIONAL') =>
      feeLinesProblem({ kind, currency: 'USD', lines, fees });
    expect(check([line('a'), line(null, 'DOCS')])).toBeNull();
    expect(check([line('a'), line('a')])).toBe('a');
    expect(check([line('a', 'DOCS')])).toBe('a');
    expect(check([line('b')])).toBe('b');
    expect(check([line('z')])).toBe('z');
    expect(check([line('a')], 'MAIN')).toBe('a');
  });
});
