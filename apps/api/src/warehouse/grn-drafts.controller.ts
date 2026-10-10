import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  GRN_DRAFT_LINE_FIELDS,
  GRN_DRAFT_MAX_LINES,
  GRN_DRAFT_WARNINGS,
  GRN_FIELD_MATCHES,
  type GrnDraftDto,
  type GrnDraftSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import {
  AgentDraftWritable,
  AgentReadable,
  CurrentUser,
  RequirePermission,
} from '../auth/decorators.js';
import { parse, requiredText } from '../common/validation.js';
import { GrnDraftsService } from './grn-drafts.service.js';
import { receiptBody } from './warehouse.controller.js';

/** Free text read from a document: trimmed, no control characters, empty becomes null. */
function lineText(max: number) {
  return (
    z
      .string()
      .trim()
      .max(max)
      // eslint-disable-next-line no-control-regex -- refusing control characters is the point here.
      .regex(/^[^\u0000-\u001f\u007f]*$/, 'Control characters are not allowed')
      .nullish()
      .transform((v) => (v ? v : null))
  );
}

/** Non-negative, at most 9 integer and 3 decimal digits (Decimal(12, 3)). */
const kg = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Invalid number')
  .nullish()
  .transform((v) => v ?? null);

/** Non-negative, at most 11 integer and 3 decimal digits (Decimal(14, 3)). */
const qty = z
  .string()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Invalid quantity')
  .nullish()
  .transform((v) => v ?? null);

const count = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .nullish()
  .transform((v) => v ?? null);

const position = (max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .nullish()
    .transform((v) => v ?? null);

const lineValues = {
  marks: lineText(200),
  description: lineText(500),
  packageCount: count,
  packageType: lineText(50),
  quantity: qty,
  unit: lineText(20),
  grossKg: kg,
  netKg: kg,
  cbm: kg,
};

function hasAValue(line: Record<string, unknown>): boolean {
  return GRN_DRAFT_LINE_FIELDS.some((field) => line[field] !== null);
}

const matchMap = z
  .object(Object.fromEntries(GRN_DRAFT_LINE_FIELDS.map((f) => [f, z.enum(GRN_FIELD_MATCHES)])))
  .partial()
  .strict();

const createBody = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/, 'Invalid idempotency key'),
    documentId: z.uuid(),
    documentSha256: z.string().regex(/^[0-9a-f]{64}$/, 'Invalid sha256'),
    statedTotals: z
      .object({ packages: count, grossKg: kg, netKg: kg, cbm: kg })
      .strict()
      .default({ packages: null, grossKg: null, netKg: null, cbm: null }),
    warnings: z.array(z.enum(GRN_DRAFT_WARNINGS)).max(GRN_DRAFT_WARNINGS.length).default([]),
    lines: z
      .array(
        z
          .object({
            ...lineValues,
            sourcePage: position(10_000),
            sourceRow: position(1_000_000),
            match: matchMap.optional(),
          })
          .strict()
          .refine(hasAValue, 'A line needs at least one value'),
      )
      .min(1)
      .max(GRN_DRAFT_MAX_LINES),
  })
  .strict();

const updateBody = z
  .object({
    version: z.number().int().min(1),
    lines: z
      .array(
        z
          .object({
            ...lineValues,
            lineNo: z.number().int().min(1).max(GRN_DRAFT_MAX_LINES).optional(),
          })
          .strict()
          .refine(hasAValue, 'A line needs at least one value'),
      )
      .min(1)
      .max(GRN_DRAFT_MAX_LINES),
  })
  .strict();

const approveBody = receiptBody.extend({ version: z.number().int().min(1) }).strict();

const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();

const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/);

/**
 * Draft GRNs of a shipment (Document Pilot). The staff assistant creates drafts and recovers the
 * one it created under a key; a person reads, edits, approves and rejects them.
 */
@Controller('shipments/:shipmentId/grn-drafts')
export class GrnDraftsController {
  constructor(private readonly drafts: GrnDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('warehouse:create', 'documents:view')
  create(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() body: unknown,
  ): Promise<GrnDraftSummaryDto> {
    return this.drafts.create(user, shipmentId, parse(createBody, body));
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('warehouse:create', 'documents:view')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('key') key: string,
  ): Promise<GrnDraftSummaryDto> {
    return this.drafts.findByKey(user, shipmentId, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('warehouse:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<GrnDraftSummaryDto[]> {
    return this.drafts.list(user, shipmentId);
  }

  @Get(':draftId')
  @RequirePermission('warehouse:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
  ): Promise<GrnDraftDto> {
    return this.drafts.get(user, shipmentId, draftId);
  }

  @Patch(':draftId')
  @RequirePermission('warehouse:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() body: unknown,
  ): Promise<GrnDraftDto> {
    return this.drafts.update(user, shipmentId, draftId, parse(updateBody, body));
  }

  @Post(':draftId/approve')
  @RequirePermission('warehouse:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() body: unknown,
  ): Promise<GrnDraftDto> {
    return this.drafts.approve(user, shipmentId, draftId, parse(approveBody, body));
  }

  @Post(':draftId/reject')
  @RequirePermission('warehouse:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() body: unknown,
  ): Promise<GrnDraftDto> {
    return this.drafts.reject(user, shipmentId, draftId, parse(rejectBody, body));
  }
}
