import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AccountType,
  AuditLogEntryDto,
  BalanceSheetDto,
  BalanceSheetRowDto,
  BranchAmountsDto,
  CashAccountMovementDto,
  CashMovementDto,
  FxDifferenceLineDto,
  GeneralLedgerDto,
  IncomeStatementDto,
  IncomeStatementRowDto,
  JournalSource,
  LedgerAccountDto,
  PostingRole,
  ReportAccountDto,
  ReportAccountOptionDto,
  ReportBranchDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, ZERO, dec } from '../common/money.js';
import type { AuditQuery } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FX_DIFFERENCE_LINE } from './auto-journal.service.js';
import { naturalBalance, sum } from './report-math.js';

/** Revenue and cost of one shipment from its journal lines (shipment dimension). */
export interface ShipmentResult {
  shipmentId: string;
  revenueUsd: Decimal;
  costUsd: Decimal;
}

/** Accrued transport still open for one trip. */
export interface TripAccrual {
  tripId: string;
  currency: string;
  balance: Decimal;
  balanceUsd: Decimal;
}

/** A customer's balance on its own accounts before a statement period, in one currency. */
export interface CustomerOpening {
  currency: string;
  balance: Decimal;
  balanceUsd: Decimal;
}

/** One posted entry's lines on a customer's own accounts, in one currency. */
export interface CustomerMovement {
  entryId: string;
  number: string;
  entryDate: string;
  description: string;
  source: JournalSource;
  sourceId: string | null;
  /** The source of the entry a reversal reverses (null for other entries). */
  reversedSource: JournalSource | null;
  reversedSourceId: string | null;
  currency: string;
  debit: Decimal;
  credit: Decimal;
  debitUsd: Decimal;
  creditUsd: Decimal;
}

export interface Period {
  from: string;
  to: string;
}

interface AccountRow {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
}

/** Most entry ids per query (bound parameters are limited). */
const ENTRY_CHUNK = 1000;

/** `l."branch_id" IN (...)`: the line's own branch, among the report's branches. */
function lineBranchIn(branchIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`l."branch_id" IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})`;
}

/**
 * Accounts a user may name in a report filter: the chart is global, but a cash or bank account
 * tied to a branch belongs to that branch (AGENTS.md rule 2). Another branch's cash account is
 * treated like an unknown id.
 */
function visibleAccount(user: AuthUser): Prisma.AccountWhereInput {
  return {
    OR: [{ isCash: false }, { branchId: null }, { branchId: { in: [...user.allowedBranchIds] } }],
  };
}

function account(row: AccountRow): ReportAccountDto {
  return { accountId: row.accountId, code: row.code, nameEn: row.nameEn, nameAr: row.nameAr };
}

/**
 * The financial reports that read the general ledger (annex D section 4). Only POSTED entries
 * count, and only lines whose own branch is one of the report's branches (the requested branch,
 * checked against the user's, or all of the user's). Totals are added in SQL; the few rows that
 * come back are shaped here with Decimal arithmetic.
 */
