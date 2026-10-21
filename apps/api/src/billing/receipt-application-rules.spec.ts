import { describe, expect, it } from 'vitest';
import { ZERO, dec } from '../common/money.js';
import {
  type ApplyingInvoice,
  type ApplyingReceipt,
  checkApplication,
} from './receipt-application-rules.js';

const receipt: ApplyingReceipt = {
  branchId: 'pts',
  customerId: 'c1',
  currency: 'SDG',
  fxRate: dec('500'),
  receiptDate: '2026-03-01',
};
const invoice: ApplyingInvoice = {
  number: 'NOL-INV-2026-000001',
  branchId: 'pts',
  customerId: 'c1',
  status: 'APPROVED',
  currency: 'SDG',
  fxRate: dec('600'),
  invoiceDate: '2026-03-10',
  total: dec('600000'),
  totalUsd: dec('1000'),
  paidAmount: ZERO,
  paidUsd: ZERO,
  creditedAmount: ZERO,
  creditedUsd: ZERO,
};
/** 300,000 SDG held as an advance at 500: 600 USD. */
const advance = { amount: dec('300000'), amountUsd: dec('600') };
const none = { amount: ZERO, advanceUsd: ZERO };

function check(overrides: Partial<Parameters<typeof checkApplication>[0]> = {}) {
  return checkApplication({
    receipt,
    advance,
    applied: none,
    invoice,
    amount: dec('100000'),
    currencyDecimals: 2,
    applicationDate: '2026-03-15',
    ...overrides,
  });
}

describe('checkApplication', () => {
  it('clears the advance at the receipt rate and the receivable at the invoice rate', () => {
    const usd = check();
    expect(usd.advanceUsd.toFixed()).toBe('200');
    expect(usd.relievedUsd.toFixed()).toBe('166.67');
  });

  it('clears what is left of the advance on its last application, so no cents stay behind', () => {
    const advanceOdd = { amount: dec('100000'), amountUsd: dec('333.33') };
    const usd = check({
      receipt: { ...receipt, fxRate: dec('300') },
      advance: advanceOdd,
      applied: { amount: dec('50000'), advanceUsd: dec('166.67') },
      amount: dec('50000'),
    });
    expect(usd.advanceUsd.toFixed()).toBe('166.66');
  });

  it('refuses more than the advance still held (the same balance is never applied twice)', () => {
    expect(() =>
      check({ applied: { amount: dec('250000'), advanceUsd: dec('500') }, amount: dec('60000') }),
    ).toThrow('Only 50000 SDG of this receipt');
    expect(() => check({ applied: { amount: dec('300000'), advanceUsd: dec('600') } })).toThrow(
      'no advance left',
    );
    expect(() => check({ advance: null })).toThrow('no advance left');
  });

  it('refuses more than the invoice has left to pay, counting payments and credit notes', () => {
    expect(() =>
      check({
        invoice: { ...invoice, paidAmount: dec('400000'), creditedAmount: dec('150000') },
        amount: dec('60000'),
      }),
    ).toThrow('has 50000 SDG left');
  });

  it("refuses another customer's, another branch's or another currency's invoice", () => {
    expect(() => check({ invoice: { ...invoice, customerId: 'c2' } })).toThrow('another customer');
    expect(() => check({ invoice: { ...invoice, branchId: 'jed' } })).toThrow('another branch');
    expect(() => check({ invoice: { ...invoice, currency: 'USD' } })).toThrow('is in USD');
  });

  it('refuses an invoice that is not approved', () => {
    expect(() => check({ invoice: { ...invoice, status: 'DRAFT' } })).toThrow('not approved');
  });

  it('refuses a date before the receipt or the invoice', () => {
    expect(() => check({ applicationDate: '2026-03-05' })).toThrow('cannot be dated before');
    expect(() => check({ applicationDate: '2026-02-28' })).toThrow('cannot be dated before');
  });

  it('refuses a zero, negative or over-precise amount', () => {
    expect(() => check({ amount: ZERO })).toThrow('positive');
    expect(() => check({ amount: dec('-5') })).toThrow('positive');
    expect(() => check({ amount: dec('1.005') })).toThrow('2 decimal places');
  });
});
