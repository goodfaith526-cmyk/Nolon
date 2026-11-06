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
  SHIPMENT_REASON_MIN_LENGTH,
  WAREHOUSE_RECEIPT_STATUSES,
  type ShipmentWarehouseDto,
  type WarehouseDto,
  type WarehouseMovementDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import { optionalText, parse, phone, requiredText } from '../common/validation.js';
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
    locationId: z.uuid().nullish(),
  })
  .strict();

/** A WGS 84 coordinate in degrees, up to 6 decimals, within ±limit. */
const degrees = (limit: number) =>
  z
    .string()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, 'Degrees, up to 6 decimals')
    .refine((v) => Math.abs(Number(v)) <= limit, `Within ±${limit} degrees`);

const warehouseUpdateBody = z
  .object({
    nameEn: requiredText(200).optional(),
    nameAr: requiredText(200).optional(),
    address: optionalText(500).optional(),
    locationId: z.uuid().nullish(),
    isActive: z.boolean().optional(),
    // Plan 09 section 11: the drop-off details the bot names on approval.
    addressEn: optionalText(500).optional(),
    acceptsDropOff: z.boolean().optional(),
    partnerId: z.uuid().nullish(),
    mapUrl: z
      .url({ protocol: /^https$/ })
      .max(500)
      .nullish(),
    hoursAr: optionalText(200).optional(),
    hoursEn: optionalText(200).optional(),
    phone: phone.nullish(),
    latitude: degrees(90).nullish(),
    longitude: degrees(180).nullish(),
  })
  .strict();

/** B3-1: why a receipt or release is cancelled (3 to 500 characters, as the cancellation keeps). */
const cancelBody = z
  .object({ reason: requiredText(500).pipe(z.string().min(SHIPMENT_REASON_MIN_LENGTH)) })
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

/** CBM: non-negative, at most 8 integer and 4 decimal digits (Decimal(12, 4)). */
const volumeCbm = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,4})?$/, 'Invalid volume')
  .nullish();

export const receiptBody = z
  .object({
    warehouseId: z.uuid(),
    storageLocationId: z.uuid().nullish(),
    packages,
    weightKg,
    volumeCbm,
    condition: z.enum(GOODS_CONDITIONS),
    partyName: optionalText(200),
    // Plan 09e section 4: the ID the person handing over showed, as typed (free text).
    partyIdType: optionalText(50),
    partyIdNumber: optionalText(50),
    note: optionalText(1000),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    shipmentStatus: z.enum(WAREHOUSE_RECEIPT_STATUSES).nullish(),
    extraPackagesConfirmed: z.boolean().optional(),
  })
  .strict();

export const releaseBody = z
  .object({
    warehouseId: z.uuid(),
    packages,
    weightKg,
    partyName: optionalText(200),
    note: optionalText(1000),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    // Plan 12 section 3: checked by the service (permission, length).
    paymentOverrideReason: optionalText(1000),
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

  @AgentReadable()
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

  @AgentReadable()
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

  @Post('movements/:movementId/cancel')
  @RequirePermission('warehouse:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('movementId', ParseUUIDPipe) movementId: string,
    @Body() body: unknown,
  ): Promise<WarehouseMovementDto> {
    return this.movements.cancel(user, shipmentId, movementId, parse(cancelBody, body).reason);
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
