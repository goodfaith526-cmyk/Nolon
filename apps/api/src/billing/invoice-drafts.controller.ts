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
  MAX_ACKNOWLEDGED_INVOICES,
  type DraftPreCheckDto,
  type EntryDraftSummaryDto,
  type InvoiceDraftDto,
  type InvoiceDraftListItemDto,
  type InvoiceDraftSuggestedValuesDto,
  type InvoiceSuggestionDto,
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
import {
  amount,
  currencyCode,
  dateString,
  optionalText,
  parse,
  requiredText,
} from '../common/validation.js';
import { invoiceLine } from './billing.controller.js';
import { checkRequest, splitReplaced } from '../drafts/drafts.service.js';
import { InvoiceDraftsService } from './invoice-drafts.service.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
/**
 * An invoice draft's values: an invoice's, each checked the same way when given, none of them
 * required (owner decision, 2026-10-17). The draft belongs to the shipment's owning branch, or to
 * the branch it names while it has no shipment.
 */
const draftValues = {
  shipmentId: z.uuid().nullish(),
  currency: currencyCode.nullish(),
  invoiceDate: dateString.nullish(),
  dueDate: dateString.nullish(),
  notes: optionalText(2000),
  // No unit price: NOLON prices the line (the shipment's quotation, else its rate card), once
  // the draft can be priced.
  lines: z
    .array(
      invoiceLine.extend({
        chargeTypeCode: invoiceLine.shape.chargeTypeCode.nullish(),
        quantity: invoiceLine.shape.quantity.nullish(),
        unitPrice: amount.nullish(),
      }),
    )
    .max(100),
};
const createBody = z
  .object({
    ...draftValues,
    lines: draftValues.lines.optional(),
    branchId: z.uuid().nullish(),
    idempotencyKey,
  })
  .strict();
/** A person's edit: any value (a shipment of the draft's branch), at the version they read. */
const updateBody = z
  .object(draftValues)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict();
const approveBody = z
  .object({
    version: z.number().int().min(1),
    acknowledgedInvoiceIds: z.array(z.uuid()).max(MAX_ACKNOWLEDGED_INVOICES).optional(),
  })
  .strict();
const assistantApproveBody = z
  .object({ version: z.number().int().min(1), contentHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const suggestBody = z
  .object({
    shipmentId: z.uuid(),
    currency: currencyCode.optional(),
    invoiceDate: dateString.optional(),
  })
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
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  /**
   * What NOLON would put on an invoice for the shipment (its quotation, else its rate cards), for
   * the currency and invoice date given or NOLON's defaults; nothing is written.
   */
  @AgentDraftCheckable()
  @Post('suggest')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:create')
  suggest(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<InvoiceSuggestionDto> {
    return this.drafts.suggest(user, parse(suggestBody, body));
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

  /**
   * NOLON's suggestion for the currency and dates the draft misses, for the review screen's form
   * (applied, if the person keeps them, with the PATCH). A person's read (not @AgentReadable).
   */
  @Get(':id/suggested-values')
  @RequirePermission('customer_invoices:create')
  suggestedValues(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDraftSuggestedValuesDto> {
    return this.drafts.suggestedValues(user, id);
  }

  @Get(':id')
  @RequirePermission('customer_invoices:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDraftDto> {
    return this.drafts.get(user, id);
  }

  /** A person fills in or changes the draft's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('customer_invoices:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InvoiceDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InvoiceDraftDto> {
    const { version, acknowledgedInvoiceIds } = parse(approveBody, body);
    return this.drafts.approve(user, id, version, 'SESSION', acknowledgedInvoiceIds);
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

  /** The chat card's read: only a draft the assistant created for this same user. */
  @AgentReadable()
  @Get(':id/assistant')
  @RequirePermission('customer_invoices:view')
  forAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantDraftDto<InvoiceDraftDto>> {
    return this.drafts.forAssistant(user, id);
  }

  /** The person approves in the assistant's chat (a click, never a model call). */
  @AgentDraftDecidable()
  @Post(':id/assistant-approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:create')
  approveFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InvoiceDraftDto> {
    return this.drafts.approveFromAssistant(user, id, parse(assistantApproveBody, body));
  }

  /** The person rejects in the assistant's chat. */
  @AgentDraftDecidable()
  @Post(':id/assistant-reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:create')
  rejectFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<InvoiceDraftDto> {
    return this.drafts.rejectFromAssistant(user, id, parse(rejectBody, body));
  }
}
