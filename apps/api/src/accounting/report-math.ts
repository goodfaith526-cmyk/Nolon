import type { AccountType } from '@nolon/shared';
import { type Decimal, ZERO } from '../common/money.js';

/**
 * Sign conventions of the financial reports, in one place. Journal lines store positive debits and
 * credits; a report shows each account in its natural sign, so a normal balance is positive:
 * assets and expenses are debit - credit, liabilities, equity and revenue are credit - debit.
 */
export function naturalBalance(type: AccountType, debit: Decimal, credit: Decimal): Decimal {
  return isDebitNatured(type) ? debit.minus(credit) : credit.minus(debit);
}

export function isDebitNatured(type: AccountType): boolean {
  return type === 'ASSET' || type === 'EXPENSE';
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), ZERO);
}
