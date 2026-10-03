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
  CARGO_TYPES,
  LOAD_TYPES,
  RATE_STATUSES,
  RATE_UNITS,
  SHIPPING_MODES,
  type Page,
  type RateCardDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import {
  amount,
  currencyCode,
  dateString,
  optionalText,
  pageQuery,
  parse,
} from '../common/validation.js';
import { RatesService } from './rates.service.js';

const rateFields = {
  originLocationId: z.uuid(),
  destinationLocationId: z.uuid(),
  mode: z.enum(SHIPPING_MODES),
  loadType: z.enum(LOAD_TYPES).nullish(),
  cargoType: z.enum(CARGO_TYPES),
  containerTypeCode: z.string().trim().toUpperCase().max(10).nullish(),
  chargeTypeCode: z.string().trim().toUpperCase().max(20).optional(),
  unit: z.enum(RATE_UNITS),
  price: amount,
  minimumCharge: amount.optional(),
  currency: currencyCode,
  validFrom: dateString,
  validTo: dateString.nullish(),
  transitDays: z.number().int().min(0).max(365).nullish(),
  notes: optionalText(2000),
};

const createBody = z.object({ branchId: z.uuid(), ...rateFields }).strict();
const updateBody = z.object(rateFields).partial().strict();
const listQuery = pageQuery.extend({
  status: z.enum(RATE_STATUSES).optional(),
  originLocationId: z.uuid().optional(),
  destinationLocationId: z.uuid().optional(),
  mode: z.enum(SHIPPING_MODES).optional(),
});

@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get()
  @RequirePermission('rates:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<RateCardDto>> {
    return this.rates.list(user, parse(listQuery, query));
  }

  @Get(':id')
  @RequirePermission('rates:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<RateCardDto> {
    return this.rates.get(user, id);
  }

  @Post()
  @RequirePermission('rates:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<RateCardDto> {
    return this.rates.create(user, parse(createBody, body));
  }

  @Patch(':id')
  @RequirePermission('rates:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<RateCardDto> {
    return this.rates.update(user, id, parse(updateBody, body));
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
