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
  type AssistantDraftDto,
  BOOKING_SERVICES,
  type BookingDraftDto,
  type BookingDraftListItemDto,
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type DraftPreCheckDto,
  type EntryDraftSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import {
  AgentDraftCheckable,
  AgentDraftDecidable,
  AgentDraftWritable,
  AgentReadable,
  CurrentUser,
  RequirePermission,
} from '../auth/decorators.js';
import { checkRequest, splitReplaced } from '../drafts/drafts.service.js';
import { dateString, optionalText, parse, requiredText } from '../common/validation.js';
import { BookingDraftsService } from './booking-drafts.service.js';
import { bookingFields, itemBody, partyRefs, services } from './bookings.controller.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
/**
 * From an approved quotation (quotationId), or directly for a customer (customerId); a direct one
 * may name an open container to go in (consolidationId).
 */
/**
 * A booking draft's values: a booking's (bookingFields, itemBody), each checked the same way when
 * given, with only the customer required (owner decision, 2026-10-17), or the quotation for one
 * made from a quotation. The rest, a cargo line's type and quantity included, is filled in on
 * review.
 */
const draftItem = itemBody
  .extend({
    cargoType: itemBody.shape.cargoType.nullish(),
    quantity: itemBody.shape.quantity.nullish(),
  })
  .strict();
const draftItems = z.array(draftItem).max(100);
const directValues = {
  ...bookingFields,
  originLocationId: bookingFields.originLocationId.nullish(),
  destinationLocationId: bookingFields.destinationLocationId.nullish(),
  mode: bookingFields.mode.nullish(),
  cargoType: bookingFields.cargoType.nullish(),
  services: z.array(z.enum(BOOKING_SERVICES)).max(BOOKING_SERVICES.length),
  items: draftItems,
  consolidationId: z.uuid().nullish(),
};
const quotedValues = {
  services: services.optional(),
  ...partyRefs,
  requestedDeparture: dateString.nullish(),
  specialInstructions: optionalText(2000),
  items: draftItems.optional(),
};
const createBody = z.union([
  z.object({ ...quotedValues, idempotencyKey, quotationId: z.uuid() }).strict(),
  z
    .object({
      customerId: z.uuid(),
      ...directValues,
      services: directValues.services.optional(),
      items: directValues.items.optional(),
      idempotencyKey,
    })
    .strict(),
]);
/**
 * A person's edit: any value but the customer or the quotation, at the version they read (a draft
 * made from a quotation refuses route and cargo values: BookingDraftsService.update).
 */
const updateBody = z
  .object(directValues)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict();
const approveBody = z.object({ version: z.number().int().min(1) }).strict();
const assistantApproveBody = z
  .object({ version: z.number().int().min(1), contentHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
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
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
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

  /** A person fills in or changes the draft's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('bookings:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BookingDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
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

  /** The chat card's read: only a draft the assistant created for this same user. */
  @AgentReadable()
  @Get(':id/assistant')
  @RequirePermission('bookings:view')
  forAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantDraftDto<BookingDraftDto>> {
    return this.drafts.forAssistant(user, id);
  }

  /** The person approves in the assistant's chat (a click, never a model call). */
  @AgentDraftDecidable()
  @Post(':id/assistant-approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  approveFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BookingDraftDto> {
    return this.drafts.approveFromAssistant(user, id, parse(assistantApproveBody, body));
  }

  /** The person rejects in the assistant's chat. */
  @AgentDraftDecidable()
  @Post(':id/assistant-reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  rejectFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BookingDraftDto> {
    return this.drafts.rejectFromAssistant(user, id, parse(rejectBody, body));
  }
}
