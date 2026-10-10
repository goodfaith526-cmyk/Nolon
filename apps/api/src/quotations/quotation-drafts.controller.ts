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
  type QuotationDraftDto,
  type QuotationDraftListItemDto,
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
import { QuotationDraftsService } from './quotation-drafts.service.js';
import { quotationCreateBody } from './quotations.controller.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
const createBody = quotationCreateBody.extend({ idempotencyKey }).strict();
const approveBody = z.object({ version: z.number().int().min(1) }).strict();
const assistantApproveBody = z
  .object({ version: z.number().int().min(1), contentHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Quotation drafts (entry drafts). The staff assistant creates drafts and recovers the one it
 * created under a key; a person reads, approves and rejects them.
 */
@Controller('quotation-drafts')
export class QuotationDraftsController {
  constructor(private readonly drafts: QuotationDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('quotations:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    return this.drafts.create(user, parse(createBody, body));
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('quotations:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('quotations:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<QuotationDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('quotations:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDraftDto> {
    return this.drafts.get(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<QuotationDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<QuotationDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }

  /** The chat card's read: only a draft the assistant created for this same user. */
  @AgentReadable()
  @Get(':id/assistant')
  @RequirePermission('quotations:view')
  forAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantDraftDto<QuotationDraftDto>> {
    return this.drafts.forAssistant(user, id);
  }

  /** The person approves in the assistant's chat (a click, never a model call). */
  @AgentDraftDecidable()
  @Post(':id/assistant-approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:create')
  approveFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<QuotationDraftDto> {
    return this.drafts.approveFromAssistant(user, id, parse(assistantApproveBody, body));
  }

  /** The person rejects in the assistant's chat. */
  @AgentDraftDecidable()
  @Post(':id/assistant-reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:create')
  rejectFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<QuotationDraftDto> {
    return this.drafts.rejectFromAssistant(user, id, parse(rejectBody, body));
  }
}
