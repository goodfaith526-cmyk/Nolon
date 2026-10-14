import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  MY_DRAFTS_MAX,
  MY_DRAFT_KINDS,
  SETTLE_DRAFT_KINDS,
  type DraftCapabilitiesDto,
  type DraftKeySettlementDto,
  type MyDraftItemDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentDraftWritable, AgentReadable, CurrentUser } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
import { draftCapabilities } from './draft-capabilities.js';
import { MyDraftsService } from './my-drafts.service.js';

const mineQuery = z
  .object({
    kind: z.enum(MY_DRAFT_KINDS).optional(),
    status: z.enum(DRAFT_STATUSES).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    // With `before`: the last item's id, so drafts sharing its createdAt are not skipped.
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MY_DRAFTS_MAX).default(20),
  })
  .strict();

const settleBody = z
  .object({
    kind: z.enum(SETTLE_DRAFT_KINDS),
    idempotencyKey: z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key'),
  })
  .strict();

/**
 * The drafts the staff assistant made for the signed-in user, of every kind. No route permission:
 * each kind lists only if the user may view it now.
 */
@Controller('assistant-drafts')
export class MyDraftsController {
  constructor(private readonly drafts: MyDraftsService) {}

  /**
   * What this NOLON offers the assistant: features, and each draft kind's routes and review page,
   * with whether this user may create it now. No route permission: it reveals no data.
   */
  @AgentReadable()
  @Get('capabilities')
  capabilities(@CurrentUser() user: AuthUser): DraftCapabilitiesDto {
    return draftCapabilities(user);
  }

  @AgentReadable()
  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<MyDraftItemDto[]> {
    const { kind, since, before, beforeId, ...rest } = parse(mineQuery, query);
    if (beforeId && !before) throw new BadRequestException('beforeId needs before');
    return this.drafts.list(
      user,
      {
        ...rest,
        ...(since ? { since: new Date(since) } : {}),
        ...(before ? { before: new Date(before), ...(beforeId ? { beforeId } : {}) } : {}),
      },
      kind,
    );
  }

  /**
   * The final answer for a create the assistant got no answer for. No route permission: the
   * user's permissions may have changed since the create, and the answer must not depend on them.
   */
  @AgentDraftWritable()
  @Post('settle')
  @HttpCode(HttpStatus.OK)
  settle(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftKeySettlementDto> {
    const { kind, idempotencyKey } = parse(settleBody, body);
    return this.drafts.settle(user, kind, idempotencyKey);
  }

  /**
   * The same answer as settle, and the assistant's word that its task under the key is final:
   * the key's ledger row may go DRAFT_RETENTION_DAYS later, never before.
   */
  @AgentDraftWritable()
  @Post('settle/ack')
  @HttpCode(HttpStatus.OK)
  acknowledge(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<DraftKeySettlementDto> {
    const { kind, idempotencyKey } = parse(settleBody, body);
    return this.drafts.settle(user, kind, idempotencyKey, true);
  }
}
