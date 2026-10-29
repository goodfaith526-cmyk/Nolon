import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  isLocale,
  type ApAgingDto,
  type ArAgingDto,
  type BalanceSheetDto,
  type ExpectedGapDto,
  type CashMovementDto,
  type GeneralLedgerDto,
  type IncomeStatementDto,
  type InvoicesReceiptsDto,
  type Locale,
  type OpenAccrualsDto,
  type ReportAccountOptionDto,
  type ProfitCategoryDto,
  type ShipmentProfitabilityDto,
  type ShipmentExpectedDto,
  type ShipmentProfitViewDto,
  type TrialBalanceDto,
} from '@nolon/shared';
import { LedgerReportsService } from '../accounting/ledger-reports.service.js';
import { sum } from '../accounting/report-math.js';
import { TrialBalanceService } from '../accounting/trial-balance.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { BillingReportsService } from '../billing/billing-reports.service.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { type Decimal, dec } from '../common/money.js';
import { CustomersService } from '../customers/customers.service.js';
import { PayablesReportsService } from '../payables/payables-reports.service.js';
import { SuppliersService } from '../payables/suppliers.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RateCostsService } from '../rates/rate-costs.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { TripsService } from '../transport/trips.service.js';
import { withAdvances } from './ar-aging.js';
import { buildWorkbook } from './excel.js';
import {
  byCategory,
  byCustomer,
  byOriginCountry,
  byOutlet,
  byRoute,
  cycleTime,
  daysBetween,
  incompleteReasons,
  marginPerUnit,
  missingCosts,
  tripService,
  NO_AMOUNTS,
  profitFigures,
  type ShipmentAmounts,
  shipmentCategory,
  showDays,
  totalOf,
} from './profitability.js';
import { unitQuantity } from '../billing/invoice-suggestion.js';
import {
  type ExportContext,
  apAgingSheets,
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
  | { report: 'open-accruals'; query: AsOfQuery }
  | { report: 'ap-aging'; query: AsOfQuery & { supplierId?: string } };

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
    private readonly payables: PayablesReportsService,
    private readonly suppliers: SuppliersService,
    private readonly invoices: InvoicesService,
    private readonly rateCosts: RateCostsService,
  ) {}

  accountOptions(user: AuthUser): Promise<ReportAccountOptionDto[]> {
    return this.ledger.accountOptions(user);
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

  /** Open invoices by age (billing) with each customer's unapplied advances (ledger). */
  async arAging(user: AuthUser, q: AsOfQuery & { customerId?: string }): Promise<ArAgingDto> {
    const [aging, advances] = await Promise.all([
      this.billing.arAging(user, q.asOf, q.branchId, q.customerId),
      this.ledger.customerAdvances(user, q.asOf, q.branchId, q.customerId),
    ]);
    return withAdvances(aging, advances);
  }

  /** Open approved supplier bills by age (payables). */
  apAging(user: AuthUser, q: AsOfQuery & { supplierId?: string }): Promise<ApAgingDto> {
    return this.payables.apAging(user, q.asOf, q.branchId, q.supplierId);
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
   * One shipment's finance tab (plan 6.2), two figures side by side and never mixed: the actual,
   * as the profitability report gives it over every posted line to date; and the expected, from
   * the rate cards it is priced from (InvoicesService.pricedFrom, RateCostsService.
   * shipmentMargins), for a user who may see the cards' costs in the shipment's branch. 404
   * unless the shipment belongs to one of the user's branches.
   */
  async shipmentProfit(user: AuthUser, shipmentId: string): Promise<ShipmentProfitViewDto> {
    const shipment = await this.shipments.billingSource(user, shipmentId);
    const report = await this.shipmentProfitability(user, {
      from: '1900-01-01',
      to: '9999-12-31',
      branchId: shipment.branchId,
      shipmentId,
    });
    const actual = report.shipments.find((s) => s.shipmentId === shipmentId) ?? null;
    if (shipment.status === 'CANCELLED' || !user.access.has('rate_costs:view', shipment.branchId)) {
      return { shipmentId, actual, expected: null };
    }
    const priced = await this.invoices.pricedFrom(user, shipmentId);
    const gaps: ExpectedGapDto[] = [];
    const lines: { chargeTypeCode: string; rateCardId: string; quantity: Decimal }[] = [];
    for (const l of priced.lines) {
      if (l.rateCardId === null) gaps.push({ chargeTypeCode: l.chargeTypeCode, reason: 'NO_CARD' });
      else if (l.quantity === null) {
        gaps.push({ chargeTypeCode: l.chargeTypeCode, reason: 'QUANTITY_UNKNOWN' });
      } else {
        lines.push({
          chargeTypeCode: l.chargeTypeCode,
          rateCardId: l.rateCardId,
          quantity: l.quantity,
        });
      }
    }
    const margins = await this.rateCosts.shipmentMargins(user, lines, shipment.salesOutletId);
    const cards: ShipmentExpectedDto['cards'] = [];
    margins.forEach((m, i) => {
      const chargeTypeCode = lines[i]?.chargeTypeCode ?? '';
      if (m === null) gaps.push({ chargeTypeCode, reason: 'COSTS_HIDDEN' });
      else cards.push({ ...m, chargeTypeCode });
    });
    const currencies = new Set(cards.map((c) => c.currency));
    const [currency] = currencies.size === 1 ? [...currencies] : [null];
    const complete =
      currency !== null &&
      gaps.length === 0 &&
      cards.length > 0 &&
      cards.every((c) => c.expectedMargin !== null);
    return {
      shipmentId,
      actual,
      expected: {
        source: priced.source,
        cards,
        gaps,
        currency: currency ?? null,
        expectedMargin: complete
          ? cards.reduce((sum, c) => sum.plus(c.expectedMargin ?? 0), dec(0)).toFixed()
          : null,
      },
    };
  }

  /**
   * Revenue, cost and margin per shipment from the journal lines that carry it, then per customer,
   * route, sales outlet, origin country and price category (business model plan 6.3), each
   * shipment whole in one group. A shipment whose figures are not final yet (plan 6.2) is marked
   * and every group counts its marked shipments. Routes carry the cycle time of their delivered
   * shipments. Only shipments the user may see count (and, when asked, of one customer).
   */
  async shipmentProfitability(
    user: AuthUser,
    q: PeriodQuery & { customerId?: string; shipmentId?: string },
  ): Promise<ShipmentProfitabilityDto> {
    const results = await this.ledger.shipmentResults(user, q, q.branchId, q.shipmentId);
    const amounts = new Map(results.map((r) => [r.shipmentId, r]));
    const summaries = await this.shipments.reportSummaries(
      user,
      results.map((r) => r.shipmentId),
      q.customerId,
    );
    const details = new Map(
      (
        await this.shipments.profitDetails(
          user,
          summaries.map((s) => s.id),
        )
      ).map((d) => [d.id, d]),
    );
    const detailIds = [...details.keys()];
    const [open, coverage, tripCosts] = await Promise.all([
      this.ledger.tripsWithOpenAccrual(
        [...new Set([...details.values()].flatMap((d) => d.tripIds))],
        q.to,
      ),
      this.payables.costCoverage(detailIds, q.to),
      this.ledger.tripCostLegs(detailIds, q.to),
    ]);
    const shipments = summaries.flatMap((s) => {
      const d = details.get(s.id);
      if (!d) return [];
      const money = amounts.get(s.id) ?? NO_AMOUNTS;
      const category = shipmentCategory(d.lines);
      const unit = category.kind === 'SINGLE' ? (d.lines[0]?.category?.unit ?? null) : null;
      const legs = [
        ...coverage.flatMap((c) =>
          c.shipmentId === s.id && c.legFrom && c.legTo ? [{ from: c.legFrom, to: c.legTo }] : [],
        ),
        ...tripCosts.flatMap((c) =>
          c.shipmentId === s.id ? [{ from: c.legFrom, to: c.legTo }] : [],
        ),
      ];
      const missing = missingCosts(d.services, [
        ...coverage.flatMap((c) => (c.shipmentId === s.id ? [c.service] : [])),
        ...legs.map((leg) => tripService(d.mode, d.route, leg)),
      ]);
      const row: ShipmentAmounts & { id: string; number: string; branchCode: string } = {
        ...s,
        ...money,
        salesOutlet: d.salesOutlet,
        originCountry: d.originCountry,
        category,
        unit,
        // Only where the unit is exact on this cargo (a count unit counts its own cargo lines).
        units: unit ? unitQuantity(unit, d.lines, null, d.cargoType) : null,
        missingCosts: missing,
        incompleteReasons: incompleteReasons({
          missingCosts: missing,
          openAccrual: d.tripIds.some((id) => open.has(id)),
          status: d.status,
        }),
        cycleDays:
          d.receivedAt && d.deliveredAt && d.deliveredAt >= d.receivedAt
            ? daysBetween(d.receivedAt, d.deliveredAt)
            : null,
      };
      return [row];
    });
    const name = (a: string, b: string) => a.localeCompare(b);
    const group = (g: { shipments: number; incompleteShipments: number }) => ({
      shipments: g.shipments,
      incompleteShipments: g.incompleteShipments,
    });
    const total = totalOf(shipments);
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
        salesOutlet: s.salesOutlet,
        originCountry: s.originCountry,
        category: s.category,
        incompleteReasons: [...s.incompleteReasons],
        missingCosts: [...s.missingCosts],
        cycleDays: showDays(s.cycleDays),
        ...profitFigures(s),
      })),
      customers: byCustomer(shipments)
        .map((g) => ({ ...g.key, ...group(g), ...profitFigures(g) }))
        .sort((a, b) => name(a.customerName, b.customerName)),
      routes: byRoute(shipments)
        .map((g) => ({
          ...g.key,
          ...group(g),
          ...profitFigures(g),
          cycle: cycleTime(
            shipments
              .filter(
                (s) => s.origin.id === g.key.origin.id && s.destination.id === g.key.destination.id,
              )
              .map((s) => s.cycleDays),
          ),
        }))
        .sort((a, b) =>
          name(`${a.origin.code}>${a.destination.code}`, `${b.origin.code}>${b.destination.code}`),
        ),
      outlets: byOutlet(shipments)
        .map((g) => ({ ...g.key, ...group(g), ...profitFigures(g) }))
        // Named outlets by name, then the shipments without one.
        .sort((a, b) =>
          a.salesOutlet && b.salesOutlet
            ? name(a.salesOutlet.name, b.salesOutlet.name)
            : a.salesOutlet
              ? -1
              : b.salesOutlet
                ? 1
                : 0,
        ),
      countries: byOriginCountry(shipments)
        .map((g) => ({ ...g.key, ...group(g), ...profitFigures(g) }))
        .sort((a, b) => name(a.originCountry.code, b.originCountry.code)),
      categories: byCategory(shipments)
        .map((g) => ({
          category: g.key.category,
          unit: g.key.unit,
          units: g.units?.toFixed() ?? null,
          marginPerUnitUsd: marginPerUnit(g, g.units),
          ...group(g),
          ...profitFigures(g),
        }))
        .sort(
          (a, b) =>
            categoryOrder(a.category) - categoryOrder(b.category) ||
            name(
              a.category.kind === 'SINGLE' ? a.category.code : '',
              b.category.kind === 'SINGLE' ? b.category.code : '',
            ),
        ),
      totals: { ...group(total), ...profitFigures(total) },
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
    const info = new Map(
      (
        await this.trips.accrualSummaries(
          user,
          accrued.trips.map((a) => a.tripId),
        )
      ).map((t) => [t.id, t]),
    );
    const trips = accrued.trips.flatMap((a) => {
      const trip = info.get(a.tripId);
      return trip ? [{ accrual: a, trip }] : [];
    });
    const tripsTotal = sum(trips.map((x) => x.accrual.balanceUsd));
    // A trip the user cannot open (none, as lines follow the trip's branch) counts as "other".
    const accruedTotal = sum(accrued.trips.map((a) => a.balanceUsd)).plus(accrued.otherUsd);
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
      otherAccruedUsd: accruedTotal.minus(tripsTotal).toFixed(),
      accruedTotalUsd: accruedTotal.toFixed(),
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
      case 'ap-aging':
        return apAgingSheets(
          ctx,
          await this.apAging(user, request.query),
          await this.supplierName(request.query.supplierId),
        );
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

  /** The filtered supplier's name (suppliers are shared by every branch), or null. */
  private async supplierName(supplierId?: string): Promise<string | null> {
    if (!supplierId) return null;
    try {
      return (await this.suppliers.requireSupplier(supplierId)).name;
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
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

/** Single categories first (by code), then mixed, then unspecified. */
function categoryOrder(category: ProfitCategoryDto): number {
  return category.kind === 'SINGLE' ? 0 : category.kind === 'MIXED' ? 1 : 2;
}
