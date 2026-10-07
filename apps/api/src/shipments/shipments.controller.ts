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
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  BOOKING_SERVICES,
  CONTAINER_NUMBER_PATTERN,
  MAX_SHARED_BRANCHES,
  SHIPMENT_STATUSES,
  SHIPPING_MODES,
  type Page,
  type ShipmentDto,
  type ShipmentSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser, RequirePermission } from '../auth/decorators.js';
import { flag, periodFields, periodsInOrder, routeFields } from '../common/list-filters.js';
import { dateString, optionalText, pageQuery, parse, requiredText } from '../common/validation.js';
import { ShipmentsService } from './shipments.service.js';

const shortText = (max: number) => optionalText(max);

const updateBody = z
  .object({
    cargoDescription: optionalText(2000).optional(),
    services: z.array(z.enum(BOOKING_SERVICES)).min(1).max(BOOKING_SERVICES.length).optional(),
    shipperId: z.uuid().nullish(),
    consigneeId: z.uuid().nullish(),
    notifyPartyId: z.uuid().nullish(),
    carrierName: shortText(200).optional(),
    vesselName: shortText(200).optional(),
    voyageNumber: shortText(50).optional(),
    blNumber: shortText(50).optional(),
    etd: dateString.nullish(),
    eta: dateString.nullish(),
    sharedBranchIds: z.array(z.uuid()).max(MAX_SHARED_BRANCHES).optional(),
  })
  .strict();

const statusBody = z
  .object({
    status: z.enum(SHIPMENT_STATUSES),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    locationId: z.uuid().nullish(),
    note: optionalText(1000),
  })
  .strict();

const holdBody = z.object({ reason: requiredText(1000), note: optionalText(1000) }).strict();
const noteBody = z.object({ note: optionalText(1000) }).strict();
const reasonBody = z.object({ reason: requiredText(1000) }).strict();

const containerBody = z
  .object({
    containerNumber: z
      .string()
      .trim()
      .toUpperCase()
      .transform((v) => v.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(CONTAINER_NUMBER_PATTERN, 'Container number: 4 letters and 7 digits')),
    sealNumber: shortText(30),
    containerTypeCode: z.string().trim().toUpperCase().min(1).max(10),
  })
  .strict();

const listQuery = pageQuery
  .extend({
    /** One status, or several separated by commas (any of them). */
    status: z
      .string()
      .transform((v) => [...new Set(v.split(',').map((s) => s.trim()))])
      .pipe(z.array(z.enum(SHIPMENT_STATUSES)).min(1))
      .optional(),
    customerId: z.uuid().optional(),
    activeOnly: flag,
    mode: z.enum(SHIPPING_MODES).optional(),
    ...routeFields,
    branchId: z.uuid().optional(),
    /** Created on (branch-local day). */
    ...periodFields,
    etaFrom: dateString.optional(),
    etaTo: dateString.optional(),
  })
  .superRefine(periodsInOrder(['from', 'to'], ['etaFrom', 'etaTo']));

const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

/**
 * Staff shipment API. Route permissions are the minimum (view or update); the service checks the
 * permission each status change needs (stage permissions, approve, cancel).
 */
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('shipments:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<ShipmentSummaryDto>> {
    return this.shipments.list(user, parse(listQuery, query));
  }

  @Get('by-token/:token')
  @RequirePermission('shipments:view')
  byToken(@CurrentUser() user: AuthUser, @Param('token') token: string): Promise<{ id: string }> {
    return this.shipments.findIdByToken(user, parse(tokenParam, token));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('shipments:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<ShipmentDto> {
    return this.shipments.get(user, id);
  }

  @Get(':id/qr.svg')
  @RequirePermission('shipments:view')
  @Header('Content-Type', 'image/svg+xml')
  @Header('Cache-Control', 'private, no-store')
  qr(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<string> {
    return this.shipments.qrSvg(user, id);
  }

  @Patch(':id')
  @RequirePermission('shipments:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    return this.shipments.update(user, id, parse(updateBody, body));
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:view')
  changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    return this.shipments.changeStatus(user, id, parse(statusBody, body));
  }

  @Post(':id/hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:update')
  hold(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    const { reason, note } = parse(holdBody, body);
    return this.shipments.hold(user, id, reason, note);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:update')
  resume(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    return this.shipments.resume(user, id, parse(noteBody, body).note);
  }

  @Post(':id/revert')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:approve')
  revert(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    return this.shipments.revert(user, id, parse(reasonBody, body).reason);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shipments:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    return this.shipments.cancel(user, id, parse(reasonBody, body).reason);
  }

  @Post(':id/containers')
  @RequirePermission('shipments:update')
  addContainer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    return this.shipments.addContainer(user, id, parse(containerBody, body));
  }

  @Put(':id/containers/:containerId')
  @RequirePermission('shipments:update')
  updateContainer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('containerId', ParseUUIDPipe) containerId: string,
    @Body() body: unknown,
  ): Promise<ShipmentDto> {
    return this.shipments.updateContainer(user, id, containerId, parse(containerBody, body));
  }

  @Delete(':id/containers/:containerId')
  @RequirePermission('shipments:update')
  removeContainer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('containerId', ParseUUIDPipe) containerId: string,
  ): Promise<ShipmentDto> {
    return this.shipments.removeContainer(user, id, containerId);
  }
}
