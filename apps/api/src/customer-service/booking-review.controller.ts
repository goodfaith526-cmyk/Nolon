import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  CS_REVIEW_FILTERS,
  type CsBookingRequestStaffDto,
  type CsBookingRequestSummaryDto,
  type CsRejectReasonDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { optionalText, parse, requiredText } from '../common/validation.js';
import { BookingReviewService } from './booking-review.service.js';

const listQuery = z.object({ state: z.enum(CS_REVIEW_FILTERS).default('open') }).strict();
const version = z.number().int().min(1);
const routeBody = z.object({ version, branchId: z.uuid() }).strict();
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'A code of capitals, digits and _');
const rejectBody = z
  .object({ version, reasonCode, internalNote: optionalText(1000).optional() })
  .strict();
const reasonBody = z
  .object({ textAr: requiredText(300), textEn: requiredText(300), isActive: z.boolean() })
  .strict();

/**
 * Staff review of the shipping bot's booking requests (plan 04a section 3): a staff session only,
 * never an API key. Approval goes through the booking form (R3-ج2).
 */
@Controller('cs-booking-requests')
export class BookingReviewController {
  constructor(private readonly review: BookingReviewService) {}

  @Get()
  @RequirePermission('cs_booking_requests:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<CsBookingRequestSummaryDto[]> {
    return this.review.list(user, parse(listQuery, query).state);
  }

  /** The reasons a request may be rejected for, the inactive ones last. */
  @Get('reject-reasons')
  @RequirePermission('cs_booking_requests:view')
  reasons(): Promise<CsRejectReasonDto[]> {
    return this.review.reasons();
  }

  @Get(':id')
  @RequirePermission('cs_booking_requests:view')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CsBookingRequestStaffDto> {
    return this.review.detail(user, id);
  }

  @Post(':id/route')
  @RequirePermission('cs_booking_requests:update')
  route(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CsBookingRequestStaffDto> {
    return this.review.route(user, id, parse(routeBody, body));
  }

  @Post(':id/reject')
  @RequirePermission('cs_booking_requests:approve')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CsBookingRequestStaffDto> {
    return this.review.reject(user, id, parse(rejectBody, body));
  }
}

/** The reasons themselves: master data the Administrator keeps (plan 04a section 4). */
@Controller('cs-reject-reasons')
export class RejectReasonsController {
  constructor(private readonly review: BookingReviewService) {}

  @Put(':code')
  @RequirePermission('master_data:update')
  set(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<CsRejectReasonDto> {
    return this.review.setReason(user, parse(reasonCode, code), parse(reasonBody, body));
  }
}
