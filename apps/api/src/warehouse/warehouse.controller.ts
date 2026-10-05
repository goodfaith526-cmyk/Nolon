import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  GOODS_CONDITIONS,
  MAX_DOCUMENT_BYTES,
  WAREHOUSE_RECEIPT_STATUSES,
  type ShipmentWarehouseDto,
  type WarehouseDto,
  type WarehouseMovementDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { optionalText, parse, requiredText } from '../common/validation.js';
import { WarehouseMovementsService } from './warehouse-movements.service.js';
import { WarehousesService } from './warehouses.service.js';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/)
  .max(20);

const warehouseBody = z
  .object({
    branchId: z.uuid(),
    code,
    nameEn: requiredText(200),
    nameAr: requiredText(200),
    address: optionalText(500),
  })
  .strict();

const warehouseUpdateBody = z
  .object({
    nameEn: requiredText(200).optional(),
    nameAr: requiredText(200).optional(),
    address: optionalText(500).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const locationBody = z.object({ code, name: optionalText(200) }).strict();

const locationUpdateBody = z
  .object({ name: optionalText(200).optional(), isActive: z.boolean().optional() })
  .strict();

/** Whole packages, at least one. */
const packages = z.number().int().min(1).max(1_000_000);

/** Kilograms: non-negative, at most 9 integer and 3 decimal digits (Decimal(12, 3)). */
const weightKg = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Invalid weight')
  .nullish();

const receiptBody = z
  .object({
    warehouseId: z.uuid(),
    storageLocationId: z.uuid().nullish(),
    packages,
    weightKg,
    condition: z.enum(GOODS_CONDITIONS),
    partyName: optionalText(200),
    note: optionalText(1000),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    shipmentStatus: z.enum(WAREHOUSE_RECEIPT_STATUSES).nullish(),
    extraPackagesConfirmed: z.boolean().optional(),
  })
  .strict();

const releaseBody = z
  .object({
    warehouseId: z.uuid(),
    packages,
    weightKg,
    partyName: optionalText(200),
    note: optionalText(1000),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const photoBody = z
  .object({ fileName: z.string().trim().max(255).optional(), note: optionalText(1000) })
  .strict();

/** The part of a multer file this controller uses (kept in memory, never written to disk). */
interface UploadedPart {
  originalname: string;
  buffer: Buffer;
}

/** Warehouses and their storage locations, per branch. */
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @RequirePermission('warehouse:view')
  list(@CurrentUser() user: AuthUser): Promise<WarehouseDto[]> {
    return this.warehouses.list(user);
  }

  @Post()
  @RequirePermission('warehouse:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<WarehouseDto> {
    return this.warehouses.create(user, parse(warehouseBody, body));
  }

  @Patch(':id')
  @RequirePermission('warehouse:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WarehouseDto> {
    return this.warehouses.update(user, id, parse(warehouseUpdateBody, body));
  }

  @Post(':id/locations')
  @RequirePermission('warehouse:update')
  addLocation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WarehouseDto> {
    return this.warehouses.addLocation(user, id, parse(locationBody, body));
  }

  @Patch(':id/locations/:locationId')
  @RequirePermission('warehouse:update')
  updateLocation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() body: unknown,
  ): Promise<WarehouseDto> {
    return this.warehouses.updateLocation(user, id, locationId, parse(locationUpdateBody, body));
  }
}

/** A shipment's goods receipts, releases and movement log. */
@Controller('shipments/:shipmentId/warehouse')
export class ShipmentWarehouseController {
  constructor(private readonly movements: WarehouseMovementsService) {}

  @Get()
  @RequirePermission('warehouse:view')
  view(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<ShipmentWarehouseDto> {
    return this.movements.view(user, shipmentId);
  }

  @Post('receipts')
  @RequirePermission('warehouse:create')
  receive(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() body: unknown,
  ): Promise<WarehouseMovementDto> {
    return this.movements.receive(user, shipmentId, parse(receiptBody, body));
  }

  @Post('releases')
  @RequirePermission('warehouse:create')
  release(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() body: unknown,
  ): Promise<WarehouseMovementDto> {
    return this.movements.release(user, shipmentId, parse(releaseBody, body));
  }

  @Post('movements/:movementId/photos')
  @RequirePermission('warehouse:create', 'documents:create')
  @UseInterceptors(
    FileInterceptor('file', {
      // One more byte than allowed, so an oversized file is rejected rather than truncated.
      limits: { fileSize: MAX_DOCUMENT_BYTES + 1, files: 1, fields: 3, parts: 4 },
    }),
  )
  addPhoto(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('movementId', ParseUUIDPipe) movementId: string,
    @UploadedFile() file: UploadedPart | undefined,
    @Body() body: unknown,
  ): Promise<WarehouseMovementDto> {
    if (!file) throw new BadRequestException('Attach a photo');
    const fields = parse(photoBody, body);
    return this.movements.addPhoto(user, shipmentId, movementId, {
      fileName: fields.fileName || file.originalname,
      note: fields.note,
      data: file.buffer,
    });
  }
}
