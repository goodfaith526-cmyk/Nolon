import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { breakEven } from './break-even.js';

const s = (revenue: string, cost: string, incomplete = false) => ({
  revenueUsd: dec(revenue),
  costUsd: dec(cost),
  incomplete,
});

describe('break-even (plan 07, z5)', () => {
  it('divides fixed expenses by the average margin and rounds up', () => {
    expect(breakEven([s('100', '40'), s('50', '20'), s('0', '5')], dec('1000'))).toEqual({
      contributionMarginUsd: '85',
      shipmentsWithRevenue: 2,
      averageMarginUsd: '42.5',
      fixedExpensesUsd: '1000',
      // 1000 / 42.5 = 23.5...
      breakEvenShipments: 24,
      incompleteShipments: 0,
    });
  });

  it('uses the exact average, not the rounded one', () => {
    // 10 / 3 = 3.333...: 10 / 3.333... = 3 exactly (3.33 would give 4).
    expect(breakEven([s('4', '0'), s('3', '0'), s('3', '0')], dec('10')).breakEvenShipments).toBe(
      3,
    );
  });

  it('gives no figure without a positive average margin', () => {
    expect(breakEven([s('10', '30')], dec('100'))).toMatchObject({
      averageMarginUsd: '-20',
      breakEvenShipments: null,
    });
    expect(breakEven([], dec('100'))).toMatchObject({
      shipmentsWithRevenue: 0,
      averageMarginUsd: null,
      breakEvenShipments: null,
    });
  });

  it('needs no shipment without fixed expenses, and counts the incomplete ones', () => {
    expect(breakEven([s('10', '5', true), s('10', '5')], dec('0'))).toMatchObject({
      breakEvenShipments: 0,
      incompleteShipments: 1,
    });
  });
});
