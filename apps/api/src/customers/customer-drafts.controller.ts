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
  type CustomerDraftDto,
  type CustomerDraftListItemDto,
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type DraftPreCheckDto,
  type EntryDraftSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import {
  AgentDraftCheckable,
  AgentDraftWritable,
  AgentReadable,
  CurrentUser,
  RequirePermission,
} from '../auth/decorators.js';
import { confirmedFields, draftEvidence } from '../drafts/draft-evidence.js';
import { checkRequest, splitReplaced } from '../drafts/drafts.service.js';
import { parse, requiredText } from '../common/validation.js';
import { customerDraftFields } from './customer-schemas.js';
import { CustomerDraftsService } from './customer-drafts.service.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
const createBody = z
  .object({
    idempotencyKey,
    branchId: z.uuid(),
    ...customerDraftFields,
    evidence: draftEvidence(['branchId', 'name', 'phone', 'whatsapp']),
  })
  .strict();
/** A person's edit: any value but the branch, at the version they read. */
const updateBody = z
  .object(customerDraftFields)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict();
const approveBody = z
  .object({ version: z.number().int().min(1), confirmed: confirmedFields })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Customer drafts (entry drafts). The staff assistant creates drafts and recovers the one it
 * created under a key; a person reads, approves and rejects them on the review screen.
 */
@Controller('customer-drafts')
export class CustomerDraftsController {
  constructor(private readonly drafts: CustomerDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('customers:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('customers:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('customers:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<CustomerDraftListItemDto[]> {
    return this.drafts.listForReview(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('customers:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerDraftDto> {
    return this.drafts.get(user, id);
  }

  /** A person fills in or changes the draft's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('customers:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDraftDto> {
    const { version, confirmed } = parse(approveBody, body);
    return this.drafts.approve(user, id, version, confirmed);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
