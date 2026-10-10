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
  QUOTATION_STATUSES,
  RATE_UNITS,
  SHIPPING_MODES,
  type Page,
  type QuotationDto,
  type QuotationSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import { branchPeriodFields, periodInOrder, routeFields } from '../common/list-filters.js';
import {
  amount,
  currencyCode,
  dateString,
  optionalText,
  pageQuery,
  parse,
  quantity,
  requiredText,
} from '../common/validation.js';
import { QuotationsService } from './quotations.service.js';

const lineBody = z
  .object({
    rateCardId: z.uuid().nullish(),
    chargeTypeCode: z.string().trim().toUpperCase().max(20).optional(),
    description: optionalText(500),
    unit: z.enum(RATE_UNITS).optional(),
    quantity,
    unitPrice: amount.optional(),
    discount: amount.optional(),
  })
  .strict();

const quotationFields = {
  originLocationId: z.uuid(),
  destinationLocationId: z.uuid(),
  mode: z.enum(SHIPPING_MODES),
  loadType: z.enum(LOAD_TYPES).nullish(),
  cargoType: z.enum(CARGO_TYPES),
  cargoDescription: optionalText(2000),
  currency: currencyCode,
  validUntil: dateString,
  terms: optionalText(4000),
  lines: z.array(lineBody).min(1).max(50),
};

export const quotationCreateBody = z.object({ customerId: z.uuid(), ...quotationFields }).strict();
const updateBody = z.object(quotationFields).strict();
const reasonBody = z.object({ reason: requiredText(1000) }).strict();
const listQuery = pageQuery
  .extend({
    status: z.enum(QUOTATION_STATUSES).optional(),
    customerId: z.uuid().optional(),
    ...routeFields,
    ...branchPeriodFields,
  })
  .superRefine(periodInOrder);

@Controller('quotations')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('quotations:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<QuotationSummaryDto>> {
    return this.quotations.list(user, parse(listQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('quotations:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDto> {
    return this.quotations.get(user, id);
  }

  @Post()
  @RequirePermission('quotations:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<QuotationDto> {
    return this.quotations.create(user, parse(quotationCreateBody, body));
  }

  @Patch(':id')
  @RequirePermission('quotations:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<QuotationDto> {
    return this.quotations.update(user, id, parse(updateBody, body));
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:update')
  send(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDto> {
    return this.quotations.send(user, id);
  }

  /** The customer accepted. */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDto> {
    return this.quotations.approve(user, id);
  }

  /** The customer declined. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:approve')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<QuotationDto> {
    return this.quotations.reject(user, id, parse(reasonBody, body).reason);
  }

  @Post(':id/expire')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:cancel')
  expire(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDto> {
    return this.quotations.expire(user, id);
  }
}
