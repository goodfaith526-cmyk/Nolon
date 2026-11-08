import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { PALLET_STATUSES, type Page, type PalletDto, type PalletSummaryDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { optionalText, pageQuery, parse, requiredText } from '../common/validation.js';
import { PalletsService } from './pallets.service.js';

const listQuery = pageQuery.extend({
  status: z.enum(PALLET_STATUSES).optional(),
  branchId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
});
const createBody = z
  .object({ warehouseId: z.uuid(), notes: optionalText(500).optional() })
  .strict();
const shipmentBody = z.object({ shipmentId: z.uuid() }).strict();
const containerBody = z.object({ consolidationId: z.uuid() }).strict();
const tripBody = z.object({ tripId: z.uuid() }).strict();
const reasonBody = z.object({ reason: requiredText(500) }).strict();

/**
 * Plan 15-3: pallets, whole shipments wrapped together and moved as one piece (PALLETS_ENABLED).
 * Warehouse permissions on the pallet's branch; a container or trip also needs its own.
 */
@Controller('pallets')
export class PalletsController {
  constructor(private readonly pallets: PalletsService) {}

  @Get()
  @RequirePermission('warehouse:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<PalletSummaryDto>> {
    return this.pallets.list(user, parse(listQuery, query));
  }

  @Get(':id')
  @RequirePermission('warehouse:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PalletDto> {
    return this.pallets.get(user, id);
  }

  @Get(':id/qr.svg')
  @RequirePermission('warehouse:view')
  @Header('Content-Type', 'image/svg+xml')
  @Header('Cache-Control', 'private, no-store')
  qr(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<string> {
    return this.pallets.qrSvg(user, id);
  }

  @Post()
  @RequirePermission('warehouse:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<PalletDto> {
    return this.pallets.create(user, parse(createBody, body));
  }

  @Post(':id/shipments')
  @RequirePermission('warehouse:update')
  addShipment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PalletDto> {
    return this.pallets.addShipment(user, id, parse(shipmentBody, body).shipmentId);
  }

  @Delete(':id/shipments/:shipmentId')
  @RequirePermission('warehouse:update')
  removeShipment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<PalletDto> {
    return this.pallets.removeShipment(user, id, shipmentId);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:update')
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PalletDto> {
    return this.pallets.close(user, id);
  }

  @Post(':id/container')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:update', 'consolidation:update')
  putInContainer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PalletDto> {
    return this.pallets.putInContainer(user, id, parse(containerBody, body).consolidationId);
  }

  @Post(':id/trip')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:update', 'transport_trips:update')
  putOnTrip(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PalletDto> {
    return this.pallets.putOnTrip(user, id, parse(tripBody, body).tripId);
  }

  /** The whole pallet out of its open container or off its planned trip. */
  @Post(':id/take-out')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:update')
  takeOut(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PalletDto> {
    return this.pallets.takeOut(user, id);
  }

  @Post(':id/unpack')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:update')
  unpack(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PalletDto> {
    return this.pallets.unpack(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('warehouse:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PalletDto> {
    return this.pallets.cancel(user, id, parse(reasonBody, body).reason);
  }
}
