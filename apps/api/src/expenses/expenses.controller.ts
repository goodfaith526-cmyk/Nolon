import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  EXPENSE_STATUSES,
  type ExpenseDto,
  type ExpenseSummaryDto,
  type Page,
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
import { ExpensesService } from './expenses.service.js';

const categoryCode = z.string().trim().toUpperCase().min(1).max(20);
const expenseFields = {
  expenseDate: dateString,
  categoryCode,
  description: requiredText(200),
  currency: currencyCode,
  fxRate: fxRate.nullish(),
  amount,
  cashAccountId: z.uuid(),
  reference: optionalText(100),
};
const createBody = z.object({ requestId: z.uuid(), branchId: z.uuid(), ...expenseFields }).strict();
const updateBody = z.object(expenseFields).strict();
const listQuery = pageQuery.extend({
  status: z.enum(EXPENSE_STATUSES).optional(),
  categoryCode: categoryCode.optional(),
});
const reasonBody = z.object({ reason: requiredText(1000) }).strict();

/** General expenses paid from cash or bank (annex C rule 12). */
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermission('expenses:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<ExpenseSummaryDto>> {
    return this.expenses.list(user, parse(listQuery, query));
  }

  @Get(':id')
  @RequirePermission('expenses:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<ExpenseDto> {
    return this.expenses.get(user, id);
  }

  @Post()
  @RequirePermission('expenses:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<ExpenseDto> {
    return this.expenses.create(user, parse(createBody, body));
  }

  @Patch(':id')
  @RequirePermission('expenses:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ExpenseDto> {
    return this.expenses.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('expenses:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExpenseDto> {
    return this.expenses.approve(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('expenses:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ExpenseDto> {
    return this.expenses.cancel(user, id, parse(reasonBody, body).reason);
  }
}
