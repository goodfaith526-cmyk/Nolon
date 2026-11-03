import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  CreatePartnerStatementInput,
  PartnerStatementBillInput,
  PartnerStatementDto,
  PartnerStatementSummaryDto,
} from '@nolon/shared';
import type { BillLineForPosting } from '../accounting/auto-journal.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope, canAccessBranch } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, ZERO } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { codedRefusal } from '../common/validation.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  StatementBills,
  type StatementBillFacts,
  type StatementBillHandler,
} from '../payables/statement-bills.registry.js';
import { SupplierBillsService } from '../payables/supplier-bills.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

const summary = {
  branch: { select: { code: true } },
  bill: { select: { number: true, status: true } },
} satisfies Prisma.PartnerStatementInclude;

const details = {
  ...summary,
  partner: { select: { number: true, name: true, supplierId: true } },
  accruals: {
    include: {
      shipment: { select: { number: true } },
      entry: { select: { entryDate: true } },
      contract: { select: { accrualEvent: true, basis: true, value: true } },
    },
    orderBy: [{ shipment: { number: 'asc' } }, { createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.PartnerStatementInclude;

type StatementSummary = Prisma.PartnerStatementGetPayload<{ include: typeof summary }>;
type StatementDetails = Prisma.PartnerStatementGetPayload<{ include: typeof details }>;

/**
 * Partner statements (plan 07, 5; rule 16a): a partner's open commission rows of one branch and
 * currency up to a day, settled by the one live supplier bill made from it. The bill is a supplier
 * bill like any other (approved, paid and cancelled through payables); payables calls back here
 * through StatementBills, which this service registers with.
 *
 * Locks: making a statement takes the partner's statement lock, then its rows; everything on a
 * statement takes its row, after the bill's when payables calls (the bill, then the statement).
 */
@Injectable()
export class PartnerStatementsService implements StatementBillHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statementBills: StatementBills,
    private readonly bills: SupplierBillsService,
  ) {}

  onModuleInit(): void {
    this.statementBills.register(this);
  }

  /**
   * Takes the partner's open rows of the branch and currency whose entries are dated up to
   * `periodTo` (5.1). 403 outside the user's branches (the route's permission narrows them), 404
   * for a partner the user does not see; 409 PARTNER_NO_SUPPLIER, 409 STATEMENT_NOT_POSITIVE when
   * they do not total above zero in the currency and in USD (the rows stay open).
   */
  async create(
    user: AuthUser,
    partnerId: string,
    input: CreatePartnerStatementInput,
  ): Promise<PartnerStatementDto> {
    assertBranchAccess(user, input.branchId);
    await this.requireVisiblePartner(user, partnerId);
    const id = await this.prisma.$transaction(async (tx) => {
      const key = `partner-statement:${partnerId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const partner = await tx.partner.findUniqueOrThrow({
        where: { id: partnerId },
        select: { supplierId: true },
      });
      if (!partner.supplierId) throw noSupplier();
      const rows = await tx.$queryRaw<{ id: string; amount: Decimal; amountUsd: Decimal }[]>`
        SELECT a."id", a."amount", a."amount_usd" AS "amountUsd"
        FROM "commission_accruals" a
        JOIN "journal_entries" e ON e."id" = a."entry_id"
        WHERE a."partner_id" = ${partnerId}::uuid
          AND a."branch_id" = ${input.branchId}::uuid
          AND a."currency" = ${input.currency}
          AND a."statement_id" IS NULL
          AND e."entry_date" <= ${toDbDate(input.periodTo)}
        ORDER BY a."id"
        FOR UPDATE OF a`;
      const total = sum(rows.map((r) => r.amount));
      const totalUsd = sum(rows.map((r) => r.amountUsd));
      if (!total.gt(0) || !totalUsd.gt(0)) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'STATEMENT_NOT_POSITIVE',
          `The open commissions up to ${input.periodTo} total ${total.toFixed()} ${input.currency} (${totalUsd.toFixed()} USD): nothing to settle`,
          { total: total.toFixed(), currency: input.currency },
        );
      }
      const year = input.periodTo.slice(0, 4);
      const statement = await tx.partnerStatement.create({
        data: {
          number: formatDocumentNumber(
            'PST',
            await nextSequenceValue(tx, 'PARTNER_STATEMENT', year),
            year,
          ),
          partnerId,
          branchId: input.branchId,
          currency: input.currency,
          periodTo: toDbDate(input.periodTo),
          total,
          totalUsd,
          createdById: user.id,
        },
      });
      const taken = await tx.commissionAccrual.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, statementId: null },
        data: { statementId: statement.id },
      });
      if (taken.count !== rows.length) throw new Error('A locked commission row was taken');
      return statement.id;
    });
    return this.get(user, id);
  }

  /** A statement of the user's branches, with its rows. 404 else. */
  async get(user: AuthUser, id: string): Promise<PartnerStatementDto> {
    const statement = await this.prisma.partnerStatement.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!statement) throw new NotFoundException('Partner statement not found');
    return this.toDto(user, statement);
  }

  /** The partner's statements in the user's branches, newest first. */
  async forPartner(user: AuthUser, partnerId: string): Promise<PartnerStatementSummaryDto[]> {
    const statements = await this.prisma.partnerStatement.findMany({
      where: { partnerId, ...branchScope(user) },
      include: summary,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return statements.map(toSummary);
  }

  /**
   * A DRAFT statement is cancelled and its rows are released (the only change their trigger
   * allows). 409 STATEMENT_BILLED while it has a live bill: cancel the bill first.
   */
  async cancel(user: AuthUser, id: string): Promise<PartnerStatementDto> {
    await this.requireScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const statement = await lockStatement(tx, id);
      if (statement.status === 'BILLED' || statement.status === 'SETTLED') {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'STATEMENT_BILLED',
          'This statement has a supplier bill: cancel the bill first',
        );
      }
      if (statement.status !== 'DRAFT') throw changed();
      await tx.commissionAccrual.updateMany({
        where: { statementId: id },
        data: { statementId: null },
      });
      await tx.partnerStatement.update({ where: { id }, data: { status: 'CANCELLED' } });
    });
    return this.get(user, id);
  }

  /**
   * Makes the statement's draft supplier bill (5.2, F149-3), under the statement's lock, and marks
   * it BILLED: one live bill per statement. A retry with the same `requestId` returns the
   * statement as it made it; another request on a billed statement gets 409
   * STATEMENT_ALREADY_BILLED with the bill.
   */
  async bill(
    user: AuthUser,
    id: string,
    input: PartnerStatementBillInput,
  ): Promise<PartnerStatementDto> {
    await this.requireScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const statement = await lockStatement(tx, id);
      if (statement.status === 'BILLED' || statement.status === 'SETTLED') {
        if (statement.billId === input.requestId) {
          await this.requireSameBillRequest(tx, user, input);
          return;
        }
        const bill = await tx.supplierBill.findUnique({
          where: { id: statement.billId ?? '' },
          select: { id: true, number: true },
        });
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'STATEMENT_ALREADY_BILLED',
          'This statement already has a supplier bill',
          { billId: bill?.id ?? '', billNumber: bill?.number ?? '' },
        );
      }
      if (statement.status !== 'DRAFT') throw changed();
      const partner = await tx.partner.findUniqueOrThrow({
        where: { id: statement.partnerId },
        select: { supplierId: true },
      });
      if (!partner.supplierId) throw noSupplier();
      const billId = await this.bills.createFromStatementInTx(
        tx,
        user,
        {
          id,
          number: statement.number,
          branchId: statement.branchId,
          supplierId: partner.supplierId,
          currency: statement.currency,
          total: statement.total,
        },
        input,
      );
      await tx.partnerStatement.update({ where: { id }, data: { status: 'BILLED', billId } });
    });
    return this.get(user, id);
  }

  /**
   * F168-2: a retry of the bill request returns the bill it made only when it asks for the same
   * thing, as the same person; changed content gets 409. A request always names its due date
   * (left empty, the form sends the API's suggestion), so the saved one is what it asked for.
   */
  private async requireSameBillRequest(
    tx: Tx,
    user: AuthUser,
    input: PartnerStatementBillInput,
  ): Promise<void> {
    const bill = await tx.supplierBill.findUniqueOrThrow({
      where: { id: input.requestId },
      select: { createdById: true, billDate: true, dueDate: true, supplierReference: true },
    });
    const same =
      bill.createdById === user.id &&
      fromDbDate(bill.billDate) === input.billDate &&
      fromDbDate(bill.dueDate) === input.dueDate &&
      bill.supplierReference === (input.supplierReference ?? null);
    if (!same) throw new ConflictException('This request id was already used: send a new id');
  }

  async approvalLineInTx(
    tx: Tx,
    bill: StatementBillFacts,
  ): Promise<Extract<BillLineForPosting, { kind: 'COMMISSION' }>> {
    const statement = await lockStatement(tx, bill.line.statementId);
    const partner = await tx.$queryRaw<{ supplierId: string | null }[]>`
      SELECT "supplier_id" AS "supplierId" FROM "partners"
      WHERE "id" = ${statement.partnerId}::uuid FOR SHARE`;
    const rows = await tx.commissionAccrual.findMany({
      where: { statementId: statement.id },
      select: { shipmentId: true, amount: true, amountUsd: true, entryId: true },
      orderBy: [{ shipmentId: 'asc' }, { id: 'asc' }],
    });
    const mismatch = [
      statement.status !== 'BILLED' && 'the statement is not billed',
      statement.billId !== bill.id && 'the statement was billed again',
      statement.branchId !== bill.branchId && 'the branch',
      partner[0]?.supplierId !== bill.supplierId && "the partner's supplier",
      statement.currency !== bill.currency && 'the currency',
      !statement.total.eq(bill.line.amount) && 'the amount',
      !statement.total.eq(sum(rows.map((r) => r.amount))) && 'the rows',
      !statement.totalUsd.eq(sum(rows.map((r) => r.amountUsd))) && 'the USD value of the rows',
    ].filter((m): m is string => typeof m === 'string');
    if (mismatch.length > 0) {
      throw codedRefusal(
        HttpStatus.CONFLICT,
        'STATEMENT_BILL_MISMATCH',
        `This bill no longer matches statement ${statement.number} (${mismatch.join(', ')}): cancel it and make it again from the statement`,
        { statement: statement.number },
      );
    }
    const net = new Map<string, Decimal>();
    for (const row of rows) {
      net.set(row.shipmentId, (net.get(row.shipmentId) ?? ZERO).plus(row.amountUsd));
    }
    return {
      kind: 'COMMISSION',
      statementId: statement.id,
      statementNumber: statement.number,
      amount: bill.line.amount,
      totalUsd: statement.totalUsd,
      shipments: [...net].map(([shipmentId, netUsd]) => ({ shipmentId, netUsd })),
      rows: rows.map((row) => {
        if (!row.entryId) throw new Error(`A row of statement ${statement.number} has no entry`);
        return { entryId: row.entryId, amount: row.amount, amountUsd: row.amountUsd };
      }),
    };
  }

  async settledInTx(tx: Tx, statementId: string, billId: string): Promise<void> {
    const settled = await tx.partnerStatement.updateMany({
      where: { id: statementId, billId, status: 'BILLED' },
      data: { status: 'SETTLED' },
    });
    if (settled.count !== 1) throw new Error(`Statement ${statementId} was not settled`);
  }

  async billCancelledInTx(tx: Tx, statementId: string, billId: string): Promise<void> {
    const statement = await lockStatement(tx, statementId);
    // A bill that was replaced leaves the statement as it is (F149-3).
    if (statement.billId !== billId) return;
    await tx.partnerStatement.update({
      where: { id: statementId },
      data: { status: 'DRAFT', billId: null },
    });
  }

  /** A partner seen in the user's branches, or through one of its rows there. 404 else. */
  private async requireVisiblePartner(user: AuthUser, partnerId: string): Promise<void> {
    const scope = branchScope(user);
    const [partner, seen] = await Promise.all([
      this.prisma.partner.findFirst({ where: { id: partnerId, ...scope }, select: { id: true } }),
      this.prisma.commissionAccrual.findFirst({
        where: { partnerId, ...scope },
        select: { id: true },
      }),
    ]);
    if (!partner && !seen) throw new NotFoundException('Partner not found');
  }

  private async requireScoped(user: AuthUser, id: string): Promise<void> {
    const found = await this.prisma.partnerStatement.findFirst({
      where: { id, ...branchScope(user) },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Partner statement not found');
  }

  private toDto(user: AuthUser, s: StatementDetails): PartnerStatementDto {
    const can = (action: 'create' | 'update') =>
      user.access.has(`partner_commissions:${action}`, s.branchId) &&
      canAccessBranch(user, s.branchId);
    return {
      ...toSummary(s),
      partnerNumber: s.partner.number,
      partnerName: s.partner.name,
      partnerSupplierId: s.partner.supplierId,
      lines: s.accruals.map((a) => ({
        shipmentId: a.shipmentId,
        shipmentNumber: a.shipment.number,
        role: a.role,
        kind: a.kind,
        date: fromDbDate(a.entry.entryDate),
        event: a.kind === 'MANUAL' ? null : (a.contract?.accrualEvent ?? null),
        basis: a.kind === 'MANUAL' ? null : (a.contract?.basis ?? null),
        value: a.kind === 'MANUAL' ? null : (a.contract?.value.toFixed() ?? null),
        base: a.base?.toFixed() ?? null,
        quantity: a.quantity?.toFixed() ?? null,
        amount: a.amount.toFixed(),
        amountUsd: a.amountUsd.toFixed(),
        reason: a.reason,
      })),
      actions: {
        canBill: s.status === 'DRAFT' && can('create'),
        canCancel: s.status === 'DRAFT' && can('update'),
      },
    };
  }
}

function toSummary(s: StatementSummary): PartnerStatementSummaryDto {
  return {
    id: s.id,
    number: s.number,
    partnerId: s.partnerId,
    branchId: s.branchId,
    branchCode: s.branch.code,
    currency: s.currency,
    periodTo: fromDbDate(s.periodTo),
    total: s.total.toFixed(),
    totalUsd: s.totalUsd.toFixed(),
    status: s.status,
    billId: s.billId,
    billNumber: s.bill?.number ?? null,
    billStatus: s.bill?.status ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

/** The statement's row, locked FOR UPDATE. */
async function lockStatement(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "partner_statements" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return tx.partnerStatement.findUniqueOrThrow({ where: { id } });
}

function noSupplier() {
  return codedRefusal(
    HttpStatus.CONFLICT,
    'PARTNER_NO_SUPPLIER',
    'Link the partner to a supplier first: its commissions are paid as a supplier bill',
  );
}

function changed() {
  return new ConflictException('The statement was cancelled or changed by someone else; reload it');
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}
