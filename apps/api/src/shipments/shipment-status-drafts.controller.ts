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
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type DraftPreCheckDto,
  type EntryDraftSummaryDto,
  SHIPMENT_STATUS_DRAFT_EXCLUDED,
  SHIPMENT_STATUSES,
  type ShipmentStatusDraftDto,
  type ShipmentStatusDraftListItemDto,
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
import { optionalText, parse, requiredText } from '../common/validation.js';
import { ShipmentStatusDraftsService } from './shipment-status-drafts.service.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const excluded: readonly string[] = SHIPMENT_STATUS_DRAFT_EXCLUDED;
const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
// Dated at the approval: the assistant gives no time. Closing, holding and cancelling stay a
// person's own actions. No value is required (owner decision, 2026-10-17): the draft belongs to
// the shipment's branch, or to the branch it names while it has no shipment.
const draftValues = {
  shipmentId: z.uuid().nullish(),
  status: z
    .enum(SHIPMENT_STATUSES)
    .refine((s) => !excluded.includes(s), 'This status cannot be proposed by the assistant')
    .nullish(),
  locationId: z.uuid().nullish(),
  note: optionalText(1000),
};
const createBody = z
  .object({
    ...draftValues,
    idempotencyKey,
    branchId: z.uuid().nullish(),
    evidence: draftEvidence(['shipmentId', 'status', 'locationId']),
  })
  .strict();
/** A person's edit: any value (a shipment of the draft's branch), at the version they read. */
const updateBody = z
  .object(draftValues)
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
 * Shipment status drafts (entry drafts). The staff assistant creates drafts and recovers the one it
 * created under a key; a person reads, approves and rejects them on the review screen. As for a
 * status change, the route needs shipments:view and the service checks the permission the move
 * needs (shipments:update or the stage's own permission).
 */
@Controller('shipment-status-drafts')
export class ShipmentStatusDraftsController {
  constructor(private readonly drafts: ShipmentStatusDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('shipments:view')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:view')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('shipments:view')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('shipments:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<ShipmentStatusDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('shipments:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ShipmentStatusDraftDto> {
    return this.drafts.get(user, id);
  }

  /** A person fills in or changes the draft's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('shipments:view')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentStatusDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:view')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentStatusDraftDto> {
    const { version, confirmed } = parse(approveBody, body);
    return this.drafts.approve(user, id, version, confirmed);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:view')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentStatusDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
