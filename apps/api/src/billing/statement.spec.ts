import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { type StatementMovement, buildStatementSections, statementKind } from './statement.js';

function movement(
  number: string,
  currency: string,
  debit: string,
  credit: string,
  usd: { debit: string; credit: string } = { debit, credit },
): StatementMovement {
  return {
    entryId: number,
    number,
    entryDate: '2026-01-01',
    kind: 'OTHER',
    documentId: null,
    documentNumber: null,
    description: number,
    currency,
    debit: dec(debit),
    credit: dec(credit),
    debitUsd: dec(usd.debit),
    creditUsd: dec(usd.credit),
  };
}

describe('statementKind', () => {
  it('names invoices, receipts and their cancellations', () => {
    expect(statementKind('CUSTOMER_INVOICE', null)).toBe('INVOICE');
    expect(statementKind('RECEIPT', null)).toBe('RECEIPT');
    expect(statementKind('REVERSAL', 'RECEIPT')).toBe('RECEIPT_CANCELLATION');
    expect(statementKind('REVERSAL', 'MANUAL')).toBe('REVERSAL');
    expect(statementKind('MANUAL', null)).toBe('OTHER');
  });
});

describe('buildStatementSections', () => {
  it('runs the balance from the opening, line by line, and totals the period', () => {
    const [usd] = buildStatementSections(
      [{ currency: 'USD', balance: dec('250.5'), balanceUsd: dec('250.5') }],
      [
        movement('INV', 'USD', '1000', '0'),
        movement('RC', 'USD', '0', '400.25'),
        movement('RC-CANCEL', 'USD', '400.25', '0'),
        movement('RC2', 'USD', '0', '2000'),
      ],
    );
    expect(usd).toMatchObject({
      currency: 'USD',
      openingBalance: '250.5',
      totalDebit: '1400.25',
      totalCredit: '2400.25',
      closingBalance: '-749.5',
      closingBalanceUsd: '-749.5',
    });
    expect(usd?.lines.map((l) => l.balance)).toEqual(['1250.5', '850.25', '1250.5', '-749.5']);
  });

  it('keeps one section per currency, by code, with the USD carrying value apart', () => {
    const sections = buildStatementSections(
      [{ currency: 'SDG', balance: dec('600000'), balanceUsd: dec('1000') }],
      [
        movement('RC-SDG', 'SDG', '0', '300000', { debit: '0', credit: '500' }),
        movement('INV-USD', 'USD', '300', '0'),
      ],
    );
    expect(sections.map((s) => s.currency)).toEqual(['SDG', 'USD']);
    expect(sections[0]).toMatchObject({
      openingBalance: '600000',
      closingBalance: '300000',
      closingBalanceUsd: '500',
    });
    expect(sections[1]).toMatchObject({ openingBalance: '0', closingBalance: '300' });
  });

  it('shows a currency with only an opening balance, and leaves out a settled one', () => {
    const sections = buildStatementSections(
      [
        { currency: 'AED', balance: dec('10'), balanceUsd: dec('2.7225') },
        { currency: 'EUR', balance: dec('0'), balanceUsd: dec('0') },
      ],
      [],
    );
    expect(sections).toEqual([
      {
        currency: 'AED',
        openingBalance: '10',
        totalDebit: '0',
        totalCredit: '0',
        closingBalance: '10',
        closingBalanceUsd: '2.7225',
        lines: [],
      },
    ]);
  });

  it('is exact with four decimal places (no float drift)', () => {
    const [s] = buildStatementSections(
      [],
      [movement('A', 'USD', '0.1', '0'), movement('B', 'USD', '0.2', '0')],
    );
    expect(s?.closingBalance).toBe('0.3');
  });
});
