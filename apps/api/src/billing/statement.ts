import type {
  CustomerStatementLineDto,
  CustomerStatementSectionDto,
  JournalSource,
  StatementLineKind,
} from '@nolon/shared';
import { type Decimal, ZERO } from '../common/money.js';

/** A customer's balance before the period, in one currency. */
export interface StatementOpening {
  currency: string;
  balance: Decimal;
  balanceUsd: Decimal;
}

/** One posted entry on the customer's accounts in the period, in one currency, in date order. */
export interface StatementMovement {
  entryId: string | null;
  number: string | null;
  entryDate: string;
  kind: StatementLineKind;
  documentId: string | null;
  documentNumber: string | null;
  description: string;
  detailsHidden: boolean;
  currency: string;
  debit: Decimal;
  credit: Decimal;
  debitUsd: Decimal;
  creditUsd: Decimal;
}

/** What a posted entry is on a statement, from its source and, for a reversal, the reversed one. */
export function statementKind(
  source: JournalSource,
  reversedSource: JournalSource | null,
): StatementLineKind {
  if (source === 'CUSTOMER_INVOICE') return 'INVOICE';
  if (source === 'RECEIPT') return 'RECEIPT';
  if (source === 'REVERSAL')
    return reversedSource === 'RECEIPT' ? 'RECEIPT_CANCELLATION' : 'REVERSAL';
  return 'OTHER';
}

/**
 * The statement sections, one per currency (by code): the opening balance, each movement with
 * the running balance after it (debit - credit, positive when the customer owes), the period's
 * totals and the closing balance, in the currency and as a USD carrying value. A currency with
 * neither an opening balance nor a movement is left out. Movements keep the order given.
 */
export function buildStatementSections(
  openings: readonly StatementOpening[],
  movements: readonly StatementMovement[],
): CustomerStatementSectionDto[] {
  const currencies = new Set([
    ...openings.filter((o) => !o.balance.isZero() || !o.balanceUsd.isZero()).map((o) => o.currency),
    ...movements.map((m) => m.currency),
  ]);
  return [...currencies].sort().map((currency) => {
    const opening = openings.find((o) => o.currency === currency);
    let balance = opening?.balance ?? ZERO;
    let balanceUsd = opening?.balanceUsd ?? ZERO;
    let totalDebit = ZERO;
    let totalCredit = ZERO;
    const lines: CustomerStatementLineDto[] = movements
      .filter((m) => m.currency === currency)
      .map((m) => {
        balance = balance.plus(m.debit).minus(m.credit);
        balanceUsd = balanceUsd.plus(m.debitUsd).minus(m.creditUsd);
        totalDebit = totalDebit.plus(m.debit);
        totalCredit = totalCredit.plus(m.credit);
        return {
          entryId: m.entryId,
          entryNumber: m.number,
          date: m.entryDate,
          kind: m.kind,
          documentId: m.documentId,
          documentNumber: m.documentNumber,
          description: m.description,
          detailsHidden: m.detailsHidden,
          debit: m.debit.toFixed(),
          credit: m.credit.toFixed(),
          balance: balance.toFixed(),
        };
      });
    return {
      currency,
      openingBalance: (opening?.balance ?? ZERO).toFixed(),
      totalDebit: totalDebit.toFixed(),
      totalCredit: totalCredit.toFixed(),
      closingBalance: balance.toFixed(),
      closingBalanceUsd: balanceUsd.toFixed(),
      lines,
    };
  });
}
