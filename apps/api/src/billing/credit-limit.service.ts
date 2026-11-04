import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { CustomerCreditDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { CustomersService } from '../customers/customers.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { todayIn } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import { codedRefusal } from '../common/validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type CreditPosition, type CreditSnapshotRow, creditPosition } from './credit-limit.js';

type Db = Prisma.TransactionClient | PrismaService;

/**
 * The one statement that reads a customer's credit position (plan 06 ب6, F147-2): the limit and
 * its currency, what is left on every approved invoice, every unapplied advance of a posted
 * receipt, and the rates to convert them, all in one snapshot. A receipt, an application or its
 * reversal changes an invoice's paidAmount and the advance together in one transaction, so this
 * statement sees both before or both after it, never a mix. Never split into several queries.
 */
export function creditSnapshotSql(
  customerId: string,
  today: string,
  ownInvoiceId: string | null = null,
): Prisma.Sql {
  // Plan 12 section 2.3: an invoice approved in this transaction is read apart (`own`), so one
  // statement gives the balance before it and with it.
  const own = ownInvoiceId ?? '00000000-0000-0000-0000-000000000000';
  return Prisma.sql`
    WITH c AS (
      SELECT cu."name", cu."number", cu."credit_limit"::text AS "limit",
             cu."credit_limit_currency" AS "limitCurrency", cur."decimal_places" AS "limitDecimals"
      FROM "customers" cu
      LEFT JOIN "currencies" cur ON cur."code" = cu."credit_limit_currency"
      WHERE cu."id" = ${customerId}::uuid
    ), inv AS (
      SELECT i."currency", SUM(i."total" - i."paid_amount" - i."credited_amount") AS "amount"
      FROM "customer_invoices" i
      WHERE i."customer_id" = ${customerId}::uuid AND i."status" = 'APPROVED'
        AND i."id" <> ${own}::uuid
      GROUP BY i."currency"
    ), own AS (
      SELECT i."currency", i."total" - i."paid_amount" - i."credited_amount" AS "amount"
      FROM "customer_invoices" i
      WHERE i."id" = ${own}::uuid AND i."customer_id" = ${customerId}::uuid
        AND i."status" = 'APPROVED'
    ), adv AS (
      SELECT r."currency",
             SUM(r."amount"
                 - COALESCE((SELECT SUM(a."amount") FROM "receipt_allocations" a
                             WHERE a."receipt_id" = r."id"), 0)
                 - COALESCE((SELECT SUM(p."amount") FROM "receipt_applications" p
                             WHERE p."receipt_id" = r."id" AND p."status" = 'ACTIVE'), 0)) AS "amount"
      FROM "receipts" r
      WHERE r."customer_id" = ${customerId}::uuid AND r."status" = 'POSTED'
      GROUP BY r."currency"
    ), rates AS (
      SELECT DISTINCT ON (f."currency") f."currency", f."rate"::text AS "rate"
      FROM "fx_rates" f
      WHERE f."rate_date" <= ${today}::date
        AND f."currency" IN (SELECT "currency" FROM inv UNION SELECT "currency" FROM adv
                             UNION SELECT "currency" FROM own
                             UNION SELECT "limitCurrency" FROM c)
      ORDER BY f."currency", f."rate_date" DESC
    )
    SELECT c."name", c."number", c."limit", c."limitCurrency", c."limitDecimals",
      COALESCE((SELECT json_agg(json_build_object('currency', "currency", 'amount', "amount"::text))
                FROM inv), '[]'::json) AS "invoices",
      COALESCE((SELECT json_agg(json_build_object('currency', "currency", 'amount', "amount"::text))
                FROM adv), '[]'::json) AS "advances",
      COALESCE((SELECT json_agg(json_build_object('currency', "currency", 'amount', "amount"::text))
                FROM own), '[]'::json) AS "own",
      COALESCE((SELECT json_agg(json_build_object('currency', "currency", 'rate', "rate"))
                FROM rates), '[]'::json) AS "rates",
      -- F192-1: the branches whose documents make up the balance (an open approved invoice, an
      -- unapplied advance), so a reader sees the total only when they may see each of them.
      COALESCE((SELECT json_agg(DISTINCT b."branch_id") FROM (
        SELECT i."branch_id" FROM "customer_invoices" i
        WHERE i."customer_id" = ${customerId}::uuid AND i."status" = 'APPROVED'
          AND i."total" - i."paid_amount" - i."credited_amount" <> 0
        UNION
        SELECT r."branch_id" FROM "receipts" r
        WHERE r."customer_id" = ${customerId}::uuid AND r."status" = 'POSTED'
          AND r."amount"
              - COALESCE((SELECT SUM(a."amount") FROM "receipt_allocations" a
                          WHERE a."receipt_id" = r."id"), 0)
              - COALESCE((SELECT SUM(p."amount") FROM "receipt_applications" p
                          WHERE p."receipt_id" = r."id" AND p."status" = 'ACTIVE'), 0) <> 0
      ) b), '[]'::json) AS "branches"
    FROM c`;
}

