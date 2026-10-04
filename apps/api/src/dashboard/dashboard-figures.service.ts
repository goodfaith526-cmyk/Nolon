import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  BranchDashboardDto,
  DashboardFinanceDto,
  ManagementDashboardDto,
  Permission,
  ReportBranchDto,
} from '@nolon/shared';
import { LedgerReportsService } from '../accounting/ledger-reports.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { BillingReportsService } from '../billing/billing-reports.service.js';
import { todayIn } from '../common/dates.js';
import { dec } from '../common/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentReportsService } from '../shipments/shipment-reports.service.js';
import { TripReportsService } from '../transport/trip-reports.service.js';
import { WarehouseReportsService } from '../warehouse/warehouse-reports.service.js';

export interface DashboardQuery {
  from?: string;
  to?: string;
  branchId?: string;
}

/** How many customers, shipments and trips the dashboards list. */
const TOP_CUSTOMERS = 5;
const LISTED = 10;

/** First day of the month of a YYYY-MM-DD date. */
function monthStart(day: string): string {
  return `${day.slice(0, 8)}01`;
}

/**
 * The management and branch dashboards (annex D section 2). Every figure comes from the owning
 * module's report service, scoped there to the user's branches; a section is null when the user
 * lacks the module's view permission (as on the home page). The period defaults to this month to
 * date. There is no alerts section: alert rules are not built yet.
 */
@Injectable()
export class DashboardFiguresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentReportsService,
    private readonly ledger: LedgerReportsService,
    private readonly billing: BillingReportsService,
    private readonly warehouse: WarehouseReportsService,
    private readonly trips: TripReportsService,
  ) {}

  async management(user: AuthUser, q: DashboardQuery): Promise<ManagementDashboardDto> {
    const branchIds = reportBranchIds(user, q.branchId);
    const [first] = await this.branches(branchIds);
    const today = todayIn(first?.timezone ?? 'UTC');
    return this.figures(user, {
      from: q.from ?? monthStart(q.to ?? today),
      to: q.to ?? today,
      branchId: q.branchId,
    });
  }

  /** One branch: the one asked for (403 outside the user's), else the user's first by code. */
  async branch(user: AuthUser, q: DashboardQuery): Promise<BranchDashboardDto> {
    const [branch] = await this.branches(reportBranchIds(user, q.branchId));
    // A branch outside the user's was refused above (403); here the user has no branch at all.
    if (!branch) throw new ForbiddenException('No branch assigned');
    const today = todayIn(branch.timezone);
    const can = (permission: Permission) => user.permissions.has(permission);
    const [figures, todayShipments, warehouse, trips] = await Promise.all([
      this.figures(user, {
        from: q.from ?? monthStart(q.to ?? today),
        to: q.to ?? today,
        branchId: branch.id,
      }),
      can('shipments:view') ? this.shipments.dueOn(user, branch.id, today, LISTED) : null,
      can('warehouse:view') ? this.warehouse.dashboard(user, branch.id, today) : null,
      can('transport_trips:view') ? this.trips.dashboard(user, branch.id, LISTED) : null,
    ]);
    return {
      ...figures,
      branch: { id: branch.id, code: branch.code, nameEn: branch.nameEn, nameAr: branch.nameAr },
      today,
      todayShipments,
      warehouse: warehouse && { ...warehouse, weightKg: warehouse.weightKg.toFixed() },
      trips,
    };
  }

  private async figures(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string },
  ): Promise<ManagementDashboardDto> {
    const can = (permission: Permission) => user.permissions.has(permission);
    const finance = can('financial_reports:view');
    const [shipments, financeFigures, topCustomers] = await Promise.all([
      can('shipments:view') ? this.shipments.dashboard(user, q) : null,
      finance ? this.finance(user, q) : null,
      finance ? this.billing.revenueByCustomer(user, q, TOP_CUSTOMERS) : null,
    ]);
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      shipments,
      finance: financeFigures,
      topCustomers:
        topCustomers?.map((c) => ({ ...c, revenueUsd: c.revenueUsd.toFixed() })) ?? null,
    };
  }

  /** Revenue, cost and profit per branch (income statement) and overdue receivables (AR aging). */
  private async finance(
    user: AuthUser,
    q: { from: string; to: string; branchId?: string },
  ): Promise<DashboardFinanceDto> {
    const [income, aging] = await Promise.all([
      this.ledger.incomeStatement(user, q, q.branchId),
      this.billing.arAging(user, q.to, q.branchId),
    ]);
    const column = (values: string[], i: number) => values[i] ?? '0';
    return {
      branches: income.branches.map((b, i) => ({
        ...b,
        revenueUsd: column(income.totalRevenue.byBranch, i),
        costUsd: column(income.totalExpenses.byBranch, i),
        profitUsd: column(income.netIncome.byBranch, i),
      })),
      totals: {
        revenueUsd: income.totalRevenue.total,
        costUsd: income.totalExpenses.total,
        profitUsd: income.netIncome.total,
      },
      overdueReceivablesUsd: dec(aging.totals.total).minus(dec(aging.totals.current)).toFixed(),
    };
  }

  private async branches(
    branchIds: readonly string[],
  ): Promise<(ReportBranchDto & { timezone: string })[]> {
    if (branchIds.length === 0) return [];
    return this.prisma.branch.findMany({
      where: { id: { in: [...branchIds] } },
      select: { id: true, code: true, nameEn: true, nameAr: true, timezone: true },
      orderBy: { code: 'asc' },
    });
  }
}
