import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { computeInvoiceAmounts, relievedUsd } from './invoice-math.js';

describe('computeInvoiceAmounts', () => {
  it('rounds each line once and sums the rounded lines', () => {
    const { lineTotals, total } = computeInvoiceAmounts(
      [
        { quantity: dec('3'), unitPrice: dec('33.335') },
        { quantity: dec('1.5'), unitPrice: dec('10') },
      ],
      2,
    );
    expect(lineTotals.map((t) => t.toFixed())).toEqual(['100.01', '15']);
    expect(total.toFixed()).toBe('115.01');
  });

  it('uses the currency minor units (SDG has 2, a 0-decimal currency none)', () => {
    expect(
      computeInvoiceAmounts([{ quantity: dec('1'), unitPrice: dec('10.5') }], 0).total.toFixed(),
    ).toBe('11');
  });
});

describe('relievedUsd', () => {
  const invoice = {
    total: dec('1000000'),
    totalUsd: dec('1666.67'),
    paidAmount: dec('0'),
    paidUsd: dec('0'),
  };

  it('clears the whole USD value when the payment settles the invoice', () => {
    expect(relievedUsd(invoice, dec('1000000'), dec('600'), 'SDG', 2).toFixed()).toBe('1666.67');
  });

  it('clears a partial payment at the invoice rate', () => {
    expect(relievedUsd(invoice, dec('300000'), dec('600'), 'SDG', 2).toFixed()).toBe('500');
  });

  it('clears the remainder on the last of several payments', () => {
    const partlyPaid = { ...invoice, paidAmount: dec('333333'), paidUsd: dec('555.56') };
    expect(relievedUsd(partlyPaid, dec('666667'), dec('600'), 'SDG', 2).toFixed()).toBe('1111.11');
  });

  it('never clears more than is left', () => {
    const nearlyPaid = { ...invoice, paidAmount: dec('999000'), paidUsd: dec('1666.66') };
    expect(relievedUsd(nearlyPaid, dec('600'), dec('600'), 'SDG', 2).toFixed()).toBe('0.01');
  });
});