type SnapshotResult = CreditSnapshotRow & {
  name: string;
  number: string;
  /** The branches of the documents in the balance (F192-1). */
  branches: readonly string[];
  /** The invoice read apart (creditSnapshotSql's `ownInvoiceId`), when it is approved. */
  own: readonly { currency: string; amount: string }[];
};

/** What an automatic approval's credit statement decided (plan 12 section 2.3). */
export type AutoApprovalCredit = 'WITHIN' | 'CREDIT_LIMIT_EXCEEDED' | 'CREDIT_LIMIT_NO_RATE';

/**
 * Client decision ب6: a customer with a credit limit gets no booking confirmed and no invoice
 * approved while the open balance is over the limit. A customer without a limit is not checked.
 * Accepting a draft (a draft booking, an invoice draft, a bot request) is never refused here.
 */
@Injectable()
export class CreditLimitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * The customer's position now, for a screen (read without a lock: the server decides on confirm
   * and approve). With `invoiceId`, a draft of the user's branches billing this customer, the
   * position once it is approved, as the approval checks it.
   */
  async forUser(
    user: AuthUser,
    customerId: string,
    invoiceId?: string,
  ): Promise<CustomerCreditDto> {
    await this.customers.requireCustomer(user, customerId);
    const row = await this.snapshot(this.prisma, customerId);
    if (!row) throw new NotFoundException('Customer not found');
    let snapshot: CreditSnapshotRow = row;
    if (invoiceId) {
      const invoice = await this.prisma.customerInvoice.findFirst({
        where: { id: invoiceId, customerId, status: 'DRAFT', ...branchScope(user) },
        select: { currency: true, total: true },
      });
      if (!invoice) throw new NotFoundException('Draft invoice not found');
      snapshot = {
        ...row,
        invoices: [
          ...row.invoices,
          { currency: invoice.currency, amount: invoice.total.toFixed() },
        ],
      };
    }
    // A rate the extra currency needs was not read with the snapshot: read it the same way.
    const position = await this.withRates(snapshot);
    const base = { customerId, missingRateCurrency: null };
    switch (position.kind) {
      case 'NO_LIMIT':
        return { ...base, state: 'NO_LIMIT', balance: null, limit: null, currency: null };
      case 'NO_RATE':
        return {
          ...base,
          state: 'NO_RATE',
          balance: null,
          limit: row.limit === null ? null : toDecimalString(dec(row.limit)),
          currency: row.limitCurrency,
          missingRateCurrency: position.currency,
        };
      default:
        return {
          ...base,
          state: position.kind,
          // F192-1: the total is company-wide; it is shown only to a reader who may see the
          // invoices of every branch it comes from (AGENTS.md rule 2). The state alone is what
          // a confirmation or approval would answer anyway.
          balance: row.branches.every((b) => user.access.has('customer_invoices:view', b))
            ? toDecimalString(position.balance)
            : null,
          limit: toDecimalString(position.limit),
          currency: position.currency,
        };
    }
  }

  /** creditPosition, reading a missing rate of a currency the snapshot did not hold. */
  private async withRates(row: CreditSnapshotRow): Promise<CreditPosition> {
    const known = new Set(row.rates.map((r) => r.currency));
    const missing = [...new Set(row.invoices.map((i) => i.currency))].filter(
      (c) => !known.has(c) && c !== row.limitCurrency,
    );
    if (missing.length === 0) return creditPosition(row);
    const extra = await this.prisma.$queryRaw<{ currency: string; rate: string }[]>`
      SELECT DISTINCT ON ("currency") "currency", "rate"::text AS "rate" FROM "fx_rates"
      WHERE "currency" IN (${Prisma.join(missing)}) AND "rate_date" <= ${todayIn('UTC')}::date
      ORDER BY "currency", "rate_date" DESC`;
    return creditPosition({ ...row, rates: [...row.rates, ...extra] });
  }

  /**
   * F147-2: the LAST step of a transaction that confirms a booking or approves an invoice, after
   * everything it writes. It takes the customer's advisory lock (two such checks for one customer
   * run one after the other, the second seeing the first's committed invoice), then reads the
   * balance in one statement and refuses over the limit (409 CREDIT_LIMIT_EXCEEDED), or when a
   * rate it needs is missing (409 CREDIT_LIMIT_NO_RATE). Nothing is locked after it.
   */
  async requireWithinLimitInTx(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
    await lockCredit(tx, customerId);
    const row = await this.snapshot(tx, customerId);
    if (!row) return;
    refuseOver(row, creditPosition(row));
  }

  /**
   * Plan 12 section 2.3, the last step of a confirmation whose invoice `invoiceId` was approved
   * automatically inside a savepoint: the customer's advisory lock, then ONE statement read with
   * the invoice apart. The balance before it is the confirmation's own check (plan 06): over the
   * limit, or a rate it needs missing, refuses the whole transaction (409, as
   * requireWithinLimitInTx). With it: over the limit, or only its currency without a rate, gives
   * that code, and the caller rolls the approval back to its savepoint.
   */
  async autoApprovalCheckInTx(
    tx: Prisma.TransactionClient,
    customerId: string,
    invoiceId: string,
  ): Promise<AutoApprovalCredit> {
    await lockCredit(tx, customerId);
    const row = await this.snapshot(tx, customerId, invoiceId);
    if (!row) return 'WITHIN';
    refuseOver(row, creditPosition(row));
    const after = creditPosition({ ...row, invoices: [...row.invoices, ...row.own] });
    if (after.kind === 'EXCEEDED') return 'CREDIT_LIMIT_EXCEEDED';
    return after.kind === 'NO_RATE' ? 'CREDIT_LIMIT_NO_RATE' : 'WITHIN';
  }

  private async snapshot(
    db: Db,
    customerId: string,
    ownInvoiceId: string | null = null,
  ): Promise<SnapshotResult | null> {
    const rows = await db.$queryRaw<SnapshotResult[]>(
      creditSnapshotSql(customerId, todayIn('UTC'), ownInvoiceId),
    );
    return rows[0] ?? null;
  }
}

/** The customer's credit advisory lock (plan 06 ب6): the last lock of the transaction. */
async function lockCredit(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended('credit:' || ${customerId}, 0))`;
}

/** 409 when the position is over the limit, or a rate it needs is missing. */
function refuseOver(row: SnapshotResult, position: CreditPosition): void {
  if (position.kind === 'NO_RATE') {
    throw codedRefusal(
      HttpStatus.CONFLICT,
      'CREDIT_LIMIT_NO_RATE',
      `No exchange rate for ${position.currency} to check customer ${row.name}'s credit limit: add one first`,
      { currency: position.currency, customer: row.name },
    );
  }
  if (position.kind === 'EXCEEDED') {
    const params = {
      customer: row.name,
      limit: toDecimalString(position.limit),
      currency: position.currency,
    };
    // F192-1: no balance here. It is company-wide, and the person refused may work in one branch
    // only; the customer page shows it to those who may see it.
    throw codedRefusal(
      HttpStatus.CONFLICT,
      'CREDIT_LIMIT_EXCEEDED',
      `Customer ${row.name} is over their credit limit of ${params.limit} ${params.currency}: record their payment first, or have a manager raise the limit`,
      params,
    );
  }
}
