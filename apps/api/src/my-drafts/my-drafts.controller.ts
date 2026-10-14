import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { DRAFT_STATUSES, MY_DRAFTS_MAX, MY_DRAFT_KINDS, type MyDraftItemDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
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

/**
 * The drafts the staff assistant made for the signed-in user, of every kind. No route permission:
 * each kind lists only if the user may view it now.
 */
@Controller('assistant-drafts')
export class MyDraftsController {
  constructor(private readonly drafts: MyDraftsService) {}

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
}
