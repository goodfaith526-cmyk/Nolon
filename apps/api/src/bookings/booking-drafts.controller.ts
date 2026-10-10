import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type EntryDraftSummaryDto,
  type BookingDraftDto,
  type BookingDraftListItemDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import {
  AgentDraftWritable,
  AgentReadable,
  CurrentUser,
  RequirePermission,
} from '../auth/decorators.js';
import { parse, requiredText } from '../common/validation.js';
import { BookingDraftsService } from './booking-drafts.service.js';
import { bookingCreateBody, bookingFromQuotationBody } from './bookings.controller.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
/** From an approved quotation (quotationId), or directly for a customer (customerId). */
const createBody = z.union([
  bookingFromQuotationBody.extend({ idempotencyKey, quotationId: z.uuid() }).strict(),
  bookingCreateBody.extend({ idempotencyKey }).strict(),
]);
const approveBody = z.object({ version: z.number().int().min(1) }).strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Booking drafts (entry drafts). The staff assistant creates drafts and recovers the one it
 * created under a key; a person reads, approves and rejects them.
 */
@Controller('booking-drafts')
export class BookingDraftsController {
  constructor(private readonly drafts: BookingDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('bookings:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    return this.drafts.create(user, parse(createBody, body));
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('bookings:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('bookings:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<BookingDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('bookings:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingDraftDto> {
    return this.drafts.get(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BookingDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BookingDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
