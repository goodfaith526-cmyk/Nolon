import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { type CreditSnapshotRow, creditPosition } from './credit-limit.js';
import { creditSnapshotSql } from './credit-limit.service.js';

const row = (over: Partial<CreditSnapshotRow>): CreditSnapshotRow => ({
  limit: '1000',
  limitCurrency: 'USD',
  limitDecimals: 2,
  invoices: [],
  advances: [],
  rates: [],
  ...over,
});

const summary = (r: CreditSnapshotRow) => {
  const p = creditPosition(r);
  return 'balance' in p ? [p.kind, p.balance.toFixed(), p.currency] : [p.kind];
};

describe('creditPosition (plan 06 ب6)', () => {
  it('does not check a customer without a limit or its currency', () => {
    expect(summary(row({ limit: null }))).toEqual(['NO_LIMIT']);
    expect(summary(row({ limitCurrency: null }))).toEqual(['NO_LIMIT']);
  });

  it('subtracts unapplied advances from what is left on approved invoices', () => {
    const r = row({
      invoices: [{ currency: 'USD', amount: '1200' }],
      advances: [{ currency: 'USD', amount: '200' }],
    });
    expect(summary(r)).toEqual(['WITHIN', '1000', 'USD']);
    expect(summary({ ...r, advances: [{ currency: 'USD', amount: '199.99' }] })).toEqual([
      'EXCEEDED',
      '1000.01',
      'USD',
    ]);
  });

  it('converts each currency at its rate per USD into the limit currency, rounding once', () => {
    // 600,000 SDG at 600 = 1,000 USD = 3,672.5 AED at 3.6725; 100 USD = 367.25 AED.
    const r = row({
      limit: '4000',
      limitCurrency: 'AED',
      invoices: [
        { currency: 'SDG', amount: '600000' },
        { currency: 'USD', amount: '100' },
      ],
      rates: [
        { currency: 'SDG', rate: '600' },
        { currency: 'AED', rate: '3.6725' },
      ],
    });
    expect(summary(r)).toEqual(['EXCEEDED', '4039.75', 'AED']);
  });

  it('gives NO_RATE when a currency to convert, or the limit currency, has no rate', () => {
    const base = row({ invoices: [{ currency: 'SDG', amount: '10' }] });
    expect(creditPosition(base)).toEqual({ kind: 'NO_RATE', currency: 'SDG' });
    const target = row({
      limitCurrency: 'AED',
      invoices: [{ currency: 'USD', amount: '10' }],
    });
    expect(creditPosition(target)).toEqual({ kind: 'NO_RATE', currency: 'AED' });
    // Nothing to convert needs no rate.
    expect(summary(row({ limitCurrency: 'AED', invoices: [] }))).toEqual(['WITHIN', '0', 'AED']);
  });

  it('treats a zero limit as cash: any open balance is over it, a credit balance is not', () => {
    expect(summary(row({ limit: '0', invoices: [{ currency: 'USD', amount: '0.01' }] }))).toEqual([
      'EXCEEDED',
      '0.01',
      'USD',
    ]);
    expect(summary(row({ limit: '0', advances: [{ currency: 'USD', amount: '5' }] }))).toEqual([
      'WITHIN',
      '-5',
      'USD',
    ]);
  });
});

describe('creditSnapshotSql (F147-2)', () => {
  it('reads every part of the balance in one statement', () => {
    const sql = creditSnapshotSql('00000000-0000-0000-0000-000000000000', '2026-01-01');
    expect(sql).toBeInstanceOf(Prisma.Sql);
    const text = sql.sql;
    // One SELECT at the top level, the parts as CTEs of it: never several round trips.
    expect(text.trim().startsWith('WITH')).toBe(true);
    for (const table of [
      '"customers"',
      '"customer_invoices"',
      '"receipts"',
      '"receipt_allocations"',
      '"receipt_applications"',
      '"fx_rates"',
    ]) {
      expect(text).toContain(table);
    }
    expect(text.split(';').filter((s) => s.trim() !== '')).toHaveLength(1);
  });
});
