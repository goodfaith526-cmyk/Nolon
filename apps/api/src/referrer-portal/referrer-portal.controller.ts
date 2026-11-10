import { Body, Controller, Get, Post } from '@nestjs/common';
import type { ReferrerPortalDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, ReferrerScoped, RequirePermission } from '../auth/decorators.js';
import { parse, phone } from '../common/validation.js';
import { ReferrerPortalService } from './referrer-portal.service.js';

const customerBody = z.object({ name: z.string().trim().min(2).max(200), phone }).strict();

/** Plan 18, 8: the referral broker's own screen (REFERRER_STAFF only). */
@Controller('referrer-portal')
export class ReferrerPortalController {
  constructor(private readonly portal: ReferrerPortalService) {}

  @ReferrerScoped()
  @Get()
  @RequirePermission('referrer_portal:view')
  get(@CurrentUser() user: AuthUser): Promise<ReferrerPortalDto> {
    return this.portal.get(user);
  }

  @ReferrerScoped()
  @Post('customers')
  @RequirePermission('referrer_portal:create')
  addCustomer(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<ReferrerPortalDto> {
    return this.portal.addCustomer(user, parse(customerBody, body));
  }
}
