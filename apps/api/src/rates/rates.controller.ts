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
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import { pageQuery, parse } from '../common/validation.js';
import { createRateBody, updateRateBody } from './rate-schemas.js';
import { RatesService } from './rates.service.js';

const listQuery = pageQuery.extend({
  status: z.enum(RATE_STATUSES).optional(),
  originLocationId: z.uuid().optional(),
  destinationLocationId: z.uuid().optional(),
  mode: z.enum(SHIPPING_MODES).optional(),
});

@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('rates:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<RateCardDto>> {
    return this.rates.list(user, parse(listQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('rates:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<RateCardDto> {
    return this.rates.get(user, id);
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
