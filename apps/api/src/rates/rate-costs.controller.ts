import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import {
  RATE_COST_COMPONENTS,
  RATE_UNITS,
  type ExpectedMarginDto,
  type RateCardCostDto,
  type RateCardCostInput,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { amount, currencyCode, optionalText, parse, quantity } from '../common/validation.js';
import { RateCostsService } from './rate-costs.service.js';

const costBody: z.ZodType<RateCardCostInput> = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ENTERED'),
      amount,
      currency: currencyCode,
      unit: z.enum(RATE_UNITS),
      // Strictly positive: how many of the card's units one cost unit holds.
      unitsPerCostUnit: quantity.nullish(),
      note: optionalText(500),
    })
    .strict(),
  z.object({ status: z.literal('NOT_APPLICABLE'), note: optionalText(500) }).strict(),
]);

const marginQuery = z
  .object({ outletId: z.uuid().optional(), quantity: quantity.optional() })
  .strict();

const componentParam = z.enum(RATE_COST_COMPONENTS);

/**
 * A rate card's reference costs and expected margin (business model plan 6.1), apart from the card
 * (rate_costs). Not readable by the staff AI assistant, and closed to Outlet Staff.
 */
@Controller('rates/:id')
export class RateCostsController {
  constructor(private readonly costs: RateCostsService) {}

  @Get('costs')
  @RequirePermission('rate_costs:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RateCardCostDto[]> {
    return this.costs.list(user, id);
  }

  @Put('costs/:component')
  @RequirePermission('rate_costs:update')
  put(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('component') component: string,
    @Body() body: unknown,
  ): Promise<RateCardCostDto[]> {
    return this.costs.put(user, id, parse(componentParam, component), parse(costBody, body));
  }

  @Get('expected-margin')
  @RequirePermission('rate_costs:view')
  margin(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<ExpectedMarginDto> {
    return this.costs.margin(user, id, parse(marginQuery, query));
  }
}
