import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { WINDOW_DESK_FILTERS, type WindowDeskBookingDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, OutletScoped, RequirePermission } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
import { WindowDeskService } from './window-desk.service.js';

const expectedQuery = z
  .object({
    status: z.enum(WINDOW_DESK_FILTERS).default('expected'),
    q: z.string().trim().max(50).optional(),
  })
  .strict();

/** Plan 13 section 2: a partner outlet's window desk (Outlet Staff only, WINDOW_DESK_ENABLED). */
@Controller('window-desk')
export class WindowDeskController {
  constructor(private readonly desk: WindowDeskService) {}

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
}
