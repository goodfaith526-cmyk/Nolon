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
  type AssistantDraftDto,
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type EntryDraftSummaryDto,
  type TripDraftDto,
  type TripDraftListItemDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import {
  AgentDraftDecidable,
  AgentDraftWritable,
  AgentReadable,
  CurrentUser,
  RequirePermission,
} from '../auth/decorators.js';
import { parse, requiredText } from '../common/validation.js';
import { TripDraftsService } from './trip-drafts.service.js';
import { tripBody } from './transport.controller.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
const createBody = tripBody.extend({ idempotencyKey }).strict();
const approveBody = z.object({ version: z.number().int().min(1) }).strict();
const assistantApproveBody = z
  .object({ version: z.number().int().min(1), contentHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Trip drafts (entry drafts). The staff assistant creates drafts and recovers the one it created
 * under a key; a person reads, approves and rejects them.
 */
@Controller('trip-drafts')
export class TripDraftsController {
  constructor(private readonly drafts: TripDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('transport_trips:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    return this.drafts.create(user, parse(createBody, body));
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('transport_trips:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('transport_trips:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<TripDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('transport_trips:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TripDraftDto> {
    return this.drafts.get(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transport_trips:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transport_trips:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }

  /** The chat card's read: only a draft the assistant created for this same user. */
  @AgentReadable()
  @Get(':id/assistant')
  @RequirePermission('transport_trips:view')
  forAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantDraftDto<TripDraftDto>> {
    return this.drafts.forAssistant(user, id);
  }

  /** The person approves in the assistant's chat (a click, never a model call). */
  @AgentDraftDecidable()
  @Post(':id/assistant-approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transport_trips:create')
  approveFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDraftDto> {
    return this.drafts.approveFromAssistant(user, id, parse(assistantApproveBody, body));
  }

  /** The person rejects in the assistant's chat. */
  @AgentDraftDecidable()
  @Post(':id/assistant-reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transport_trips:create')
  rejectFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDraftDto> {
    return this.drafts.rejectFromAssistant(user, id, parse(rejectBody, body));
  }
}
