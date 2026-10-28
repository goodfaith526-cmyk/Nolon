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
import { RATE_STATUSES, SHIPPING_MODES, type Page, type RateCardDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser, OutletScoped, RequirePermission } from '../auth/decorators.js';
import { dateString, pageQuery, parse } from '../common/validation.js';
import { flag } from '../common/list-filters.js';
import { createRateBody, updateRateBody } from './rate-schemas.js';
import { RatesService } from './rates.service.js';

const listQuery = pageQuery.extend({
  status: z.enum(RATE_STATUSES).optional(),
  originLocationId: z.uuid().optional(),
  destinationLocationId: z.uuid().optional(),
  mode: z.enum(SHIPPING_MODES).optional(),
  /** Valid on this date: valid from on or before it, valid to (if any) on or after it. */
  validOn: dateString.optional(),
  branchId: z.uuid().optional(),
  /**
   * With an origin or destination: the cards that price it, each end the place itself, its city
   * or its country (plan 5.3), as a quotation line may choose them. Without it, a city finds its
   * places (as before).
   */
  covering: flag,
});

@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @OutletScoped()
  @AgentReadable()
  @Get()
  @RequirePermission('rates:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<RateCardDto>> {
    return this.rates.list({ ...parse(listQuery, query), generalOnly: user.agent !== undefined });
  }

  @OutletScoped()
  @AgentReadable()
  @Get(':id')
  @RequirePermission('rates:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<RateCardDto> {
    return this.rates.get(id, { generalOnly: user.agent !== undefined });
  }

  @Post()
  @RequirePermission('rates:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<RateCardDto> {
    return this.rates.create(user, parse(createRateBody, body));
  }

  @Patch(':id')
  @RequirePermission('rates:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<RateCardDto> {
    return this.rates.update(user, id, parse(updateRateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rates:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RateCardDto> {
    return this.rates.approve(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rates:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RateCardDto> {
    return this.rates.cancel(user, id);
  }
}
