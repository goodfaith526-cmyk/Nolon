import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  isLocale,
  type ArAgingDto,
  type BalanceSheetDto,
  type CashMovementDto,
  type GeneralLedgerDto,
  type IncomeStatementDto,
  type InvoicesReceiptsDto,
  type Locale,
  type OpenAccrualsDto,
  type ReportAccountOptionDto,
  type ShipmentProfitabilityDto,
  type TrialBalanceDto,
} from '@nolon/shared';
import { LedgerReportsService } from '../accounting/ledger-reports.service.js';
import { sum } from '../accounting/report-math.js';
import { TrialBalanceService } from '../accounting/trial-balance.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { BillingReportsService } from '../billing/billing-reports.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { TripsService } from '../transport/trips.service.js';
import { buildWorkbook } from './excel.js';
import { addAmounts, byCustomer, byRoute, NO_AMOUNTS, profitFigures } from './profitability.js';
import {
  type ExportContext,
  arAgingSheets,
  balanceSheetSheets,
  cashMovementSheets,
  generalLedgerSheets,
  incomeStatementSheets,
  invoicesReceiptsSheets,
  openAccrualsSheets,
  profitabilitySheets,
  trialBalanceSheets,
} from './report-sheets.js';

export interface PeriodQuery {
  from: string;
  to: string;
  branchId?: string;
}

export interface AsOfQuery {
  asOf: string;
  branchId?: string;
}

export type ReportRequest =
  | { report: 'trial-balance'; query: AsOfQuery }
  | { report: 'income-statement'; query: PeriodQuery }
  | { report: 'balance-sheet'; query: AsOfQuery }
  | { report: 'general-ledger'; query: PeriodQuery & { accountIds: string[] } }
  | { report: 'ar-aging'; query: AsOfQuery & { customerId?: string } }
  | { report: 'shipment-profitability'; query: PeriodQuery & { customerId?: string } }
  | { report: 'invoices-receipts'; query: PeriodQuery & { customerId?: string } }
  | { report: 'cash-movement'; query: PeriodQuery & { accountId?: string } }
  | { report: 'open-accruals'; query: AsOfQuery };

export interface ReportFile {
  fileName: string;
  data: Buffer;
}

