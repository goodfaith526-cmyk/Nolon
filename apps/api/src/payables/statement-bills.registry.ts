import { Injectable } from '@nestjs/common';
import type { BillLineForPosting } from '../accounting/auto-journal.service.js';
import type { Decimal } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** What the approval of a bill knows about it when it meets a COMMISSION line. */
export interface StatementBillFacts {
  id: string;
  branchId: string;
  supplierId: string;
  currency: string;
  line: { statementId: string; amount: Decimal };
}

/**
 * The partner statements' side of a supplier bill made from one (plan 07, 5.2). Commissions sit
 * above payables, so they register here; payables calls them inside its own transactions, after
 * the bill's row lock (the bill, then the statement).
 */
export interface StatementBillHandler {
  /**
   * Locks the statement and checks the bill against it: BILLED by this bill, same branch, the
   * partner's supplier now, its currency, its total and the USD value of its rows. 409
   * STATEMENT_BILL_MISMATCH else. Returns the line rule 16a posts.
   */
  approvalLineInTx(
    tx: Tx,
    bill: StatementBillFacts,
  ): Promise<Extract<BillLineForPosting, { kind: 'COMMISSION' }>>;
  /** After the bill's entry: the statement is SETTLED. */
  settledInTx(tx: Tx, statementId: string, billId: string): Promise<void>;
  /** The bill was cancelled: a statement this bill is the live bill of goes back to DRAFT. */
  billCancelledInTx(tx: Tx, statementId: string, billId: string): Promise<void>;
}

@Injectable()
export class StatementBills {
  private handler: StatementBillHandler | null = null;

  register(handler: StatementBillHandler): void {
    this.handler = handler;
  }

  get registered(): StatementBillHandler {
    if (!this.handler) throw new Error('No partner statement handler is registered');
    return this.handler;
  }
}
