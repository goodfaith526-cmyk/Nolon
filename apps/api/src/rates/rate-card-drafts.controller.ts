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
  type RateCardDraftDto,
  type RateCardDraftListItemDto,
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
import { rateFields } from './rate-schemas.js';
import { RateCardDraftsService } from './rate-card-drafts.service.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
/**
 * A rate card draft's values: a rate's (rateFields), each checked the same way when given, with
 * only the branch required (owner decision, 2026-10-17). The rest is filled in on review.
 */
const draftValues = {
  ...rateFields,
  originLocationId: rateFields.originLocationId.nullish(),
  destinationLocationId: rateFields.destinationLocationId.nullish(),
  mode: rateFields.mode.nullish(),
  cargoType: rateFields.cargoType.nullish(),
  unit: rateFields.unit.nullish(),
  price: rateFields.price.nullish(),
  minimumCharge: rateFields.minimumCharge.unwrap().nullish(),
  chargeTypeCode: rateFields.chargeTypeCode.unwrap().nullish(),
  currency: rateFields.currency.nullish(),
  validFrom: rateFields.validFrom.nullish(),
};
/** A person's edit: any value but the branch, at the version they read. */
const updateBody = z
  .object(draftValues)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict();
const createBody = z
  .object({
    idempotencyKey,
    branchId: z.uuid(),
    ...draftValues,
    // The values the assistant binds to the staff member's words (its BOUND_FIELDS).
    evidence: draftEvidence([
      'branchId',
      'originLocationId',
      'destinationLocationId',
      'price',
      'minimumCharge',
      'currency',
      'transitDays',
    ]),
  })
  .strict();
const approveBody = z
  .object({ version: z.number().int().min(1), confirmed: confirmedFields })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Rate card drafts (entry drafts). The staff assistant creates drafts and recovers the one it
 * created under a key; a person reads, approves and rejects them on the review screen.
 */
@Controller('rate-card-drafts')
export class RateCardDraftsController {
  constructor(private readonly drafts: RateCardDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('rates:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rates:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('rates:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('rates:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<RateCardDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('rates:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RateCardDraftDto> {
    return this.drafts.get(user, id);
  }

  /** A person fills in or changes the draft's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('rates:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<RateCardDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rates:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<RateCardDraftDto> {
    const { version, confirmed } = parse(approveBody, body);
    return this.drafts.approve(user, id, version, confirmed);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rates:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<RateCardDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