/**
 * The financial reports (annex D section 4) and their Excel exports. Each figure comes from the
 * module that owns it (the ledger from accounting, invoices and receipts from billing, shipments
 * and trips from their modules), each scoped to the user's branches; this service puts them
 * together and writes the workbook.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerReportsService,
    private readonly trialBalances: TrialBalanceService,
    private readonly billing: BillingReportsService,
    private readonly customers: CustomersService,
    private readonly shipments: ShipmentsService,
    private readonly trips: TripsService,
  ) {}

  accountOptions(): Promise<ReportAccountOptionDto[]> {
    return this.ledger.accountOptions();
  }

  trialBalance(user: AuthUser, q: AsOfQuery): Promise<TrialBalanceDto> {
    return this.trialBalances.get(user, q.asOf, q.branchId);
  }

  incomeStatement(user: AuthUser, q: PeriodQuery): Promise<IncomeStatementDto> {
    return this.ledger.incomeStatement(user, q, q.branchId);
  }

  balanceSheet(user: AuthUser, q: AsOfQuery): Promise<BalanceSheetDto> {
    return this.ledger.balanceSheet(user, q.asOf, q.branchId);
  }

  generalLedger(
    user: AuthUser,
    q: PeriodQuery & { accountIds: string[] },
  ): Promise<GeneralLedgerDto> {
    return this.ledger.generalLedger(user, q, q.accountIds, q.branchId);
  }

  arAging(user: AuthUser, q: AsOfQuery & { customerId?: string }): Promise<ArAgingDto> {
    return this.billing.arAging(user, q.asOf, q.branchId, q.customerId);
  }

  invoicesReceipts(
    user: AuthUser,
    q: PeriodQuery & { customerId?: string },
  ): Promise<InvoicesReceiptsDto> {
    return this.billing.invoicesAndReceipts(user, q.from, q.to, q.branchId, q.customerId);
  }

  cashMovement(user: AuthUser, q: PeriodQuery & { accountId?: string }): Promise<CashMovementDto> {
    return this.ledger.cashMovement(user, q, q.branchId, q.accountId);
  }

  /**
   * Revenue, cost and margin per shipment from the journal lines that carry it, then per customer
   * and per route. Only shipments the user may see count (and, when asked, of one customer).
   */
  async shipmentProfitability(
    user: AuthUser,
    q: PeriodQuery & { customerId?: string },
  ): Promise<ShipmentProfitabilityDto> {
    const results = await this.ledger.shipmentResults(user, q, q.branchId);
    const amounts = new Map(results.map((r) => [r.shipmentId, r]));
    const summaries = await this.shipments.reportSummaries(
      user,
      results.map((r) => r.shipmentId),
      q.customerId,
    );
    const shipments = summaries.map((s) => ({ ...s, ...(amounts.get(s.id) ?? NO_AMOUNTS) }));
    const totals = shipments.reduce(addAmounts, NO_AMOUNTS);
    const name = (a: string, b: string) => a.localeCompare(b);
    return {
      from: q.from,
      to: q.to,
      branchId: q.branchId ?? null,
      customerId: q.customerId ?? null,
      shipments: shipments.map((s) => ({
        shipmentId: s.id,
        number: s.number,
        branchCode: s.branchCode,
        customerId: s.customerId,
        customerName: s.customerName,
        origin: s.origin,
        destination: s.destination,
        ...profitFigures(s),
      })),
      customers: byCustomer(shipments)
        .map((g) => ({ ...g.key, shipments: g.shipments, ...profitFigures(g) }))
        .sort((a, b) => name(a.customerName, b.customerName)),
      routes: byRoute(shipments)
        .map((g) => ({ ...g.key, shipments: g.shipments, ...profitFigures(g) }))
        .sort((a, b) =>
          name(`${a.origin.code}>${a.destination.code}`, `${b.origin.code}>${b.destination.code}`),
        ),
      totals: profitFigures(totals),
    };
  }

  /**
   * Rule 11 accruals still open (completed external trips whose carrier bill has not cleared
   * them), and the consolidated container clearing balance.
   */
  async openAccruals(user: AuthUser, q: AsOfQuery): Promise<OpenAccrualsDto> {
    const [accrued, clearing] = await Promise.all([
      this.ledger.openTripAccruals(user, q.asOf, q.branchId),
      this.ledger.roleBalance(user, 'CONSOLIDATION_CLEARING', q.asOf, q.branchId),
    ]);
    const tripIds = accrued.trips.flatMap((a) => (a.tripId ? [a.tripId] : []));
    const info = new Map((await this.trips.accrualSummaries(user, tripIds)).map((t) => [t.id, t]));
    const trips = accrued.trips.flatMap((a) => {
      const trip = a.tripId ? info.get(a.tripId) : undefined;
      return trip ? [{ accrual: a, trip }] : [];
    });
    const tripsTotal = sum(trips.map((x) => x.accrual.balanceUsd));
    return {
      asOf: q.asOf,
      branchId: q.branchId ?? null,
      accruedAccount: accrued.account,
      trips: trips
        .sort((a, b) => a.trip.number.localeCompare(b.trip.number))
        .map(({ accrual, trip }) => ({
          tripId: trip.id,
          tripNumber: trip.number,
          branchCode: trip.branchCode,
          carrierName: trip.carrierName,
          completedAt: trip.completedOn,
          currency: accrual.currency,
          balance: accrual.balance.toFixed(),
          balanceUsd: accrual.balanceUsd.toFixed(),
        })),
      tripsTotalUsd: tripsTotal.toFixed(),
      otherAccruedUsd: accrued.totalUsd.minus(tripsTotal).toFixed(),
      accruedTotalUsd: accrued.totalUsd.toFixed(),
      clearingAccount: clearing.account,
      clearingBalanceUsd: clearing.balanceUsd.toFixed(),
    };
  }

  /** The report as an Excel workbook, with headers in `locale`. */
  async export(user: AuthUser, request: ReportRequest, locale?: Locale): Promise<ReportFile> {
    const ctx: ExportContext = {
      locale: locale ?? (isLocale(user.preferredLocale) ? user.preferredLocale : DEFAULT_LOCALE),
      branchCode: await this.branchCode(user, request),
    };
    const spec = await this.workbookSpec(user, request, ctx);
    return {
      fileName: `${request.report}-${fileDates(request)}.xlsx`,
      data: await buildWorkbook(spec),
    };
  }

  private async workbookSpec(user: AuthUser, request: ReportRequest, ctx: ExportContext) {
    switch (request.report) {
      case 'trial-balance':
        return trialBalanceSheets(ctx, await this.trialBalance(user, request.query));
      case 'income-statement':
        return incomeStatementSheets(ctx, await this.incomeStatement(user, request.query));
      case 'balance-sheet':
        return balanceSheetSheets(ctx, await this.balanceSheet(user, request.query));
      case 'general-ledger':
        return generalLedgerSheets(ctx, await this.generalLedger(user, request.query));
      case 'ar-aging':
        return arAgingSheets(
          ctx,
          await this.arAging(user, request.query),
          await this.customerName(user, request.query.customerId),
        );
      case 'shipment-profitability':
        return profitabilitySheets(
          ctx,
          await this.shipmentProfitability(user, request.query),
          await this.customerName(user, request.query.customerId),
        );
      case 'invoices-receipts':
        return invoicesReceiptsSheets(
          ctx,
          await this.invoicesReceipts(user, request.query),
          await this.customerName(user, request.query.customerId),
        );
      case 'cash-movement':
        return cashMovementSheets(ctx, await this.cashMovement(user, request.query));
      case 'open-accruals':
        return openAccrualsSheets(ctx, await this.openAccruals(user, request.query));
    }
  }

  /** The requested branch's code (403 outside the user's branches), or null for all of them. */
  private async branchCode(user: AuthUser, request: ReportRequest): Promise<string | null> {
    const { branchId } = request.query;
    if (!branchId) return null;
    reportBranchIds(user, branchId);
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { code: true },
    });
    return branch?.code ?? null;
  }

  /** The filtered customer's name, through the customers module (404 outside the user's branches). */
  private async customerName(user: AuthUser, customerId?: string): Promise<string | null> {
    if (!customerId) return null;
    try {
      return (await this.customers.get(user, customerId)).name;
    } catch (error) {
      // A customer of another branch filters to nothing; the export just does not name it.
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}

function fileDates(request: ReportRequest): string {
  const q = request.query;
  return 'asOf' in q ? q.asOf : `${q.from}_${q.to}`;
}
