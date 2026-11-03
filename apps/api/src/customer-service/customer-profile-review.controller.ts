import { CustomerIdentityFilter } from './customer-identity.filter.js';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
import { CustomerProfileReviewService } from './customer-profile-review.service.js';

const rule = z
  .object({
    expectedVersion: z.number().int().min(0),
    residenceCityId: z.uuid(),
    serviceCode: z.string().min(1).max(40).nullish(),
    branchId: z.uuid(),
    isActive: z.boolean(),
  })
  .strict();
const proof = z
  .object({
    accountId: z.uuid().optional(),
    profileId: z.uuid().optional(),
    proofNote: z.string().trim().min(20).max(1000),
  })
  .strict()
  .refine((v) => !!v.accountId !== !!v.profileId, 'Select exactly one proved identity');
@Controller('customer-profiles')
@UseFilters(CustomerIdentityFilter)
export class CustomerProfileReviewController {
  constructor(private readonly review: CustomerProfileReviewService) {}

  @Get('intake')
  @RequirePermission('customer_profile_intake:view')
  intake(@Query() query: unknown) {
    return this.review.intake(
      parse(
        z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict(),
        query,
      ).page,
    );
  }

  @Get('follow-up-rules')
  @RequirePermission('customer_profile_followup:update')
  rules() {
    return this.review.rules();
  }

  @Put('follow-up-rules/:id')
  @RequirePermission('customer_profile_followup:update')
  rule(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.review.rule(user, id, parse(rule, body));
  }

  @Post('intake/:id/resolve')
  @RequirePermission('customer_profile_intake:update')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.review.resolve(user, id, parse(proof, body));
  }

  @Get(':id')
  @RequirePermission('customer_profiles:view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.review.get(id);
  }

  @Post(':id/reject-proposals')
  @RequirePermission('customer_profile_intake:update')
  keepCurrent(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z
        .object({
          expectedVersion: z.number().int().min(1),
          proofNote: z.string().trim().min(20).max(1000),
        })
        .strict(),
      body,
    );
    return this.review.keepCurrent(user, id, input.expectedVersion, input.proofNote);
  }
}
