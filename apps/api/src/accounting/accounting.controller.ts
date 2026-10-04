import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ACCOUNT_TYPES,
  JOURNAL_SOURCES,
  JOURNAL_STATUSES,
  POSTING_ROLES,
  type AccountDto,
  type AccountingSettingsDto,
  type FiscalPeriodDto,
  type FxRateDto,
  type FxRateLookupDto,
  type JournalEntryDto,
  type JournalEntrySummaryDto,
  type Page,
  type TrialBalanceDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import {
  amount,
  currencyCode,
  dateString,
  fxRate,
  optionalText,
  pageQuery,
  parse,
  requiredText,
} from '../common/validation.js';
import { AccountsService } from './accounts.service.js';
import { FxRatesService } from './fx-rates.service.js';
import { JournalService } from './journal.service.js';
import { ManualJournalsService } from './manual-journals.service.js';
import { PeriodsService } from './periods.service.js';
import { TrialBalanceService } from './trial-balance.service.js';

const accountBody = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9A-Z][0-9A-Z.-]{0,19}$/),
    nameEn: requiredText(200),
    nameAr: requiredText(200),
    type: z.enum(ACCOUNT_TYPES),
    parentId: z.uuid().nullish(),
    isPostable: z.boolean(),
    isCash: z.boolean().optional(),
    currency: currencyCode.nullish(),
    branchId: z.uuid().nullish(),
    isActive: z.boolean().optional(),
  })
  .strict();
const mappingBody = z.object({ accountId: z.uuid() }).strict();
const chargeTypePostingBody = z
  .object({ revenueAccountId: z.uuid().nullable(), isReimbursable: z.boolean() })
  .strict();
const fxRateBody = z
  .object({ currency: currencyCode, rateDate: dateString, rate: fxRate })
  .strict();
const fxListQuery = z.object({
  currency: currencyCode.optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});
const fxLookupQuery = z.object({ currency: currencyCode, date: dateString });

const journalLine = z
  .object({
    accountId: z.uuid(),
    currency: currencyCode,
    fxRate: fxRate.nullish(),
    debit: amount.optional(),
    credit: amount.optional(),
    description: optionalText(500),
  })
  .strict();
const journalFields = {
  entryDate: dateString,
  description: requiredText(1000),
  lines: z.array(journalLine).min(2).max(200),
};
const createJournalBody = z.object({ branchId: z.uuid(), ...journalFields }).strict();
const updateJournalBody = z.object(journalFields).strict();
const reverseBody = z
  .object({ entryDate: dateString.optional(), reason: requiredText(1000) })
  .strict();
const journalListQuery = pageQuery.extend({
  status: z.enum(JOURNAL_STATUSES).optional(),
  source: z.enum(JOURNAL_SOURCES).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});
const trialBalanceQuery = z.object({ asOf: dateString, branchId: z.uuid().optional() });

@Controller('accounting')
export class AccountingController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly fxRates: FxRatesService,
    private readonly periods: PeriodsService,
    private readonly journal: JournalService,
    private readonly manual: ManualJournalsService,
    private readonly trialBalance: TrialBalanceService,
  ) {}

  @Get('accounts')
  @RequirePermission('chart_of_accounts:view')
  listAccounts(): Promise<AccountDto[]> {
    return this.accounts.list();
  }

  @Post('accounts')
  @RequirePermission('chart_of_accounts:create')
  createAccount(@Body() body: unknown): Promise<AccountDto> {
    return this.accounts.create(parse(accountBody, body));
  }

  @Patch('accounts/:id')
  @RequirePermission('chart_of_accounts:update')
  updateAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AccountDto> {
    return this.accounts.update(id, parse(accountBody, body));
  }

  @Get('settings')
  @RequirePermission('chart_of_accounts:view')
  settings(): Promise<AccountingSettingsDto> {
    return this.accounts.settings();
  }

  @Put('settings/mappings/:role')
  @RequirePermission('chart_of_accounts:update')
  setMapping(@Param('role') role: string, @Body() body: unknown): Promise<AccountingSettingsDto> {
    const parsedRole = parse(z.enum(POSTING_ROLES), role);
    return this.accounts.setMapping(parsedRole, parse(mappingBody, body).accountId);
  }

  @Put('settings/charge-types/:code')
  @RequirePermission('chart_of_accounts:update')
  setChargeTypePosting(
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<AccountingSettingsDto> {
    const input = parse(chargeTypePostingBody, body);
    return this.accounts.setChargeTypePosting({ chargeTypeCode: code.toUpperCase(), ...input });
  }

  @Get('fx-rates')
  @RequirePermission('fx_rates:view')
  listFxRates(@Query() query: unknown): Promise<FxRateDto[]> {
    return this.fxRates.list(parse(fxListQuery, query));
  }

  @Get('fx-rates/lookup')
  @RequirePermission('fx_rates:view')
  async lookupFxRate(@Query() query: unknown): Promise<FxRateLookupDto> {
    const { currency, date } = parse(fxLookupQuery, query);
    const found = await this.fxRates.lookup(currency, date);
    if (!found)
      throw new NotFoundException(`No exchange rate for ${currency} on or before ${date}`);
    return found;
  }

  @Put('fx-rates')
  @RequirePermission('fx_rates:create')
  upsertFxRate(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<FxRateDto> {
    return this.fxRates.upsert(user.id, parse(fxRateBody, body));
  }

  @Get('periods')
  @RequirePermission('chart_of_accounts:view')
  listPeriods(): Promise<FiscalPeriodDto[]> {
    return this.periods.list();
  }

  @Post('periods/:id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('chart_of_accounts:approve')
  closePeriod(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalPeriodDto> {
    return this.periods.close(user.id, id);
  }

  @Get('journals')
  @RequirePermission('manual_journals:view')
  listJournals(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<Page<JournalEntrySummaryDto>> {
    return this.journal.list(user, parse(journalListQuery, query));
  }

  @Get('journals/:id')
  @RequirePermission('manual_journals:view')
  getJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JournalEntryDto> {
    return this.journal.get(user, id);
  }

  @Post('journals')
  @RequirePermission('manual_journals:create')
  createJournal(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<JournalEntryDto> {
    return this.manual.create(user, parse(createJournalBody, body));
  }

  @Patch('journals/:id')
  @RequirePermission('manual_journals:update')
  updateJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<JournalEntryDto> {
    return this.manual.update(user, id, parse(updateJournalBody, body));
  }

  @Delete('journals/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('manual_journals:update')
  deleteJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.manual.remove(user, id);
  }

  @Post('journals/:id/post')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('manual_journals:approve')
  postJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JournalEntryDto> {
    return this.manual.post(user, id);
  }

  @Post('journals/:id/reverse')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('manual_journals:cancel')
  reverseJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<JournalEntryDto> {
    return this.manual.reverse(user, id, parse(reverseBody, body));
  }

  @Get('trial-balance')
  @RequirePermission('financial_reports:view')
  getTrialBalance(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<TrialBalanceDto> {
    const { asOf, branchId } = parse(trialBalanceQuery, query);
    return this.trialBalance.get(user, asOf, branchId);
  }
}
