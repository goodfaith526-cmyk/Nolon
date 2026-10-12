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
  type CustomerDraftDto,
  type CustomerDraftListItemDto,
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type EntryDraftSummaryDto,
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
import { customerFields } from './customer-schemas.js';
import { CustomerDraftsService } from './customer-drafts.service.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
// The contact details a person gives in a chat; terms, credit and tax details are set later.
const createBody = z
  .object({
    idempotencyKey,
    branchId: z.uuid(),
    kind: customerFields.kind,
    name: customerFields.name,
    companyName: customerFields.companyName,
    phone: customerFields.phone,
    whatsapp: customerFields.whatsapp,
    email: customerFields.email,
    city: customerFields.city,
    address: customerFields.address,
    notes: customerFields.notes,
  })
  .strict();
const approveBody = z.object({ version: z.number().int().min(1) }).strict();
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
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('customers:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerDraftDto> {
    return this.drafts.get(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
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
