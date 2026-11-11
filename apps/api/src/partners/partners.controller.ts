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
  PARTNER_KINDS,
  REFERRAL_WINDOW_MAX_DAYS,
  type Page,
  type PartnerChatLinkDto,
  type PartnerDto,
  type PartnerSummaryDto,
} from '@nolon/shared';
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
import { ReferrerChannelsService } from './referrer-channels.service.js';

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
  referralWindowDays: z.number().int().min(1).max(REFERRAL_WINDOW_MAX_DAYS).nullish(),
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
  constructor(
    private readonly partners: PartnersService,
    private readonly channels: ReferrerChannelsService,
  ) {}

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

  /** Plan 18, 3: a new customer code for a referrer (the old one stops linking). */
  @Post(':id/referral-code')
  @RequirePermission('partners:update')
  issueReferralCode(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartnerDto> {
    return this.partners.issueReferralCode(user, id);
  }

  /** Plan 18, 5: the broker's private link to bind his chat account, shown once. */
  @Post(':id/chat-link')
  @RequirePermission('partners:update')
  issueChatLink(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartnerChatLinkDto> {
    return this.channels.issueLink(user, id);
  }

  /** Plan 18, 5: ends the broker's linked chat account. */
  @Post(':id/chat-link/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partners:update')
  async revokeChatLink(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartnerDto> {
    await this.channels.revokeBinding(user, id);
    return this.partners.get(user, id);
  }
}
