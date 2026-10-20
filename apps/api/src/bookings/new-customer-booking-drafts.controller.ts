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
  BOOKING_SERVICES,
  DRAFT_IDEMPOTENCY_KEY_PATTERN,
  DRAFT_STATUSES,
  type DraftPreCheckDto,
  NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS,
  type NewCustomerBookingDraftDto,
  type NewCustomerBookingDraftListItemDto,
  type NewCustomerBookingDraftSummaryDto,
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
import { customerDraftFields } from '../customers/customer-schemas.js';
import { confirmedFields, confirmedPaths, draftEvidencePaths } from '../drafts/draft-evidence.js';
import { checkRequest, splitReplaced } from '../drafts/drafts.service.js';
import { bookingFields, itemBody } from './bookings.controller.js';
import { NewCustomerBookingDraftsService } from './new-customer-booking-drafts.service.js';
import { preCheckBody } from '../drafts/draft-rules.js';

const MAX_ITEMS = 50;
const idempotencyKey = z.string().regex(DRAFT_IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');

// The contact details a person gives in a chat (customerDraftFields), and a direct booking
// without its customer and parties (a new customer has none yet), cargo lines without
// dimensions: each value checked as a customer's or a booking's when given, none required (owner
// decision, 2026-10-17). The branch is security context, always named (one of the user's).
const customerBody = z.object(customerDraftFields).strict();
const bookingValues = {
  originLocationId: bookingFields.originLocationId.nullish(),
  destinationLocationId: bookingFields.destinationLocationId.nullish(),
  mode: bookingFields.mode.nullish(),
  loadType: bookingFields.loadType,
  cargoType: bookingFields.cargoType.nullish(),
  cargoDescription: bookingFields.cargoDescription,
  services: z.array(z.enum(BOOKING_SERVICES)).max(BOOKING_SERVICES.length),
  requestedDeparture: bookingFields.requestedDeparture,
  specialInstructions: bookingFields.specialInstructions,
  // An open container the booking goes in on approval (confirmed, its shipment added).
  consolidationId: z.uuid().nullish(),
  items: z
    .array(
      itemBody
        .pick({
          cargoType: true,
          containerTypeCode: true,
          description: true,
          quantity: true,
          weightKg: true,
          volumeCbm: true,
        })
        .extend({
          cargoType: itemBody.shape.cargoType.nullish(),
          quantity: itemBody.shape.quantity.nullish(),
        })
        .strict(),
    )
    .max(MAX_ITEMS),
};
const bookingBody = z
  .object({
    ...bookingValues,
    services: bookingValues.services.optional(),
    items: bookingValues.items.optional(),
  })
  .strict();

// The values the assistant binds to the staff member's words: the customer's (kept on the
// customer draft) and the booking's, a line's value by its path.
const CUSTOMER_WORDS: readonly string[] = NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS;
const BOOKING_WORDS = ['originLocationId', 'destinationLocationId', 'consolidationId'];
const LINE_WORDS = /^items\[(\d{1,2})\]\.(quantity|weightKg|volumeCbm)$/;

/** The line a path names (`items[3].weightKg` is line 3), or null for a field of the header. */
export function evidenceLine(field: string): number | null {
  const match = LINE_WORDS.exec(field);
  return match ? Number(match[1]) : null;
}

const createBody = z
  .object({
    idempotencyKey,
    branchId: z.uuid(),
    customer: customerBody.optional(),
    booking: bookingBody.optional(),
    evidence: draftEvidencePaths(
      (f) => CUSTOMER_WORDS.includes(f) || BOOKING_WORDS.includes(f) || evidenceLine(f) !== null,
      CUSTOMER_WORDS.length + BOOKING_WORDS.length + 3 * MAX_ITEMS,
    ),
  })
  .strict()
  .refine(
    (body) =>
      body.evidence.every((e) => {
        const line = evidenceLine(e.field);
        return line === null || line < (body.booking?.items?.length ?? 0);
      }),
    { message: 'Words for a cargo line the booking does not have', path: ['evidence'] },
  );
/** A person's edit of the booking's values, at the version they read; the branch stays. */
const updateBody = z
  .object(bookingValues)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict();
const approveBody = z
  .object({
    version: z.number().int().min(1),
    confirmed: confirmedPaths,
    // The customer draft approved in the same step: the version the person reviewed and their
    // ticks of its words (as POST /customer-drafts/:id/approve takes them). Left out, the
    // customer draft must be approved first, on its own screen.
    customer: z
      .object({ version: z.number().int().min(1), confirmed: confirmedFields })
      .strict()
      .optional(),
  })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Bookings for a new customer (entry drafts). The staff assistant creates the customer draft and
 * the booking draft in one request, and recovers them under its key; a person approves the
 * customer, then the booking, on the review screens, or both at once from the booking's.
 */
@Controller('new-customer-booking-drafts')
export class NewCustomerBookingDraftsController {
  constructor(private readonly drafts: NewCustomerBookingDraftsService) {}

  @AgentDraftWritable()
  @Post()
  @RequirePermission('bookings:create', 'customers:create')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<NewCustomerBookingDraftSummaryDto> {
    // replacesDraftId: the booking draft (with its customer draft) this pair replaces, when the
    // person asked for changes.
    const { replacesDraftId, rest } = splitReplaced(body);
    return this.drafts.create(user, parse(createBody, rest), replacesDraftId);
  }

  /** What a create with these values would get now; nothing is written. */
  @AgentDraftCheckable()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create', 'customers:create')
  check(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DraftPreCheckDto> {
    return preCheckBody(createBody, checkRequest(body), (input) =>
      this.drafts.checkValues(user, input),
    );
  }

  @AgentReadable()
  @Get('by-key/:key')
  @RequirePermission('bookings:create')
  findByKey(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
  ): Promise<NewCustomerBookingDraftSummaryDto> {
    return this.drafts.findByKey(user, parse(idempotencyKey, key));
  }

  @Get()
  @RequirePermission('bookings:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<NewCustomerBookingDraftListItemDto[]> {
    return this.drafts.list(user, parse(listQuery, query).status);
  }

  @Get(':id')
  @RequirePermission('bookings:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NewCustomerBookingDraftDto> {
    return this.drafts.get(user, id);
  }

  /** A person fills in or changes the booking's values (the review screen's form). */
  @Patch(':id')
  @RequirePermission('bookings:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<NewCustomerBookingDraftDto> {
    return this.drafts.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<NewCustomerBookingDraftDto> {
    const { version, confirmed, customer } = parse(approveBody, body);
    return this.drafts.approve(user, id, version, confirmed, customer ?? null);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<NewCustomerBookingDraftDto> {
    return this.drafts.reject(user, id, parse(rejectBody, body));
  }
}
