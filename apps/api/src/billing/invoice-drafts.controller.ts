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
  type InvoiceDraftDto,
  type InvoiceDraftListItemDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import {
  AgentDraftWritable,
  AgentReadable,
  CurrentUser,
  RequirePermission,
} from '../auth/decorators.js';
import {
  currencyCode,
  dateString,
  optionalText,
  parse,
  requiredText,
} from '../common/validation.js';
import { invoiceLine } from './billing.controller.js';
import { InvoiceDraftsService } from './invoice-drafts.service.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
const createBody = z
  .object({
    shipmentId: z.uuid(),
    currency: currencyCode,
    invoiceDate: dateString,
    dueDate: dateString,
    notes: optionalText(2000),
    lines: z.array(invoiceLine).min(1).max(100),
    idempotencyKey,
  })
  .strict();
const approveBody = z.object({ version: z.number().int().min(1) }).strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Customer invoice drafts (entry drafts). The staff assistant creates drafts and recovers the one it created
 * under a key; a person reads, approves and rejects them.
 */
@Controller('invoice-drafts')
export class InvoiceDraftsController {
  constructor(private readonly drafts: InvoiceDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('customer_invoices:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    return this.drafts.create(user, parse(createBody, body));
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('customer_invoices:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('customer_invoices:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<InvoiceDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('customer_invoices:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDraftDto> {
    return this.drafts.get(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InvoiceDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InvoiceDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
