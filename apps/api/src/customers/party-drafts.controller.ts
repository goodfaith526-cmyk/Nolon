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
  type PartyDraftDto,
  type PartyDraftListItemDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import {
  AgentDraftWritable,
  AgentReadable,
  CurrentUser,
  RequirePermission,
} from '../auth/decorators.js';
import { splitReplaced } from '../drafts/drafts.service.js';
import { parse, requiredText } from '../common/validation.js';
import { partyBody } from './customer-schemas.js';
import { PartyDraftsService } from './party-drafts.service.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
const createBody = partyBody.extend({ idempotencyKey, customerId: z.uuid() }).strict();
const approveBody = z.object({ version: z.number().int().min(1) }).strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Party drafts (entry drafts). The staff assistant creates drafts and recovers the one it created
 * under a key; a person reads, approves and rejects them on the review screen.
 */
@Controller('party-drafts')
export class PartyDraftsController {
  constructor(private readonly drafts: PartyDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('customers:update')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('customers:update')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('customers:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<PartyDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('customers:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartyDraftDto> {
    return this.drafts.get(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:update')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PartyDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:update')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PartyDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
