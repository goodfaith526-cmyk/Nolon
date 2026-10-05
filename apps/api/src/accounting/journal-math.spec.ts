import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  AMOUNT_TOO_SMALL,
  type LineSpec,
  InvalidLineError,
  UnbalancedEntryError,
  prepareLines,
  reverseLines,
  toUsd,
  totals,
} from './journal-math.js';

const rounding = { accountId: 'rounding', branchId: 'b1' };

function line(side: 'DEBIT' | 'CREDIT', amount: string, currency = 'USD', rate = '1'): LineSpec {
  return {
    accountId: side,
    branchId: 'b1',
    currency,
    fxRate: dec(rate),
    side,
    amount: dec(amount),
  };
}

describe('toUsd', () => {
  it('divides by the rate and rounds half up to cents', () => {
    expect(toUsd(dec('1000000'), dec('600'), 'SDG').toFixed()).toBe('1666.67');
    expect(toUsd(dec('1000'), dec('3.6725'), 'AED').toFixed()).toBe('272.29');
    expect(toUsd(dec('0.005'), dec('1'), 'EUR').toFixed()).toBe('0.01');
  });

  it('keeps USD amounts as they are', () => {
    expect(toUsd(dec('10.1234'), dec('1'), 'USD').toFixed()).toBe('10.1234');
  });
});

describe('prepareLines', () => {
  it('accepts a balanced entry without adding lines', () => {
    const lines = prepareLines([line('DEBIT', '100'), line('CREDIT', '100')], rounding);
    expect(lines).toHaveLength(2);
    expect(totals(lines).debitUsd.toFixed()).toBe('100');
  });

  it('books the cents left by rounding each line to the rounding account', () => {
    // 1000 SDG at 600 = 1.67 USD, but two lines of 500 SDG are 0.83 USD each: 1 cent apart.
    const lines = prepareLines(
      [
        line('DEBIT', '1000', 'SDG', '600'),
        line('CREDIT', '500', 'SDG', '600'),
        line('CREDIT', '500', 'SDG', '600'),
      ],
      rounding,
    );
    expect(lines).toHaveLength(4);
    const last = lines[3];
    expect(last?.accountId).toBe('rounding');
    expect(last?.side).toBe('CREDIT');
    expect(last?.amountUsd.toFixed()).toBe('0.01');
    const { debitUsd, creditUsd } = totals(lines);
    expect(debitUsd.eq(creditUsd)).toBe(true);
  });

  it('rejects an entry that is off by more than rounding', () => {
    expect(() => prepareLines([line('DEBIT', '100'), line('CREDIT', '99.90')], rounding)).toThrow(
      UnbalancedEntryError,
    );
  });

  it('rejects one-line entries, non-positive amounts and USD lines at another rate', () => {
    expect(() => prepareLines([line('DEBIT', '1')], rounding)).toThrow(InvalidLineError);
    expect(() => prepareLines([line('DEBIT', '0'), line('CREDIT', '0')], rounding)).toThrow(
      InvalidLineError,
    );
    expect(() =>
      prepareLines([line('DEBIT', '1', 'USD', '2'), line('CREDIT', '1')], rounding),
    ).toThrow(InvalidLineError);
  });

  it('refuses an entry worth 0.00 USD in total', () => {
    // 1 SDG at 600 is 0.0017 USD: both sides round to 0.00.
    expect(() =>
      prepareLines([line('DEBIT', '1', 'SDG', '600'), line('CREDIT', '1', 'SDG', '600')], rounding),
    ).toThrow(AMOUNT_TOO_SMALL);
    // Also when it has a single line (an opening balance with no equity difference to book).
    expect(() => prepareLines([line('DEBIT', '1', 'SDG', '600')], rounding)).toThrow(
      AMOUNT_TOO_SMALL,
    );
    expect(() => prepareLines([], rounding)).toThrow('at least two lines');
  });

  it('keeps lines worth 0.00 USD when the entry is worth more, balanced by rounding', () => {
    // 3 SDG at 600 is 0.005 USD, half up to 0.01; 1 SDG is 0.00; the 7 SDG credit is 0.01.
    const lines = prepareLines(
      [
        line('DEBIT', '3', 'SDG', '600'),
        line('DEBIT', '3', 'SDG', '600'),
        line('DEBIT', '1', 'SDG', '600'),
        line('CREDIT', '7', 'SDG', '600'),
      ],
      rounding,
    );
    expect(lines.map((l) => l.amountUsd.toFixed())).toEqual(['0.01', '0.01', '0', '0.01', '0.01']);
    expect(lines[4]).toMatchObject({ accountId: 'rounding', side: 'CREDIT' });
    const { debitUsd, creditUsd } = totals(lines);
    expect(debitUsd.toFixed()).toBe('0.02');
    expect(debitUsd.eq(creditUsd)).toBe(true);
  });

  it('keeps a USD value set by the caller', () => {
    const lines = prepareLines(
      [
        line('DEBIT', '1538.46'),
        { ...line('CREDIT', '1000000', 'SDG', '650'), amountUsd: dec('1538.46') },
      ],
      rounding,
    );
    expect(lines[1]?.amountUsd.toFixed()).toBe('1538.46');
  });
});

describe('reverseLines', () => {
  it('swaps sides and keeps amounts', () => {
    const lines = prepareLines([line('DEBIT', '5'), line('CREDIT', '5')], rounding);
    const reversed = reverseLines(lines);
    expect(reversed.map((l) => l.side)).toEqual(['CREDIT', 'DEBIT']);
    expect(reversed[0]?.amountUsd.toFixed()).toBe('5');
  });
});
