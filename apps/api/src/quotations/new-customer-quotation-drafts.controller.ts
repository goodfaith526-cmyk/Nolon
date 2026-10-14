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
  type DraftPreCheckDto,
  NEW_CUSTOMER_QUOTATION_CUSTOMER_FIELDS,
  type NewCustomerQuotationDraftDto,
  type NewCustomerQuotationDraftListItemDto,
  type NewCustomerQuotationDraftSummaryDto,
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
import { parse, requiredText } from '../common/validation.js';
import { customerFields } from '../customers/customer-schemas.js';
import { confirmedPaths, draftEvidencePaths } from '../drafts/draft-evidence.js';
import { preCheckBody } from '../drafts/draft-rules.js';
import { checkRequest, splitReplaced } from '../drafts/drafts.service.js';
import { NewCustomerQuotationDraftsService } from './new-customer-quotation-drafts.service.js';
import { quotationInputBody } from './quotations.controller.js';

const MAX_LINES = 50;
const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');

// The contact details a person gives in a chat; terms, credit and tax details are set later.
const customerBody = z
  .object({
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

// The values the assistant binds to the staff member's words: the customer's and the
// quotation's, a line's value by its path.
const CUSTOMER_WORDS: readonly string[] = NEW_CUSTOMER_QUOTATION_CUSTOMER_FIELDS;
const QUOTATION_WORDS = ['originLocationId', 'destinationLocationId'];
const LINE_WORDS = /^lines\[(\d{1,2})\]\.(quantity|unitPrice|discount)$/;

/** The line a path names (`lines[3].unitPrice` is line 3), or null for a field of the header. */
export function evidenceLine(field: string): number | null {
  const match = LINE_WORDS.exec(field);
  return match ? Number(match[1]) : null;
}

const createBody = z
  .object({
    idempotencyKey,
    branchId: z.uuid(),
    customer: customerBody,
    quotation: quotationInputBody,
    evidence: draftEvidencePaths(
      (f) => CUSTOMER_WORDS.includes(f) || QUOTATION_WORDS.includes(f) || evidenceLine(f) !== null,
      CUSTOMER_WORDS.length + QUOTATION_WORDS.length + 3 * MAX_LINES,
    ),
  })
  .strict()
  .refine(
    (body) =>
      body.evidence.every((e) => (evidenceLine(e.field) ?? 0) < body.quotation.lines.length),
    { message: 'Words for a line the quotation does not have', path: ['evidence'] },
  );
const approveBody = z
  .object({
    version: z.number().int().min(1),
    pricingKey: z.string().regex(/^[0-9a-f]{64}$/),
    confirmed: confirmedPaths,
  })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Quotations for a new customer (entry drafts). The staff assistant creates a draft holding the
 * customer and the quotation, and recovers it under its key; a person approves it on the review
 * screen, which creates both.
 */
@Controller('new-customer-quotation-drafts')
export class NewCustomerQuotationDraftsController {
  constructor(private readonly drafts: NewCustomerQuotationDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('quotations:create', 'customers:create')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<NewCustomerQuotationDraftSummaryDto> {
    // replacesDraftId: the draft this one replaces, when the person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:create', 'customers:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('quotations:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<NewCustomerQuotationDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('quotations:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<NewCustomerQuotationDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('quotations:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NewCustomerQuotationDraftDto> {
    return this.drafts.get(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:create', 'customers:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<NewCustomerQuotationDraftDto> {
    const { version, pricingKey, confirmed } = parse(approveBody, body);
    return this.drafts.approve(user, id, version, pricingKey, confirmed);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quotations:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<NewCustomerQuotationDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
