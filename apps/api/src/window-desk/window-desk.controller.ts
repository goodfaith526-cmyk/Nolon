import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  WINDOW_DESK_FILTERS,
  type WindowDeskBookingDto,
  type WindowDeskReferrerDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, OutletScoped, RequirePermission } from '../auth/decorators.js';
import { amount, currencyCode, optionalText, parse } from '../common/validation.js';
import { receiptBody } from '../warehouse/warehouse.controller.js';
import { WindowCollectService } from './window-collect.service.js';
import { WindowDeskService } from './window-desk.service.js';

const expectedQuery = z
  .object({
    status: z.enum(WINDOW_DESK_FILTERS).default('expected'),
    q: z.string().trim().max(50).optional(),
  })
  .strict();

/**
 * Plan 13 section 3: the goods receipt body without the warehouse, its storage location or the
 * status (the booking's window, and RECEIVED_ORIGIN_WAREHOUSE when the state machine allows it).
 */
const windowReceiptBody = receiptBody
  .omit({ warehouseId: true, storageLocationId: true, shipmentStatus: true })
  .extend({ broughtByReferrerId: z.uuid().nullish() })
  .strict();

/** Plan 18, 4.3: the brokers to pick from, by name or phone. */
const referrersQuery = z.object({ q: optionalText(60) }).strict();

/** Plan 13 section 4: what the window took; the server allocates it (F202-2). */
const paymentBody = z
  .object({
    requestId: z.uuid(),
    amount,
    currency: currencyCode,
    reference: optionalText(100),
  })
  .strict();

/** Plan 13 section 2: a partner outlet's window desk (Outlet Staff only, WINDOW_DESK_ENABLED). */
@Controller('window-desk')
export class WindowDeskController {
  constructor(
    private readonly desk: WindowDeskService,
    private readonly collector: WindowCollectService,
  ) {}

  @OutletScoped()
  @Get('expected')
  @RequirePermission('window_desk:view')
  expected(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<WindowDeskBookingDto[]> {
    const { status, q } = parse(expectedQuery, query);
    return this.desk.expected(user, status, q);
  }

  @OutletScoped()
  @Get('bookings/:id')
  @RequirePermission('window_desk:view')
  booking(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WindowDeskBookingDto> {
    return this.desk.booking(user, id);
  }

  @OutletScoped()
  @Post('bookings/:id/receipt')
  @RequirePermission('window_desk:create')
  receive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WindowDeskBookingDto> {
    return this.desk.receive(user, id, parse(windowReceiptBody, body));
  }

  @OutletScoped()
  @Get('bookings/:id/referrers')
  @RequirePermission('window_desk:create')
  referrers(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<WindowDeskReferrerDto[]> {
    return this.desk.referrers(user, id, parse(referrersQuery, query).q ?? null);
  }

  @OutletScoped()
  @Post('bookings/:id/payment')
  @RequirePermission('window_desk:update')
  collect(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WindowDeskBookingDto> {
    return this.collector.collect(user, id, parse(paymentBody, body));
  }
}
