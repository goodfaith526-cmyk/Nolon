import { Injectable } from '@nestjs/common';
import type { CommissionsDueDto, CommissionsDueRowDto } from '@nolon/shared';
import { LedgerReportsService } from '../accounting/ledger-reports.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { daysBetween, fromDbDate, todayIn } from '../common/dates.js';
import { type Decimal, ZERO } from '../common/money.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The age buckets' upper bounds in days (the last one is open). */
const AGE_LIMITS = [30, 60, 90] as const;

interface Group {
  partnerId: string;
  partnerNumber: string;
  partnerName: string;
  branchId: string;
  branchCode: string;
  currency: string;
  open: Decimal;
  inStatement: Decimal;
  unsettledUsd: Decimal;
  ages: [Decimal, Decimal, Decimal, Decimal];
}

/**
 * Report z4 (plan 07, 7): the partner commissions not settled yet (open, or in a statement whose
 * bill is not approved), by partner, branch and currency, aged from their entry dates as of
 * today in each branch. Read from the sub-ledger, with the accrued commissions account beside it
 * per branch: the two are equal (rule 16 and 16a keep them so).
 */
@Injectable()
export class CommissionsDueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerReportsService,
  ) {}

  async due(user: AuthUser): Promise<CommissionsDueDto> {
    const scope = branchScope(user);
    const [branches, rows, holds] = await Promise.all([
      this.prisma.branch.findMany({
        where: { id: { in: [...user.allowedBranchIds] } },
        select: { id: true, code: true, timezone: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.commissionAccrual.findMany({
        where: {
          ...scope,
          OR: [{ statementId: null }, { statement: { status: { in: ['DRAFT', 'BILLED'] } } }],
        },
        select: {
          partnerId: true,
          branchId: true,
          currency: true,
          amount: true,
          amountUsd: true,
          statementId: true,
          partner: { select: { number: true, name: true } },
          entry: { select: { entryDate: true } },
        },
      }),
      this.prisma.commissionHold.groupBy({
        by: ['partnerId', 'shipmentId'],
        where: { shipment: scope },
      }),
    ]);
    const today = new Map(branches.map((b) => [b.id, todayIn(b.timezone)]));
    const code = new Map(branches.map((b) => [b.id, b.code]));
    const groups = new Map<string, Group>();
    for (const row of rows) {
      const key = `${row.partnerId}:${row.branchId}:${row.currency}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          partnerId: row.partnerId,
          partnerNumber: row.partner.number,
          partnerName: row.partner.name,
          branchId: row.branchId,
          branchCode: code.get(row.branchId) ?? '',
          currency: row.currency,
          open: ZERO,
          inStatement: ZERO,
          unsettledUsd: ZERO,
          ages: [ZERO, ZERO, ZERO, ZERO],
        };
        groups.set(key, group);
      }
      if (row.statementId) group.inStatement = group.inStatement.plus(row.amount);
      else group.open = group.open.plus(row.amount);
      group.unsettledUsd = group.unsettledUsd.plus(row.amountUsd);
      const age = daysBetween(fromDbDate(row.entry.entryDate), today.get(row.branchId) ?? '');
      const bucket = AGE_LIMITS.findIndex((limit) => age <= limit);
      const index = bucket === -1 ? AGE_LIMITS.length : bucket;
      group.ages[index] = (group.ages[index] ?? ZERO).plus(row.amount);
    }
    const shipmentBranch = new Map(
      (
        await this.prisma.shipment.findMany({
          where: { id: { in: holds.map((h) => h.shipmentId) } },
          select: { id: true, branchId: true },
        })
      ).map((s) => [s.id, s.branchId]),
    );
    const held = new Map<string, number>();
    for (const hold of holds) {
      const key = `${hold.partnerId}:${shipmentBranch.get(hold.shipmentId) ?? ''}`;
      held.set(key, (held.get(key) ?? 0) + 1);
    }
    const result: CommissionsDueRowDto[] = [...groups.values()]
      .sort(
        (a, b) =>
          a.partnerNumber.localeCompare(b.partnerNumber) ||
          a.branchCode.localeCompare(b.branchCode) ||
          a.currency.localeCompare(b.currency),
      )
      .map((g) => {
        const unsettled = g.open.plus(g.inStatement);
        return {
          partnerId: g.partnerId,
          partnerNumber: g.partnerNumber,
          partnerName: g.partnerName,
          branchId: g.branchId,
          branchCode: g.branchCode,
          currency: g.currency,
          open: g.open.toFixed(),
          inStatement: g.inStatement.toFixed(),
          unsettled: unsettled.toFixed(),
          unsettledUsd: g.unsettledUsd.toFixed(),
          ages: [
            g.ages[0].toFixed(),
            g.ages[1].toFixed(),
            g.ages[2].toFixed(),
            g.ages[3].toFixed(),
          ],
          owesNolon: unsettled.isNegative(),
          holds: held.get(`${g.partnerId}:${g.branchId}`) ?? 0,
        };
      });
    const perBranch = [];
    for (const branch of branches) {
      const subLedger = rows
        .filter((r) => r.branchId === branch.id)
        .reduce((acc, r) => acc.plus(r.amountUsd), ZERO);
      const { balanceUsd } = await this.ledger.roleBalance(
        user,
        'ACCRUED_COMMISSIONS',
        today.get(branch.id) ?? '',
        branch.id,
      );
      // A liability: its balance is a credit, so the account shows it negated.
      const ledgerUsd = balanceUsd.negated();
      if (subLedger.isZero() && ledgerUsd.isZero()) continue;
      perBranch.push({
        branchId: branch.id,
        branchCode: branch.code,
        subLedgerUsd: subLedger.toFixed(),
        ledgerUsd: ledgerUsd.toFixed(),
        matches: subLedger.eq(ledgerUsd),
      });
    }
    const asOf = [...today.values()].sort().at(-1) ?? todayIn('UTC');
    return { asOf, rows: result, branches: perBranch };
  }
}
