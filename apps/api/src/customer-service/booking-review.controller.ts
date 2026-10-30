import { CustomerIdentityFilter } from './customer-identity.filter.js';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  CS_REVIEW_FILTERS,
  LOAD_TYPES,
  SHIPPING_MODES,
  type CsApprovalPriceDto,
  type CsBookingRequestStaffDto,
  type CsBookingRequestSummaryDto,
  type CsRejectReasonDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { bookingCreateBody } from '../bookings/bookings.controller.js';
import { currencyCode, optionalText, parse, quantity, requiredText } from '../common/validation.js';
import { BookingReviewService, mayReview } from './booking-review.service.js';

/**
 * The reads take no @RequirePermission (Codex F131-1): the guard would narrow the person's branches
 * to those holding one permission, while a request awaiting routing is theirs to see where they
 * may route or decide it without viewing. They need VIEW, ROUTE or DECIDE somewhere, and the
 * service decides each request per branch (visibleTo).
 */
function requireReviewer(user: AuthUser): AuthUser {
  if (!mayReview(user)) throw new ForbiddenException('Missing permission');
  return user;
}

const listQuery = z.object({ state: z.enum(CS_REVIEW_FILTERS).default('open') }).strict();
const version = z.number().int().min(1);
const routeBody = z.object({ version, branchId: z.uuid() }).strict();
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'A code of capitals, digits and _');
const rejectBody = z
  .object({ version, reasonCode, internalNote: optionalText(1000).optional() })
  .strict();
const priceInputs = z
  .object({
    originId: z.uuid(),
    destinationId: z.uuid(),
    mode: z.enum(SHIPPING_MODES),
    loadType: z.enum(LOAD_TYPES).nullish(),
    category: z.string().trim().toUpperCase().min(1).max(20),
    quantity,
    currency: currencyCode,
  })
  .strict();
const approveBody = z
  .object({
    version,
    paymentCurrency: currencyCode,
    profileVersion: version.optional(),
    pricing: priceInputs,
    pricingFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    // F137-1: route, mode, load type and cargo come from `pricing`; the booking has no line.
    booking: bookingCreateBody
      .omit({
        originLocationId: true,
        destinationLocationId: true,
        mode: true,
        loadType: true,
        cargoType: true,
        items: true,
      })
      .partial({ customerId: true }),
  })
  .strict();
const reasonBody = z
  .object({ textAr: requiredText(300), textEn: requiredText(300), isActive: z.boolean() })
  .strict();

/**
 * Staff review of the shipping bot's booking requests (plan 04a section 3): a staff session only,
 * never an API key. Approval makes the booking with the ordinary create checks (R3-ج2).
 */
@Controller('cs-booking-requests')
@UseFilters(CustomerIdentityFilter)
export class BookingReviewController {
  constructor(private readonly review: BookingReviewService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<CsBookingRequestSummaryDto[]> {
    return this.review.list(requireReviewer(user), parse(listQuery, query).state);
  }

  /** The reasons a request may be rejected for, the inactive ones last. */
  @Get('reject-reasons')
  reasons(@CurrentUser() user: AuthUser): Promise<CsRejectReasonDto[]> {
    requireReviewer(user);
    return this.review.reasons();
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CsBookingRequestStaffDto> {
    return this.review.detail(requireReviewer(user), id);
  }

  /** The engine's price for the approval's inputs (plan 04a section 1); a read, no price kept. */
  @Get(':id/price')
  @RequirePermission('cs_booking_requests:approve')
  price(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<CsApprovalPriceDto> {
    return this.review.price(user, id, parse(priceInputs, query));
  }

  /** Makes the booking and approves the request in one transaction. */
  @Post(':id/approve')
  @RequirePermission('cs_booking_requests:approve', 'bookings:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CsBookingRequestStaffDto> {
    return this.review.approve(user, id, parse(approveBody, body));
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
