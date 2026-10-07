import {
  Body,
  Controller,
  Delete,
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
  CONSOLIDATION_BASES,
  CONSOLIDATION_MOVES,
  CONSOLIDATION_STATUSES,
  CONTAINER_NUMBER_PATTERN,
  type BillableConsolidationDto,
  type ConsolidationDto,
  type ConsolidationSummaryDto,
  type Page,
  type ShipmentConsolidationDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import { dateString, optionalText, pageQuery, parse, requiredText } from '../common/validation.js';
import { ConsolidationsService, MAX_CONTAINER_SHIPMENTS } from './consolidations.service.js';

const containerNumber = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(CONTAINER_NUMBER_PATTERN, 'Container number: 4 letters and 7 digits'))
  .nullable();

const containerType = z.string().trim().toUpperCase().min(1).max(10);

const detailFields = {
  containerNumber: containerNumber.optional(),
  sealNumber: optionalText(30).optional(),
  carrierName: optionalText(200).optional(),
  vesselName: optionalText(200).optional(),
  voyageNumber: optionalText(50).optional(),
  masterBlNumber: optionalText(50).optional(),
  etd: dateString.nullish(),
  eta: dateString.nullish(),
  basis: z.enum(CONSOLIDATION_BASES).optional(),
  notes: optionalText(2000).optional(),
};

const createBody = z
  .object({
    branchId: z.uuid(),
    originLocationId: z.uuid(),
    destinationLocationId: z.uuid(),
    containerTypeCode: containerType,
    ...detailFields,
    shipmentIds: z.array(z.uuid()).max(MAX_CONTAINER_SHIPMENTS),
  })
  .strict();

const updateBody = z
  .object({ containerTypeCode: containerType.optional(), ...detailFields })
  .strict();

const listQuery = pageQuery.extend({ status: z.enum(CONSOLIDATION_STATUSES).optional() });
const moveBody = z
  .object({
    status: z.enum(CONSOLIDATION_MOVES),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const reasonBody = z.object({ reason: requiredText(1000) }).strict();
const addShipmentBody = z.object({ shipmentId: z.uuid() }).strict();
const billableQuery = z.object({ branchId: z.uuid().optional() }).strict();

/** Consolidated (LCL) containers: their shipments and status (annex B, consolidation). */
@Controller('consolidations')
export class ConsolidationsController {
  constructor(private readonly consolidations: ConsolidationsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('consolidation:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<Page<ConsolidationSummaryDto>> {
    return this.consolidations.list(user, parse(listQuery, query));
  }

  /** Containers a supplier bill may charge, for the bill form. */
  @Get('billable')
  @RequirePermission('suppliers:create')
  billable(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<BillableConsolidationDto[]> {
    return this.consolidations.billable(user, parse(billableQuery, query).branchId);
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('consolidation:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsolidationDto> {
    return this.consolidations.get(user, id);
  }

  @Post()
  @RequirePermission('consolidation:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<ConsolidationDto> {
    return this.consolidations.create(user, parse(createBody, body));
  }

  @Patch(':id')
  @RequirePermission('consolidation:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConsolidationDto> {
    return this.consolidations.update(user, id, parse(updateBody, body));
  }

  @Post(':id/shipments')
  @RequirePermission('consolidation:update')
  addShipment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConsolidationDto> {
    return this.consolidations.addShipment(user, id, parse(addShipmentBody, body).shipmentId);
  }

  @Delete(':id/shipments/:shipmentId')
  @RequirePermission('consolidation:update')
  removeShipment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<ConsolidationDto> {
    return this.consolidations.removeShipment(user, id, shipmentId);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('consolidation:update')
  move(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConsolidationDto> {
    return this.consolidations.move(user, id, parse(moveBody, body));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('consolidation:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConsolidationDto> {
    return this.consolidations.cancel(user, id, parse(reasonBody, body).reason);
  }
}

/** The containers of a shipment, on the shipment page. */
@Controller('shipments/:shipmentId/consolidations')
export class ShipmentConsolidationsController {
  constructor(private readonly consolidations: ConsolidationsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('shipments:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<ShipmentConsolidationDto[]> {
    return this.consolidations.forShipment(user, shipmentId);
  }
}
