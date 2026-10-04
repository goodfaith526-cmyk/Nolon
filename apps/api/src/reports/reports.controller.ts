import { Controller, Get, Query, Res, type StreamableFile } from '@nestjs/common';
import {
  LEDGER_MAX_ACCOUNTS,
  LOCALES,
  type ArAgingDto,
  type BalanceSheetDto,
  type CashMovementDto,
  type GeneralLedgerDto,
  type IncomeStatementDto,
  type InvoicesReceiptsDto,
  type OpenAccrualsDto,
  type ReportAccountOptionDto,
  type ShipmentProfitabilityDto,
} from '@nolon/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { dateString, parse } from '../common/validation.js';
import { xlsxDownload } from './excel-response.js';
import { type ReportFile, type ReportRequest, ReportsService } from './reports.service.js';

const branch = { branchId: z.uuid().optional() };
const customer = { customerId: z.uuid().optional() };

const periodBase = z.object({ from: dateString, to: dateString, ...branch });
/** A period runs from `from` to `to`, both included; from is not after to. */
const fromNotAfterTo = (q: { from: string; to: string }) => q.from <= q.to;
const afterTo = { message: 'from is after to', path: ['to'] };

const asOfQuery = z.object({ asOf: dateString, ...branch });
const agingQuery = asOfQuery.extend(customer);
const plainPeriod = periodBase.refine(fromNotAfterTo, afterTo);
const customerPeriod = periodBase.extend(customer).refine(fromNotAfterTo, afterTo);
const ledgerQuery = periodBase
  .extend({
    accountIds: z
      .string()
      .transform((v) => v.split(',').map((id) => id.trim()))
      .pipe(z.array(z.uuid()).min(1).max(LEDGER_MAX_ACCOUNTS)),
  })
  .refine(fromNotAfterTo, afterTo);
const cashQuery = periodBase
  .extend({ accountId: z.uuid().optional() })
  .refine(fromNotAfterTo, afterTo);
const exportQuery = z.object({ locale: z.enum(LOCALES).optional() });

/**
 * Financial reports (annex D section 4), each as JSON and as an Excel download (`/export`, headers
 * in `locale`, else the user's language). Shipment profitability needs its own permission; the
 * others need financial_reports:view. Branches come from the user (branch-scope.ts).
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('accounts')
  @RequirePermission('financial_reports:view')
  accounts(@CurrentUser() user: AuthUser): Promise<ReportAccountOptionDto[]> {
    return this.reports.accountOptions(user);
  }

  @Get('trial-balance/export')
  @RequirePermission('financial_reports:view')
  exportTrialBalance(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'trial-balance',
      query: parse(asOfQuery, query),
    });
  }

  @Get('income-statement')
  @RequirePermission('financial_reports:view')
  incomeStatement(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<IncomeStatementDto> {
    return this.reports.incomeStatement(user, parse(plainPeriod, query));
  }

  @Get('income-statement/export')
  @RequirePermission('financial_reports:view')
  exportIncomeStatement(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'income-statement',
      query: parse(plainPeriod, query),
    });
  }

  @Get('balance-sheet')
  @RequirePermission('financial_reports:view')
  balanceSheet(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<BalanceSheetDto> {
    return this.reports.balanceSheet(user, parse(asOfQuery, query));
  }

  @Get('balance-sheet/export')
  @RequirePermission('financial_reports:view')
  exportBalanceSheet(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'balance-sheet',
      query: parse(asOfQuery, query),
    });
  }

  @Get('general-ledger')
  @RequirePermission('financial_reports:view')
  generalLedger(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<GeneralLedgerDto> {
    return this.reports.generalLedger(user, parse(ledgerQuery, query));
  }

  @Get('general-ledger/export')
  @RequirePermission('financial_reports:view')
  exportGeneralLedger(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'general-ledger',
      query: parse(ledgerQuery, query),
    });
  }

  @Get('ar-aging')
  @RequirePermission('financial_reports:view')
  arAging(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<ArAgingDto> {
    return this.reports.arAging(user, parse(agingQuery, query));
  }

  @Get('ar-aging/export')
  @RequirePermission('financial_reports:view')
  exportArAging(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'ar-aging',
      query: parse(agingQuery, query),
    });
  }

  @Get('shipment-profitability')
  @RequirePermission('shipment_profitability:view')
  shipmentProfitability(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<ShipmentProfitabilityDto> {
    return this.reports.shipmentProfitability(user, parse(customerPeriod, query));
  }

  @Get('shipment-profitability/export')
  @RequirePermission('shipment_profitability:view')
  exportShipmentProfitability(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'shipment-profitability',
      query: parse(customerPeriod, query),
    });
  }

  @Get('invoices-receipts')
  @RequirePermission('financial_reports:view')
  invoicesReceipts(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<InvoicesReceiptsDto> {
    return this.reports.invoicesReceipts(user, parse(customerPeriod, query));
  }

  @Get('invoices-receipts/export')
  @RequirePermission('financial_reports:view')
  exportInvoicesReceipts(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'invoices-receipts',
      query: parse(customerPeriod, query),
    });
  }

  @Get('cash-movement')
  @RequirePermission('financial_reports:view')
  cashMovement(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<CashMovementDto> {
    return this.reports.cashMovement(user, parse(cashQuery, query));
  }

  @Get('cash-movement/export')
  @RequirePermission('financial_reports:view')
  exportCashMovement(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'cash-movement',
      query: parse(cashQuery, query),
    });
  }

  @Get('open-accruals')
  @RequirePermission('financial_reports:view')
  openAccruals(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<OpenAccrualsDto> {
    return this.reports.openAccruals(user, parse(asOfQuery, query));
  }

  @Get('open-accruals/export')
  @RequirePermission('financial_reports:view')
  exportOpenAccruals(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'open-accruals',
      query: parse(asOfQuery, query),
    });
  }

  private async download(
    user: AuthUser,
    query: unknown,
    res: Response,
    request: ReportRequest,
  ): Promise<StreamableFile> {
    const { locale } = parse(exportQuery, query);
    const file: ReportFile = await this.reports.export(user, request, locale);
    return xlsxDownload(res, file);
  }
}
