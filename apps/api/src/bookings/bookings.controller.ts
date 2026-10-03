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
  BOOKING_STATUSES,
  CARGO_TYPES,
  LOAD_TYPES,
  SHIPPING_MODES,
  type BookingDto,
  type BookingSummaryDto,
  type Page,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import {
  dateString,
  optionalText,
  pageQuery,
  parse,
  quantity as positiveDecimal,
  requiredText,
} from '../common/validation.js';
import { BookingsService } from './bookings.service.js';

const measure = z.string().regex(/^\d{1,8}(\.\d{1,3})?$/, 'Invalid measurement');

const itemBody = z
  .object({
    cargoType: z.enum(CARGO_TYPES),
    containerTypeCode: z.string().trim().toUpperCase().max(10).nullish(),
    description: optionalText(500),
    quantity: z.number().int().min(1).max(100_000),
    lengthCm: positiveDecimal.nullish(),
    widthCm: positiveDecimal.nullish(),
    heightCm: positiveDecimal.nullish(),
    weightKg: measure.nullish(),
    volumeCbm: measure.nullish(),
  })
  .strict();

const partyRefs = {
  shipperId: z.uuid().nullish(),
  consigneeId: z.uuid().nullish(),
  notifyPartyId: z.uuid().nullish(),
};

const services = z.array(z.enum(BOOKING_SERVICES)).min(1).max(BOOKING_SERVICES.length);
const items = z.array(itemBody).max(100);

const bookingFields = {
  originLocationId: z.uuid(),
  destinationLocationId: z.uuid(),
  mode: z.enum(SHIPPING_MODES),
  loadType: z.enum(LOAD_TYPES).nullish(),
  cargoType: z.enum(CARGO_TYPES),
  cargoDescription: optionalText(2000),
  services,
  ...partyRefs,
  requestedDeparture: dateString.nullish(),
  specialInstructions: optionalText(2000),
  items,
};

const createBody = z.object({ customerId: z.uuid(), ...bookingFields }).strict();
const updateBody = z.object(bookingFields).strict();
const fromQuotationBody = z
  .object({
    services: services.optional(),
    ...partyRefs,
    requestedDeparture: dateString.nullish(),
    specialInstructions: optionalText(2000),
    items: items.optional(),
  })
  .strict();
const reasonBody = z.object({ reason: requiredText(1000) }).strict();
const listQuery = pageQuery.extend({
  status: z.enum(BOOKING_STATUSES).optional(),
  customerId: z.uuid().optional(),
});

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @RequirePermission('bookings:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<BookingSummaryDto>> {
    return this.bookings.list(user, parse(listQuery, query));
  }

  @Get(':id')
  @RequirePermission('bookings:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<BookingDto> {
    return this.bookings.get(user, id);
  }

  @Post()
  @RequirePermission('bookings:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<BookingDto> {
    return this.bookings.create(user, parse(createBody, body));
  }

  @Post('from-quotation/:quotationId')
  @RequirePermission('bookings:create')
  createFromQuotation(
    @CurrentUser() user: AuthUser,
    @Param('quotationId', ParseUUIDPipe) quotationId: string,
    @Body() body: unknown,
  ): Promise<BookingDto> {
    return this.bookings.createFromQuotation(user, quotationId, parse(fromQuotationBody, body));
  }

  @Patch(':id')
  @RequirePermission('bookings:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BookingDto> {
    return this.bookings.update(user, id, parse(updateBody, body));
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:approve')
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingDto> {
    return this.bookings.confirm(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bookings:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BookingDto> {
    return this.bookings.cancel(user, id, parse(reasonBody, body).reason);
  }
}
