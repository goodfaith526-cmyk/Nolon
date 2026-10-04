import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { isDebitNatured, naturalBalance, sum } from './report-math.js';

describe('report sign conventions', () => {
  it('assets and expenses are debit - credit', () => {
    expect(naturalBalance('ASSET', dec('100'), dec('30')).toFixed()).toBe('70');
    expect(naturalBalance('EXPENSE', dec('10'), dec('25.5')).toFixed()).toBe('-15.5');
    expect(isDebitNatured('ASSET')).toBe(true);
    expect(isDebitNatured('EXPENSE')).toBe(true);
  });

  it('liabilities, equity and revenue are credit - debit', () => {
    expect(naturalBalance('LIABILITY', dec('30'), dec('100')).toFixed()).toBe('70');
    expect(naturalBalance('EQUITY', dec('0'), dec('0.0001')).toFixed()).toBe('0.0001');
    expect(naturalBalance('REVENUE', dec('1666.67'), dec('1000')).toFixed()).toBe('-666.67');
    expect(isDebitNatured('REVENUE')).toBe(false);
  });

  it('adds decimals exactly', () => {
    expect(sum([dec('0.1'), dec('0.2'), dec('0.3')]).toFixed()).toBe('0.6');
    expect(sum([]).toFixed()).toBe('0');
  });
});
