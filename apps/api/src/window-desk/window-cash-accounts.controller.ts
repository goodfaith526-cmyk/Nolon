import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import type { WindowCashAccountDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { currencyCode, parse } from '../common/validation.js';
import { WindowCashAccountsService } from './window-cash-accounts.service.js';

const setBody = z.object({ accountId: z.uuid() }).strict();

/**
 * Plan 13 section 4: a window's cash accounts, one per currency, kept by the accountant on the
 * warehouses screen (chart of accounts rights in the window's branch).
 */
@Controller('warehouses/:id/cash-accounts')
export class WindowCashAccountsController {
  constructor(private readonly cashAccounts: WindowCashAccountsService) {}

  @Get()
  @RequirePermission('chart_of_accounts:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WindowCashAccountDto[]> {
    return this.cashAccounts.list(user, id);
  }

  @Put(':currency')
  @RequirePermission('chart_of_accounts:update')
  set(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('currency') currency: string,
    @Body() body: unknown,
  ): Promise<WindowCashAccountDto[]> {
    const { accountId } = parse(setBody, body);
    return this.cashAccounts.set(user, id, parse(currencyCode, currency), accountId);
  }

  @Delete(':currency')
  @RequirePermission('chart_of_accounts:update')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('currency') currency: string,
  ): Promise<WindowCashAccountDto[]> {
    return this.cashAccounts.remove(user, id, parse(currencyCode, currency));
  }
}
