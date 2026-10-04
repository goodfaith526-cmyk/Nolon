import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { withAdvances } from './ar-aging.js';

const amounts = (total: string) => ({
  current: total,
  days1to30: '0',
  days31to60: '0',
  days61to90: '0',
  over90: '0',
  total,
});

describe('AR aging with advances', () => {
  it('nets each customer’s advances and lists customers that only have an advance', () => {
    const result = withAdvances(
      {
        asOf: '2026-01-31',
        branchId: null,
        customerId: null,
        invoices: [],
        customers: [
          { customerId: 'b', customerName: 'Beta', amounts: amounts('300') },
          { customerId: 'c', customerName: 'Gamma', amounts: amounts('50.5') },
        ],
        totals: amounts('350.5'),
      },
      [
        { customerId: 'b', customerName: 'Beta', amountUsd: dec('100') },
        { customerId: 'a', customerName: 'Alpha', amountUsd: dec('0.25') },
      ],
    );
    expect(result.customers.map((c) => [c.customerId, c.advancesUsd, c.netUsd])).toEqual([
      ['a', '0.25', '-0.25'],
      ['b', '100', '200'],
      ['c', '0', '50.5'],
    ]);
    expect(result.customers[0]?.amounts.total).toBe('0');
    expect(result.totalAdvancesUsd).toBe('100.25');
    expect(result.netUsd).toBe('250.25');
  });
});