@Injectable()
export class LedgerReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The report's branches, sorted by code, for column headers. */
  async branches(branchIds: readonly string[]): Promise<ReportBranchDto[]> {
    if (branchIds.length === 0) return [];
    return this.prisma.branch.findMany({
      where: { id: { in: [...branchIds] } },
      select: { id: true, code: true, nameEn: true, nameAr: true },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * The postable accounts, for the account filters of the reports (the chart is global master
   * data; users who may read reports but not the chart still pick accounts here).
   */
  async accountOptions(user: AuthUser): Promise<ReportAccountOptionDto[]> {
    const accounts = await this.prisma.account.findMany({
      where: { isPostable: true, ...visibleAccount(user) },
      select: {
        id: true,
        code: true,
        nameEn: true,
        nameAr: true,
        type: true,
        isCash: true,
        isActive: true,
      },
      orderBy: { code: 'asc' },
    });
    return accounts.map(({ id, ...rest }) => ({ accountId: id, ...rest }));
  }

  async incomeStatement(
    user: AuthUser,
    period: Period,
    branchId?: string,
  ): Promise<IncomeStatementDto> {
    const branchIds = reportBranchIds(user, branchId);
    const branches = await this.branches(branchIds);
    const rows =
      branchIds.length === 0
        ? []
        : await this.prisma.$queryRaw<
            (AccountRow & { branchId: string; debitUsd: Decimal; creditUsd: Decimal })[]
          >`
            SELECT a."id" AS "accountId", a."code", a."name_en" AS "nameEn", a."name_ar" AS "nameAr",
                   a."type"::text AS "type", l."branch_id" AS "branchId",
                   sum(l."debit_usd") AS "debitUsd", sum(l."credit_usd") AS "creditUsd"
            FROM "journal_lines" l
            JOIN "journal_entries" e ON e."id" = l."entry_id"
            JOIN "accounts" a ON a."id" = l."account_id"
            WHERE e."status" = 'POSTED'
              AND e."entry_date" BETWEEN ${toDbDate(period.from)} AND ${toDbDate(period.to)}
              AND a."type" IN ('REVENUE', 'EXPENSE')
              AND ${lineBranchIn(branchIds)}
            GROUP BY a."id", l."branch_id"
            ORDER BY a."code"`;
    const column = new Map(branches.map((b, i) => [b.id, i]));
    const byAccount = new Map<string, { row: AccountRow; amounts: Decimal[] }>();
    for (const r of rows) {
      const entry = byAccount.get(r.accountId) ?? {
        row: r,
        amounts: branches.map(() => ZERO),
      };
      const i = column.get(r.branchId);
      if (i !== undefined) {
        entry.amounts[i] = (entry.amounts[i] ?? ZERO).plus(
          naturalBalance(r.type, dec(r.debitUsd), dec(r.creditUsd)),
        );
      }
      byAccount.set(r.accountId, entry);
    }
    const toRow = ({ row, amounts }: { row: AccountRow; amounts: Decimal[] }) => ({
      ...account(row),
      type: row.type as IncomeStatementRowDto['type'],
      amounts,
    });
    const all = [...byAccount.values()].map(toRow);
    const revenue = all.filter((r) => r.type === 'REVENUE');
    const expenses = all.filter((r) => r.type === 'EXPENSE');
    const columnTotals = (list: { amounts: Decimal[] }[]) =>
      branches.map((_, i) => sum(list.map((r) => r.amounts[i] ?? ZERO)));
    const revenueTotals = columnTotals(revenue);
    const expenseTotals = columnTotals(expenses);
    const netTotals = revenueTotals.map((v, i) => v.minus(expenseTotals[i] ?? ZERO));
    const rowDto = (r: ReturnType<typeof toRow>): IncomeStatementRowDto => ({
      accountId: r.accountId,
      code: r.code,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      type: r.type,
      ...branchAmounts(r.amounts),
    });
    return {
      from: period.from,
      to: period.to,
      branchId: branchId ?? null,
      branches,
      revenue: revenue.map(rowDto),
      expenses: expenses.map(rowDto),
      totalRevenue: branchAmounts(revenueTotals),
      totalExpenses: branchAmounts(expenseTotals),
      netIncome: branchAmounts(netTotals),
    };
  }

  async balanceSheet(user: AuthUser, asOf: string, branchId?: string): Promise<BalanceSheetDto> {
    const branchIds = reportBranchIds(user, branchId);
    const rows =
      branchIds.length === 0
        ? []
        : await this.prisma.$queryRaw<(AccountRow & { debitUsd: Decimal; creditUsd: Decimal })[]>`
            SELECT a."id" AS "accountId", a."code", a."name_en" AS "nameEn", a."name_ar" AS "nameAr",
                   a."type"::text AS "type",
                   sum(l."debit_usd") AS "debitUsd", sum(l."credit_usd") AS "creditUsd"
            FROM "journal_lines" l
            JOIN "journal_entries" e ON e."id" = l."entry_id"
            JOIN "accounts" a ON a."id" = l."account_id"
            WHERE e."status" = 'POSTED'
              AND e."entry_date" <= ${toDbDate(asOf)}
              AND ${lineBranchIn(branchIds)}
            GROUP BY a."id"
            ORDER BY a."code"`;
    const assets: BalanceSheetRowDto[] = [];
    const liabilities: BalanceSheetRowDto[] = [];
    const equity: BalanceSheetRowDto[] = [];
    let earnings = ZERO;
    for (const r of rows) {
      const balance = naturalBalance(r.type, dec(r.debitUsd), dec(r.creditUsd));
      if (r.type === 'REVENUE') earnings = earnings.plus(balance);
      else if (r.type === 'EXPENSE') earnings = earnings.minus(balance);
      else if (!balance.isZero()) {
        const target = r.type === 'ASSET' ? assets : r.type === 'LIABILITY' ? liabilities : equity;
        target.push({ ...account(r), balanceUsd: balance.toFixed() });
      }
    }
    const total = (list: BalanceSheetRowDto[]) => sum(list.map((r) => dec(r.balanceUsd)));
    const totalAssets = total(assets);
    const totalLiabilities = total(liabilities);
    const totalEquity = total(equity).plus(earnings);
    const liabilitiesAndEquity = totalLiabilities.plus(totalEquity);
    return {
      asOf,
      branchId: branchId ?? null,
      assets,
      liabilities,
      equity,
      unclosedEarningsUsd: earnings.toFixed(),
      totalAssetsUsd: totalAssets.toFixed(),
      totalLiabilitiesUsd: totalLiabilities.toFixed(),
      totalEquityUsd: totalEquity.toFixed(),
      totalLiabilitiesAndEquityUsd: liabilitiesAndEquity.toFixed(),
      balanced: totalAssets.eq(liabilitiesAndEquity),
    };
  }

  /** 404 when an account does not exist. Balances are debit - credit, as in the trial balance. */
  async generalLedger(
    user: AuthUser,
    period: Period,
    accountIds: readonly string[],
    branchId?: string,
  ): Promise<GeneralLedgerDto> {
    const branchIds = reportBranchIds(user, branchId);
    const ids = [...new Set(accountIds)];
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: ids }, ...visibleAccount(user) },
      select: { id: true, code: true, nameEn: true, nameAr: true, type: true },
      orderBy: { code: 'asc' },
    });
    if (accounts.length !== ids.length) throw new NotFoundException('Account not found');
    const accountIn = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
    const [openings, lines] =
      branchIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.$queryRaw<{ accountId: string; balanceUsd: Decimal }[]>`
              SELECT l."account_id" AS "accountId", sum(l."debit_usd" - l."credit_usd") AS "balanceUsd"
              FROM "journal_lines" l
              JOIN "journal_entries" e ON e."id" = l."entry_id"
              WHERE e."status" = 'POSTED'
                AND e."entry_date" < ${toDbDate(period.from)}
                AND l."account_id" IN (${accountIn})
                AND ${lineBranchIn(branchIds)}
              GROUP BY l."account_id"`,
            this.prisma.$queryRaw<
              {
                accountId: string;
                entryId: string;
                entryNumber: string;
                entryDate: Date;
                source: JournalSource;
                description: string;
                branchCode: string;
                currency: string;
                debit: Decimal;
                credit: Decimal;
                debitUsd: Decimal;
                creditUsd: Decimal;
                movementUsd: Decimal;
              }[]
            >`
              SELECT l."account_id" AS "accountId", e."id" AS "entryId", e."number" AS "entryNumber",
                     e."entry_date" AS "entryDate", e."source"::text AS "source",
                     CASE WHEN l."description" IS NULL OR l."description" = ''
                            OR position(l."description" IN e."description") > 0 THEN e."description"
                          ELSE e."description" || ' / ' || l."description" END AS "description",
                     b."code" AS "branchCode", l."currency",
                     l."debit", l."credit", l."debit_usd" AS "debitUsd", l."credit_usd" AS "creditUsd",
                     sum(l."debit_usd" - l."credit_usd") OVER (
                       PARTITION BY l."account_id"
                       ORDER BY e."entry_date", e."number", l."line_no"
                       ROWS UNBOUNDED PRECEDING
                     ) AS "movementUsd"
              FROM "journal_lines" l
              JOIN "journal_entries" e ON e."id" = l."entry_id"
              JOIN "branches" b ON b."id" = l."branch_id"
              WHERE e."status" = 'POSTED'
                AND e."entry_date" BETWEEN ${toDbDate(period.from)} AND ${toDbDate(period.to)}
                AND l."account_id" IN (${accountIn})
                AND ${lineBranchIn(branchIds)}
              ORDER BY e."entry_date", e."number", l."line_no"`,
          ]);
    const opening = new Map(openings.map((o) => [o.accountId, dec(o.balanceUsd)]));
    const result: LedgerAccountDto[] = accounts.map((a) => {
      const openingUsd = opening.get(a.id) ?? ZERO;
      const own = lines.filter((l) => l.accountId === a.id);
      const totalDebit = sum(own.map((l) => dec(l.debitUsd)));
      const totalCredit = sum(own.map((l) => dec(l.creditUsd)));
      return {
        accountId: a.id,
        code: a.code,
        nameEn: a.nameEn,
        nameAr: a.nameAr,
        type: a.type,
        openingUsd: openingUsd.toFixed(),
        lines: own.map((l) => ({
          entryId: l.entryId,
          entryNumber: l.entryNumber,
          entryDate: fromDbDate(l.entryDate),
          source: l.source,
          description: l.description,
          branchCode: l.branchCode,
          currency: l.currency,
          debit: dec(l.debit).toFixed(),
          credit: dec(l.credit).toFixed(),
          debitUsd: dec(l.debitUsd).toFixed(),
          creditUsd: dec(l.creditUsd).toFixed(),
          balanceUsd: openingUsd.plus(dec(l.movementUsd)).toFixed(),
        })),
        totalDebitUsd: totalDebit.toFixed(),
        totalCreditUsd: totalCredit.toFixed(),
        closingUsd: openingUsd.plus(totalDebit).minus(totalCredit).toFixed(),
      };
    });
    return { from: period.from, to: period.to, branchId: branchId ?? null, accounts: result };
  }

  /**
   * Cash and bank accounts (isCash): opening, money in (debits), money out (credits) and closing,
   * in the account's currency and in USD; plus the realized exchange differences of the period
   * (receipts into the chosen account only, when one is chosen). `accountId` must be a cash
   * account the user may see (404 otherwise, like an unknown id).
   */
  async cashMovement(
    user: AuthUser,
    period: Period,
    branchId?: string,
    accountId?: string,
  ): Promise<CashMovementDto> {
    const branchIds = reportBranchIds(user, branchId);
    if (accountId) {
      const found = await this.prisma.account.findFirst({
        where: { id: accountId, isCash: true, ...visibleAccount(user) },
      });
      if (!found) throw new NotFoundException('Cash or bank account not found');
    }
    const from = toDbDate(period.from);
    const to = toDbDate(period.to);
    const onlyAccount = accountId ? Prisma.sql`AND a."id" = ${accountId}::uuid` : Prisma.empty;
    // Realized FX: the exchange-difference lines of receipt entries and of their reversals, on
    // whatever revenue (gain) or expense (loss) account they were posted to at the time. With an
    // account chosen, only the receipts into that account.
    const onlyReceiptsInto = accountId
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "journal_lines" c
          WHERE c."entry_id" = e."id" AND c."account_id" = ${accountId}::uuid)`
      : Prisma.empty;
    const [rows, fxRows] =
      branchIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.$queryRaw<
              (Omit<AccountRow, 'type'> & {
                currency: string | null;
                opening: Decimal;
                inflow: Decimal;
                outflow: Decimal;
                openingUsd: Decimal;
                inflowUsd: Decimal;
                outflowUsd: Decimal;
              })[]
            >`
              SELECT a."id" AS "accountId", a."code", a."name_en" AS "nameEn", a."name_ar" AS "nameAr",
                     a."currency",
                     sum(CASE WHEN e."entry_date" < ${from} THEN l."debit" - l."credit" ELSE 0 END) AS "opening",
                     sum(CASE WHEN e."entry_date" >= ${from} THEN l."debit" ELSE 0 END) AS "inflow",
                     sum(CASE WHEN e."entry_date" >= ${from} THEN l."credit" ELSE 0 END) AS "outflow",
                     sum(CASE WHEN e."entry_date" < ${from} THEN l."debit_usd" - l."credit_usd" ELSE 0 END) AS "openingUsd",
                     sum(CASE WHEN e."entry_date" >= ${from} THEN l."debit_usd" ELSE 0 END) AS "inflowUsd",
                     sum(CASE WHEN e."entry_date" >= ${from} THEN l."credit_usd" ELSE 0 END) AS "outflowUsd"
              FROM "journal_lines" l
              JOIN "journal_entries" e ON e."id" = l."entry_id"
              JOIN "accounts" a ON a."id" = l."account_id"
              WHERE e."status" = 'POSTED'
                AND e."entry_date" <= ${to}
                AND a."is_cash"
                AND ${lineBranchIn(branchIds)}
                ${onlyAccount}
              GROUP BY a."id"
              ORDER BY a."code"`,
            this.prisma.$queryRaw<
              {
                entryId: string;
                entryNumber: string;
                entryDate: Date;
                description: string;
                branchCode: string;
                accountType: AccountType;
                netCreditUsd: Decimal;
              }[]
            >`
              SELECT e."id" AS "entryId", e."number" AS "entryNumber", e."entry_date" AS "entryDate",
                     e."description", b."code" AS "branchCode", a."type"::text AS "accountType",
                     sum(l."credit_usd" - l."debit_usd") AS "netCreditUsd"
              FROM "journal_lines" l
              JOIN "journal_entries" e ON e."id" = l."entry_id"
              LEFT JOIN "journal_entries" o ON o."id" = e."reversal_of_id"
              JOIN "accounts" a ON a."id" = l."account_id"
              JOIN "branches" b ON b."id" = l."branch_id"
              WHERE e."status" = 'POSTED'
                AND e."entry_date" BETWEEN ${from} AND ${to}
                AND (e."source" = 'RECEIPT' OR o."source" = 'RECEIPT')
                AND l."description" = ${FX_DIFFERENCE_LINE}
                AND a."type" IN ('REVENUE', 'EXPENSE')
                AND ${lineBranchIn(branchIds)}
                ${onlyReceiptsInto}
              GROUP BY e."id", b."code", a."type"
              ORDER BY e."entry_date", e."number"`,
          ]);
    const accounts: CashAccountMovementDto[] = rows.map((r) => {
      const opening = dec(r.opening);
      const openingUsd = dec(r.openingUsd);
      return {
        accountId: r.accountId,
        code: r.code,
        nameEn: r.nameEn,
        nameAr: r.nameAr,
        currency: r.currency,
        opening: opening.toFixed(),
        inflow: dec(r.inflow).toFixed(),
        outflow: dec(r.outflow).toFixed(),
        closing: opening.plus(dec(r.inflow)).minus(dec(r.outflow)).toFixed(),
        openingUsd: openingUsd.toFixed(),
        inflowUsd: dec(r.inflowUsd).toFixed(),
        outflowUsd: dec(r.outflowUsd).toFixed(),
        closingUsd: openingUsd.plus(dec(r.inflowUsd)).minus(dec(r.outflowUsd)).toFixed(),
      };
    });
    const totalOf = (key: 'openingUsd' | 'inflowUsd' | 'outflowUsd' | 'closingUsd') =>
      sum(accounts.map((a) => dec(a[key]))).toFixed();
    let gainUsd = ZERO;
    let lossUsd = ZERO;
    const fxLines = new Map<string, FxDifferenceLineDto & { amount: Decimal }>();
    for (const r of fxRows) {
      const net = dec(r.netCreditUsd);
      // Credits to a revenue account are gains; debits to an expense account are losses.
      if (r.accountType === 'REVENUE') gainUsd = gainUsd.plus(net);
      else lossUsd = lossUsd.minus(net);
      const key = `${r.entryId}/${r.branchCode}`;
      const line = fxLines.get(key) ?? {
        entryId: r.entryId,
        entryNumber: r.entryNumber,
        entryDate: fromDbDate(r.entryDate),
        description: r.description,
        branchCode: r.branchCode,
        amountUsd: '0',
        amount: ZERO,
      };
      line.amount = line.amount.plus(net);
      line.amountUsd = line.amount.toFixed();
      fxLines.set(key, line);
    }
    return {
      from: period.from,
      to: period.to,
      branchId: branchId ?? null,
      accounts,
      totals: {
        openingUsd: totalOf('openingUsd'),
        inflowUsd: totalOf('inflowUsd'),
        outflowUsd: totalOf('outflowUsd'),
        closingUsd: totalOf('closingUsd'),
      },
      fx: {
        gainUsd: gainUsd.toFixed(),
        lossUsd: lossUsd.toFixed(),
        netUsd: gainUsd.minus(lossUsd).toFixed(),
        lines: [...fxLines.values()].map(({ amount: _amount, ...line }) => line),
      },
    };
  }

  /**
   * Revenue (credit - debit on revenue accounts) and cost (debit - credit on expense accounts) per
   * shipment, from posted lines of the period that carry the shipment, in the report's branches.
   * The caller keeps only the shipments the user may see.
   */
  async shipmentResults(
    user: AuthUser,
    period: Period,
    branchId?: string,
  ): Promise<ShipmentResult[]> {
    const branchIds = reportBranchIds(user, branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      { shipmentId: string; revenueUsd: Decimal; costUsd: Decimal }[]
    >`
      SELECT l."shipment_id" AS "shipmentId",
             sum(CASE WHEN a."type" = 'REVENUE' THEN l."credit_usd" - l."debit_usd" ELSE 0 END) AS "revenueUsd",
             sum(CASE WHEN a."type" = 'EXPENSE' THEN l."debit_usd" - l."credit_usd" ELSE 0 END) AS "costUsd"
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."entry_id"
      JOIN "accounts" a ON a."id" = l."account_id"
      WHERE e."status" = 'POSTED'
        AND e."entry_date" BETWEEN ${toDbDate(period.from)} AND ${toDbDate(period.to)}
        AND a."type" IN ('REVENUE', 'EXPENSE')
        AND l."shipment_id" IS NOT NULL
        AND ${lineBranchIn(branchIds)}
      GROUP BY l."shipment_id"`;
    return rows.map((r) => ({
      shipmentId: r.shipmentId,
      revenueUsd: dec(r.revenueUsd),
      costUsd: dec(r.costUsd),
    }));
  }

  /**
   * Accrued transport costs as of a date. Per trip: the accrued line of each rule 11 entry (source
   * TRIP_ACCRUAL, its liability line without a shipment) and of its reversal, credit - debit, on
   * whatever account it was posted to, so a remap of ACCRUED_TRANSPORT hides nothing. `otherUsd`
   * is what else sits on the account mapped today (manual entries). Zero balances are left out.
   */
  async openTripAccruals(
    user: AuthUser,
    asOf: string,
    branchId?: string,
  ): Promise<{ account: ReportAccountDto | null; trips: TripAccrual[]; otherUsd: Decimal }> {
    const branchIds = reportBranchIds(user, branchId);
    const accrued = await this.mapped('ACCRUED_TRANSPORT');
    if (branchIds.length === 0) return { account: accrued, trips: [], otherUsd: ZERO };
    const at = toDbDate(asOf);
    const [rows, other] = await Promise.all([
      this.prisma.$queryRaw<
        { tripId: string; currency: string; balance: Decimal; balanceUsd: Decimal }[]
      >`
        SELECT CASE WHEN e."source" = 'TRIP_ACCRUAL' THEN e."source_id" ELSE o."source_id" END AS "tripId",
               l."currency",
               sum(l."credit" - l."debit") AS "balance",
               sum(l."credit_usd" - l."debit_usd") AS "balanceUsd"
        FROM "journal_lines" l
        JOIN "journal_entries" e ON e."id" = l."entry_id"
        LEFT JOIN "journal_entries" o ON o."id" = e."reversal_of_id"
        JOIN "accounts" a ON a."id" = l."account_id"
        WHERE e."status" = 'POSTED'
          AND e."entry_date" <= ${at}
          AND (e."source" = 'TRIP_ACCRUAL' OR o."source" = 'TRIP_ACCRUAL')
          AND l."shipment_id" IS NULL
          AND a."type" = 'LIABILITY'
          AND ${lineBranchIn(branchIds)}
        GROUP BY 1, 2
        HAVING sum(l."credit_usd" - l."debit_usd") <> 0 OR sum(l."credit" - l."debit") <> 0`,
      accrued
        ? this.prisma.$queryRaw<{ balanceUsd: Decimal | null }[]>`
            SELECT sum(l."credit_usd" - l."debit_usd") AS "balanceUsd"
            FROM "journal_lines" l
            JOIN "journal_entries" e ON e."id" = l."entry_id"
            LEFT JOIN "journal_entries" o ON o."id" = e."reversal_of_id"
            WHERE e."status" = 'POSTED'
              AND e."entry_date" <= ${at}
              AND l."account_id" = ${accrued.accountId}::uuid
              AND e."source" <> 'TRIP_ACCRUAL'
              AND o."source" IS DISTINCT FROM 'TRIP_ACCRUAL'
              AND ${lineBranchIn(branchIds)}`
        : Promise.resolve([]),
    ]);
    const otherValue = other[0]?.balanceUsd;
    return {
      account: accrued,
      trips: rows.map((r) => ({
        tripId: r.tripId,
        currency: r.currency,
        balance: dec(r.balance),
        balanceUsd: dec(r.balanceUsd),
      })),
      otherUsd: otherValue === null || otherValue === undefined ? ZERO : dec(otherValue),
    };
  }

  /**
   * Unapplied customer advances as of a date, per customer, credit - debit in USD: the liability
   * lines of receipt entries and their reversals (the part of a receipt not allocated to an
   * invoice), wherever they were posted, plus any other line carrying the customer on the account
   * mapped to CUSTOMER_ADVANCES today.
   */
  async customerAdvances(
    user: AuthUser,
    asOf: string,
    branchId?: string,
    customerId?: string,
  ): Promise<{ customerId: string; customerName: string; amountUsd: Decimal }[]> {
    const branchIds = reportBranchIds(user, branchId);
    if (branchIds.length === 0) return [];
    const advances = await this.mapped('CUSTOMER_ADVANCES');
    const onMapped = advances
      ? Prisma.sql`OR l."account_id" = ${advances.accountId}::uuid`
      : Prisma.empty;
    const onlyCustomer = customerId
      ? Prisma.sql`AND l."customer_id" = ${customerId}::uuid`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { customerId: string; customerName: string; amountUsd: Decimal }[]
    >`
      SELECT l."customer_id" AS "customerId", c."name" AS "customerName",
             sum(l."credit_usd" - l."debit_usd") AS "amountUsd"
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."entry_id"
      LEFT JOIN "journal_entries" o ON o."id" = e."reversal_of_id"
      JOIN "accounts" a ON a."id" = l."account_id"
      JOIN "customers" c ON c."id" = l."customer_id"
      WHERE e."status" = 'POSTED'
        AND e."entry_date" <= ${toDbDate(asOf)}
        AND (((e."source" = 'RECEIPT' OR o."source" = 'RECEIPT') AND a."type" = 'LIABILITY')
             ${onMapped})
        AND ${lineBranchIn(branchIds)}
        ${onlyCustomer}
      GROUP BY l."customer_id", c."name"
      HAVING sum(l."credit_usd" - l."debit_usd") <> 0`;
    return rows.map((r) => ({ ...r, amountUsd: dec(r.amountUsd) }));
  }

  /**
   * Posted lines carrying the customer on its own accounts, in the report's branches: the
   * receivable accounts its invoices were posted to (`receivableAccountIds`, which billing keeps),
   * the accounts mapped to RECEIVABLE and CUSTOMER_ADVANCES today, and the liability lines of
   * receipt entries and their reversals (advances, wherever they were posted, as in
   * `customerAdvances`). Lines dated before `from` are summed per currency (the opening); lines
   * from `from` to `to` are summed per entry and currency, in date and entry-number order.
   */
  async customerAccountLines(
    user: AuthUser,
    q: {
      customerId: string;
      receivableAccountIds: readonly string[];
      from: string;
      to: string;
      branchId?: string;
    },
  ): Promise<{ opening: CustomerOpening[]; movements: CustomerMovement[] }> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return { opening: [], movements: [] };
    const [receivable, advances] = await Promise.all([
      this.mapped('RECEIVABLE'),
      this.mapped('CUSTOMER_ADVANCES'),
    ]);
    const accountIds = [
      ...new Set(
        [...q.receivableAccountIds, receivable?.accountId, advances?.accountId].filter(
          (id): id is string => id !== undefined,
        ),
      ),
    ];
    const onAccounts =
      accountIds.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`l."account_id" IN (${Prisma.join(accountIds.map((id) => Prisma.sql`${id}::uuid`))})`;
    const customerLines = Prisma.sql`
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."entry_id"
      LEFT JOIN "journal_entries" o ON o."id" = e."reversal_of_id"
      JOIN "accounts" a ON a."id" = l."account_id"
      WHERE e."status" = 'POSTED'
        AND l."customer_id" = ${q.customerId}::uuid
        AND (${onAccounts}
             OR ((e."source" = 'RECEIPT' OR o."source" = 'RECEIPT') AND a."type" = 'LIABILITY'))
        AND ${lineBranchIn(branchIds)}`;
    const [opening, movements] = await Promise.all([
      this.prisma.$queryRaw<
        { currency: string; balance: Decimal; balanceUsd: Decimal }[]
      >`SELECT l."currency", sum(l."debit" - l."credit") AS "balance",
               sum(l."debit_usd" - l."credit_usd") AS "balanceUsd"
        ${customerLines}
          AND e."entry_date" < ${toDbDate(q.from)}
        GROUP BY l."currency"`,
      this.prisma.$queryRaw<
        {
          entryId: string;
          number: string;
          entryDate: Date;
          description: string;
          source: JournalSource;
          sourceId: string | null;
          reversedSource: JournalSource | null;
          reversedSourceId: string | null;
          currency: string;
          debit: Decimal;
          credit: Decimal;
          debitUsd: Decimal;
          creditUsd: Decimal;
        }[]
      >`SELECT e."id" AS "entryId", e."number", e."entry_date" AS "entryDate", e."description",
               e."source", e."source_id" AS "sourceId", o."source" AS "reversedSource",
               o."source_id" AS "reversedSourceId", l."currency",
               sum(l."debit") AS "debit", sum(l."credit") AS "credit",
               sum(l."debit_usd") AS "debitUsd", sum(l."credit_usd") AS "creditUsd"
        ${customerLines}
          AND e."entry_date" BETWEEN ${toDbDate(q.from)} AND ${toDbDate(q.to)}
        GROUP BY e."id", o."id", l."currency"
        ORDER BY e."entry_date", e."number", l."currency"`,
    ]);
    return {
      opening: opening.map((r) => ({
        currency: r.currency,
        balance: dec(r.balance),
        balanceUsd: dec(r.balanceUsd),
      })),
      movements: movements.map((r) => ({
        entryId: r.entryId,
        number: r.number,
        entryDate: fromDbDate(r.entryDate),
        description: r.description,
        source: r.source,
        sourceId: r.sourceId,
        reversedSource: r.reversedSource,
        reversedSourceId: r.reversedSourceId,
        currency: r.currency,
        debit: dec(r.debit),
        credit: dec(r.credit),
        debitUsd: dec(r.debitUsd),
        creditUsd: dec(r.creditUsd),
      })),
    };
  }

  /**
   * Debit - credit of the account mapped to `role`, as of a date, in the report's branches. Used
   * for CONSOLIDATION_CLEARING: nothing posts to it yet (consolidation is not built) and the
   * mapping keeps no history, so the account mapped today is the only one known.
   */
  async roleBalance(
    user: AuthUser,
    role: PostingRole,
    asOf: string,
    branchId?: string,
  ): Promise<{ account: ReportAccountDto | null; balanceUsd: Decimal }> {
    const branchIds = reportBranchIds(user, branchId);
    const mapped = await this.mapped(role);
    if (!mapped || branchIds.length === 0) return { account: mapped, balanceUsd: ZERO };
    const rows = await this.prisma.$queryRaw<{ balanceUsd: Decimal | null }[]>`
      SELECT sum(l."debit_usd" - l."credit_usd") AS "balanceUsd"
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."entry_id"
      WHERE e."status" = 'POSTED'
        AND e."entry_date" <= ${toDbDate(asOf)}
        AND l."account_id" = ${mapped.accountId}::uuid
        AND ${lineBranchIn(branchIds)}`;
    const value = rows[0]?.balanceUsd;
    return {
      account: mapped,
      balanceUsd: value === null || value === undefined ? ZERO : dec(value),
    };
  }

  /**
   * The cost (expense accounts, debit - credit, in USD) posted by each of `entryIds`, net of its
   * posted reversal, from lines in the report's branches. Keyed by the original entry's id; entries
   * that are not posted are left out.
   */
  async entryCostsUsd(
    user: AuthUser,
    entryIds: readonly string[],
    branchId?: string,
  ): Promise<Map<string, Decimal>> {
    const branchIds = reportBranchIds(user, branchId);
    const costs = new Map<string, Decimal>();
    if (branchIds.length === 0 || entryIds.length === 0) return costs;
    for (let i = 0; i < entryIds.length; i += ENTRY_CHUNK) {
      const ids = Prisma.join(
        entryIds.slice(i, i + ENTRY_CHUNK).map((id) => Prisma.sql`${id}::uuid`),
      );
      const rows = await this.prisma.$queryRaw<{ entryId: string; costUsd: Decimal }[]>`
        SELECT coalesce(e."reversal_of_id", e."id") AS "entryId",
               sum(l."debit_usd" - l."credit_usd") AS "costUsd"
        FROM "journal_lines" l
        JOIN "journal_entries" e ON e."id" = l."entry_id"
        JOIN "accounts" a ON a."id" = l."account_id"
        WHERE e."status" = 'POSTED'
          AND (e."id" IN (${ids}) OR e."reversal_of_id" IN (${ids}))
          AND a."type" = 'EXPENSE'
          AND ${lineBranchIn(branchIds)}
        GROUP BY 1`;
      for (const r of rows) costs.set(r.entryId, dec(r.costUsd));
    }
    return costs;
  }

  /** Audit log: journal entries created and posted in the period (days in the entry's branch). */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string;
        userId: string;
        userName: string;
        action: 'CREATED' | 'POSTED';
        reference: string;
        detail: string;
      }[]
    >`
      WITH events AS (
        SELECT e."branch_id", e."created_at" AS "at", e."created_by_id" AS "user_id",
               'CREATED' AS "action", e."number" AS "reference", e."description" AS "detail"
        FROM "journal_entries" e
        UNION ALL
        SELECT e."branch_id", e."posted_at", e."posted_by_id", 'POSTED', e."number", e."description"
        FROM "journal_entries" e WHERE e."posted_at" IS NOT NULL AND e."posted_by_id" IS NOT NULL
      )
      SELECT x."at", b."code" AS "branchCode", x."user_id" AS "userId", u."full_name" AS "userName",
             x."action", x."reference", x."detail"
      FROM events x
      JOIN "branches" b ON b."id" = x."branch_id"
      JOIN "users" u ON u."id" = x."user_id"
      WHERE x."branch_id" IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND (x."at" AT TIME ZONE b."timezone")::date BETWEEN ${q.from}::date AND ${q.to}::date
        ${q.userId ? Prisma.sql`AND x."user_id" = ${q.userId}::uuid` : Prisma.empty}
      ORDER BY x."at" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map((r) => ({
      ...r,
      at: r.at.toISOString(),
      entity: 'JOURNAL_ENTRY',
      status: null,
    }));
  }

  private async mapped(role: PostingRole): Promise<ReportAccountDto | null> {
    const mapping = await this.prisma.accountMapping.findUnique({
      where: { role },
      select: { account: { select: { id: true, code: true, nameEn: true, nameAr: true } } },
    });
    if (!mapping) return null;
    const { id, ...rest } = mapping.account;
    return { accountId: id, ...rest };
  }
}

function branchAmounts(amounts: readonly Decimal[]): BranchAmountsDto {
  return { byBranch: amounts.map((a) => a.toFixed()), total: sum(amounts).toFixed() };
}
