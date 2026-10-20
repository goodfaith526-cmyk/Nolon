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
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type DraftPreCheckDto,
  type EntryDraftSummaryDto,
  type GoodsReleaseDraftDto,
  type GoodsReleaseDraftListItemDto,
  type ReleaseDraftWarehouseOptionsDto,
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
import { parse, requiredText } from '../common/validation.js';
import { GoodsReleaseDraftsService } from './goods-release-drafts.service.js';
import { releaseBody } from './warehouse.controller.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
// Released at the approval: the assistant gives no time.
/**
 * A release draft's values: a release's (releaseBody), each checked the same way when given, none
 * of them required (owner decision, 2026-10-17). The draft belongs to the shipment's branch, or
 * to the branch it names while it has no shipment.
 */
const draftValues = releaseBody.omit({ occurredAt: true }).extend({
  shipmentId: z.uuid().nullish(),
  warehouseId: releaseBody.shape.warehouseId.nullish(),
  packages: releaseBody.shape.packages.nullish(),
});
const createBody = draftValues.extend({ idempotencyKey, branchId: z.uuid().nullish() }).strict();
/** A person's edit: any value (a shipment of the draft's branch), at the version they read. */
const updateBody = draftValues
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
 * Goods release drafts (entry drafts). The staff assistant creates drafts and recovers the one it created
 * under a key; a person reads, approves and rejects them.
 */
@Controller('release-drafts')
export class GoodsReleaseDraftsController {
  constructor(private readonly drafts: GoodsReleaseDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('warehouse:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('warehouse:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('warehouse:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<GoodsReleaseDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('warehouse:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GoodsReleaseDraftDto> {
    return this.drafts.get(user, id);
  }

  /**
   * The review screen's warehouse choices: the warehouses holding the shipment's goods in the
   * reviewer's branches, and NOLON's suggestion for a missing warehouse and packages. A person's
   * read (not @AgentReadable); nothing is written.
   */
  @Get(':id/warehouse-options')
  @RequirePermission('warehouse:create')
  warehouseOptions(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReleaseDraftWarehouseOptionsDto> {
    return this.drafts.warehouseOptions(user, id);
  }

  /** A person fills in or changes the draft's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('warehouse:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<GoodsReleaseDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<GoodsReleaseDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<GoodsReleaseDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }

  /** The chat card's read: only a draft the assistant created for this same user. */
  @AgentReadable()
  @Get(':id/assistant')
  @RequirePermission('warehouse:view')
  forAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantDraftDto<GoodsReleaseDraftDto>> {
    return this.drafts.forAssistant(user, id);
  }

  /** The person approves in the assistant's chat (a click, never a model call). */
  @AgentDraftDecidable()
  @Post(':id/assistant-approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:create')
  approveFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<GoodsReleaseDraftDto> {
    return this.drafts.approveFromAssistant(user, id, parse(assistantApproveBody, body));
  }

  /** The person rejects in the assistant's chat. */
  @AgentDraftDecidable()
  @Post(':id/assistant-reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:create')
  rejectFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<GoodsReleaseDraftDto> {
    return this.drafts.rejectFromAssistant(user, id, parse(rejectBody, body));
  }
}
