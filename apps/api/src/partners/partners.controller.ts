import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { PARTNER_KINDS, type Page, type PartnerDto, type PartnerSummaryDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, OutletScoped, RequirePermission } from '../auth/decorators.js';
import { optionalFlag } from '../common/list-filters.js';
import {
  countryCode,
  currencyCode,
  optionalText,
  pageQuery,
  parse,
  phone,
  requiredText,
} from '../common/validation.js';
import { email } from '../customers/customer-schemas.js';
import { PartnersService } from './partners.service.js';

const listQuery = pageQuery.extend({
  branchId: z.uuid().optional(),
  kind: z.enum(PARTNER_KINDS).optional(),
  isActive: optionalFlag,
});

const partnerFields = {
  kind: z.enum(PARTNER_KINDS),
  name: requiredText(200),
  phone: phone.nullish(),
  email,
  countryCode,
  locationId: z.uuid().nullish(),
  supplierId: z.uuid().nullish(),
  currency: currencyCode,
  notes: optionalText(2000),
};

const createBody = z.object({ branchId: z.uuid(), ...partnerFields }).strict();

/** The branch is fixed: it owns the partner's records (strict, so `branchId` is a 400). */
const updateBody = z
  .object({ ...partnerFields, isActive: z.boolean() })
  .partial()
  .strict();

/**
 * Partners of the network (business model batch 1). Not readable by the staff AI assistant yet
 * (no @AgentReadable): the agent learns about partners in a later, reviewed step.
 */
@Controller('partners')
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  @OutletScoped()
  @Get()
  @RequirePermission('partners:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<PartnerSummaryDto>> {
    return this.partners.list(user, parse(listQuery, query));
  }

  @OutletScoped()
  @Get(':id')
  @RequirePermission('partners:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PartnerDto> {
    return this.partners.get(user, id);
  }

  @Post()
  @RequirePermission('partners:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<PartnerDto> {
    return this.partners.create(user, parse(createBody, body));
  }

  @Patch(':id')
  @RequirePermission('partners:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PartnerDto> {
    return this.partners.update(user, id, parse(updateBody, body));
  }
}
