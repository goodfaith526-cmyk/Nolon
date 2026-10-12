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
  NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS,
  type NewCustomerBookingDraftDto,
  type NewCustomerBookingDraftListItemDto,
  type NewCustomerBookingDraftSummaryDto,
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
import { customerFields } from '../customers/customer-schemas.js';
import { confirmedPaths, draftEvidencePaths } from '../drafts/draft-evidence.js';
import { splitReplaced } from '../drafts/drafts.service.js';
import { bookingFields, itemBody } from './bookings.controller.js';
import { NewCustomerBookingDraftsService } from './new-customer-booking-drafts.service.js';

const MAX_ITEMS = 50;
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

// A direct booking without its customer and parties (a new customer has none yet); cargo lines
// without dimensions.
const bookingBody = z
  .object({
    originLocationId: bookingFields.originLocationId,
    destinationLocationId: bookingFields.destinationLocationId,
    mode: bookingFields.mode,
    loadType: bookingFields.loadType,
    cargoType: bookingFields.cargoType,
    cargoDescription: bookingFields.cargoDescription,
    services: bookingFields.services,
    requestedDeparture: bookingFields.requestedDeparture,
    specialInstructions: bookingFields.specialInstructions,
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
          .strict(),
      )
      .min(1)
      .max(MAX_ITEMS),
  })
  .strict();

// The values the assistant binds to the staff member's words: the customer's (kept on the
// customer draft) and the booking's, a line's value by its path.
const CUSTOMER_WORDS: readonly string[] = NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS;
const BOOKING_WORDS = ['originLocationId', 'destinationLocationId'];
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
    customer: customerBody,
    booking: bookingBody,
    evidence: draftEvidencePaths(
      (f) => CUSTOMER_WORDS.includes(f) || BOOKING_WORDS.includes(f) || evidenceLine(f) !== null,
      CUSTOMER_WORDS.length + BOOKING_WORDS.length + 3 * MAX_ITEMS,
    ),
  })
  .strict()
  .refine(
    (body) => body.evidence.every((e) => (evidenceLine(e.field) ?? 0) < body.booking.items.length),
    { message: 'Words for a cargo line the booking does not have', path: ['evidence'] },
  );
const approveBody = z
  .object({ version: z.number().int().min(1), confirmed: confirmedPaths })
  .strict();
const rejectBody = z
  .object({ version: z.number().int().min(1), reason: requiredText(500) })
  .strict();
const listQuery = z.object({ status: z.enum(DRAFT_STATUSES).optional() }).strict();

/**
 * Bookings for a new customer (entry drafts). The staff assistant creates the customer draft and
 * the booking draft in one request, and recovers them under its key; a person approves the
 * customer, then the booking, on the review screens.
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

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:create')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<NewCustomerBookingDraftDto> {
    const { version, confirmed } = parse(approveBody, body);
    return this.drafts.approve(user, id, version, confirmed);
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
