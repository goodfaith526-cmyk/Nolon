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
  type ReceiptDraftDto,
  type ReceiptDraftListItemDto,
  type ReceiptCashAccountDto,
  type ReceiptOpenInvoiceDto,
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
import { currencyCode, parse, requiredText } from '../common/validation.js';
import { createReceiptBody } from './billing.controller.js';
import { ReceiptDraftsService } from './receipt-drafts.service.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
// The fx rate is the rate table's for the receipt date, never the assistant's.
/**
 * A receipt draft's values: a receipt's (createReceiptBody), each checked the same way when
 * given, none of them required (owner decision, 2026-10-17). The draft belongs to the customer's
 * branch, or to the branch it names while it has no customer.
 */
const fields = createReceiptBody.shape;
const draftValues = {
  customerId: fields.customerId.nullish(),
  receiptDate: fields.receiptDate.nullish(),
  currency: fields.currency.nullish(),
  amount: fields.amount.nullish(),
  cashAccountId: fields.cashAccountId.nullish(),
  reference: fields.reference,
  notes: fields.notes,
  allocations: z
    .array(z.object({ invoiceId: z.uuid().nullish(), amount: fields.amount.nullish() }).strict())
    .max(100),
};
const createBody = z
  .object({
    ...draftValues,
    allocations: draftValues.allocations.optional(),
    branchId: z.uuid().nullish(),
    idempotencyKey,
  })
  .strict();
/** A person's edit: any value (a customer of the draft's branch), at the version they read. */
const updateBody = z
  .object(draftValues)
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
const cashAccountsQuery = z.object({ customerId: z.uuid() }).strict();
const openInvoicesQuery = z
  .object({ customerId: z.uuid(), currency: currencyCode.optional() })
  .strict();

/**
 * Receipt drafts (entry drafts). The staff assistant creates drafts and recovers the one it created
 * under a key; a person reads, approves and rejects them.
 */
@Controller('receipt-drafts')
export class ReceiptDraftsController {
  constructor(private readonly drafts: ReceiptDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('receipts:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<EntryDraftSummaryDto> {
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('receipts:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('receipts:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<EntryDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  /** The cash and bank accounts a receipt for the customer may use (the assistant's pick list). */
  @AgentReadable()
  @Get('cash-accounts')
  @RequirePermission('receipts:create')
  async cashAccounts(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<{ items: ReceiptCashAccountDto[] }> {
    const { customerId } = parse(cashAccountsQuery, query);
    return { items: await this.drafts.cashAccounts(user, customerId) };
  }

  /** The customer's open invoices a receipt may settle (the assistant's pick list). */
  @AgentReadable()
  @Get('open-invoices')
  @RequirePermission('receipts:create')
  async openInvoices(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<{ items: ReceiptOpenInvoiceDto[] }> {
    const { customerId, currency } = parse(openInvoicesQuery, query);
    return { items: await this.drafts.openInvoices(user, customerId, currency) };
  }

  @Get()
  @RequirePermission('receipts:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<ReceiptDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('receipts:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReceiptDraftDto> {
    return this.drafts.get(user, id);
  }

  /** A person fills in or changes the draft's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('receipts:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ReceiptDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('receipts:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ReceiptDraftDto> {
    return this.drafts.approve(user, id, parse(approveBody, body).version);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('receipts:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ReceiptDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }

  /** The chat card's read: only a draft the assistant created for this same user. */
  @AgentReadable()
  @Get(':id/assistant')
  @RequirePermission('receipts:view')
  forAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantDraftDto<ReceiptDraftDto>> {
    return this.drafts.forAssistant(user, id);
  }

  /** The person approves in the assistant's chat (a click, never a model call). */
  @AgentDraftDecidable()
  @Post(':id/assistant-approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('receipts:create')
  approveFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ReceiptDraftDto> {
    return this.drafts.approveFromAssistant(user, id, parse(assistantApproveBody, body));
  }

  /** The person rejects in the assistant's chat. */
  @AgentDraftDecidable()
  @Post(':id/assistant-reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('receipts:create')
  rejectFromAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ReceiptDraftDto> {
    return this.drafts.rejectFromAssistant(user, id, parse(rejectBody, body));
  }
}
