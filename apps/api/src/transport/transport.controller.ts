import {
  BadRequestException,
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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  MAX_DOCUMENT_BYTES,
  MAX_POD_PHOTOS,
  POD_STATUSES,
  TRIP_KINDS,
  TRIP_MOVES,
  TRIP_STATUSES,
  type CarrierDto,
  type DriverDto,
  type DriverUserOptionDto,
  type Page,
  type PodDto,
  type ShipmentPodsDto,
  type ShipmentTripDto,
  type TripDto,
  type TripSummaryDto,
  type VehicleDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import {
  amount,
  currencyCode,
  dateString,
  fxRate,
  optionalText,
  pageQuery,
  parse,
  phone,
  requiredText,
} from '../common/validation.js';
import { FleetService } from './fleet.service.js';
import { PodService } from './pod.service.js';
import { TripCostsService } from './trip-costs.service.js';
import { MAX_TRIP_SHIPMENTS, TripsService } from './trips.service.js';

/** Kilograms: positive, at most 9 integer and 3 decimal digits (Decimal(12, 3)). */
const capacityKg = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Invalid capacity')
  .refine((v) => /[1-9]/.test(v), 'Capacity must be positive')
  .nullish();

const plate = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(30)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} -]*$/u, 'Invalid plate');

const vehicleBody = z
  .object({ branchId: z.uuid(), plateNumber: plate, vehicleType: requiredText(100), capacityKg })
  .strict();
const vehicleUpdateBody = z
  .object({
    vehicleType: requiredText(100).optional(),
    capacityKg,
    isActive: z.boolean().optional(),
  })
  .strict();

const driverFields = {
  name: requiredText(200),
  phone: phone.nullish(),
  licenseNumber: optionalText(50),
  userId: z.uuid().nullish(),
};
const driverBody = z.object({ branchId: z.uuid(), ...driverFields }).strict();
const driverUpdateBody = z
  .object({
    name: driverFields.name.optional(),
    phone: driverFields.phone,
    licenseNumber: optionalText(50).optional(),
    userId: driverFields.userId,
    isActive: z.boolean().optional(),
  })
  .strict();

const carrierBody = z.object({ name: requiredText(200), phone: phone.nullish() }).strict();
const carrierUpdateBody = z
  .object({
    name: requiredText(200).optional(),
    phone: phone.nullish(),
    isActive: z.boolean().optional(),
  })
  .strict();

const timestamp = z.iso.datetime({ offset: true });

const tripBody = z
  .object({
    branchId: z.uuid(),
    kind: z.enum(TRIP_KINDS),
    originLocationId: z.uuid(),
    destinationLocationId: z.uuid(),
    plannedDeparture: timestamp.nullish(),
    plannedArrival: timestamp.nullish(),
    vehicleId: z.uuid().nullish(),
    driverId: z.uuid().nullish(),
    carrierId: z.uuid().nullish(),
    agreedCost: amount.nullish(),
    currency: currencyCode.nullish(),
    externalVehicle: optionalText(100),
    externalDriver: optionalText(200),
    notes: optionalText(2000),
    shipmentIds: z.array(z.uuid()).min(1).max(MAX_TRIP_SHIPMENTS),
  })
  .strict();

const tripListQuery = pageQuery.extend({ status: z.enum(TRIP_STATUSES).optional() });
const moveBody = z
  .object({ status: z.enum(TRIP_MOVES), occurredAt: timestamp.optional() })
  .strict();
const reasonBody = z.object({ reason: requiredText(1000) }).strict();
const addShipmentBody = z.object({ shipmentId: z.uuid() }).strict();

const expenseBody = z
  .object({
    requestId: z.uuid(),
    expenseDate: dateString,
    description: requiredText(200),
    amount,
    currency: currencyCode,
    fxRate: fxRate.nullish(),
    cashAccountId: z.uuid(),
  })
  .strict();

/** Multipart text fields of a POD (all strings on the wire). */
const podBody = z
  .object({
    recipientName: requiredText(200),
    recipientCapacity: requiredText(100),
    deliveredAt: timestamp.optional().or(z.literal('').transform(() => undefined)),
    packages: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v.trim() === '') return null;
        if (!/^\d{1,7}$/.test(v.trim()) || Number(v) < 1) {
          ctx.addIssue({ code: 'custom', message: 'Invalid packages' });
          return z.NEVER;
        }
        return Number.parseInt(v, 10);
      }),
    note: optionalText(1000),
    tripId: z
      .union([z.uuid(), z.literal('')])
      .optional()
      .transform((v) => v || null),
    shipmentStatus: z
      .union([z.enum(POD_STATUSES), z.literal('')])
      .optional()
      .transform((v) => v || null),
  })
  .strict();

/** The part of a multer file this controller uses (kept in memory, never written to disk). */
interface UploadedPart {
  originalname: string;
  buffer: Buffer;
}

/** Fleet master data: vehicles and drivers per branch, external carriers. */
@Controller('transport')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @AgentReadable()
  @Get('vehicles')
  @RequirePermission('transport_fleet:view')
  vehicles(@CurrentUser() user: AuthUser): Promise<VehicleDto[]> {
    return this.fleet.listVehicles(user);
  }

  @Post('vehicles')
  @RequirePermission('transport_fleet:create')
  createVehicle(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<VehicleDto> {
    return this.fleet.createVehicle(user, parse(vehicleBody, body));
  }

  @Patch('vehicles/:id')
  @RequirePermission('transport_fleet:update')
  updateVehicle(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<VehicleDto> {
    return this.fleet.updateVehicle(user, id, parse(vehicleUpdateBody, body));
  }

  @AgentReadable()
  @Get('drivers')
  @RequirePermission('transport_fleet:view')
  drivers(@CurrentUser() user: AuthUser): Promise<DriverDto[]> {
    return this.fleet.listDrivers(user);
  }

  @Get('driver-users')
  @RequirePermission('transport_fleet:update')
  driverUsers(@CurrentUser() user: AuthUser): Promise<DriverUserOptionDto[]> {
    return this.fleet.driverUsers(user);
  }

  @Post('drivers')
  @RequirePermission('transport_fleet:create')
  createDriver(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<DriverDto> {
    return this.fleet.createDriver(user, parse(driverBody, body));
  }

  @Patch('drivers/:id')
  @RequirePermission('transport_fleet:update')
  updateDriver(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<DriverDto> {
    return this.fleet.updateDriver(user, id, parse(driverUpdateBody, body));
  }

  @AgentReadable()
  @Get('carriers')
  @RequirePermission('transport_fleet:view')
  carriers(): Promise<CarrierDto[]> {
    return this.fleet.listCarriers();
  }

  @Post('carriers')
  @RequirePermission('transport_fleet:create')
  createCarrier(@Body() body: unknown): Promise<CarrierDto> {
    return this.fleet.createCarrier(parse(carrierBody, body));
  }

  @Patch('carriers/:id')
  @RequirePermission('transport_fleet:update')
  updateCarrier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CarrierDto> {
    return this.fleet.updateCarrier(id, parse(carrierUpdateBody, body));
  }
}

/** Trips, their status, shipments and costs. */
@Controller('trips')
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly costs: TripCostsService,
  ) {}

  @AgentReadable()
  @Get()
  @RequirePermission('transport_trips:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<TripSummaryDto>> {
    return this.trips.list(user, parse(tripListQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('transport_trips:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<TripDto> {
    return this.trips.get(user, id);
  }

  @Post()
  @RequirePermission('transport_trips:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<TripDto> {
    return this.trips.create(user, parse(tripBody, body));
  }

  @Post(':id/shipments')
  @RequirePermission('transport_trips:update')
  addShipment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDto> {
    return this.trips.addShipment(user, id, parse(addShipmentBody, body).shipmentId);
  }

  @Delete(':id/shipments/:shipmentId')
  @RequirePermission('transport_trips:update')
  removeShipment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<TripDto> {
    return this.trips.removeShipment(user, id, shipmentId);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transport_trips:update')
  move(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDto> {
    return this.trips.move(user, id, parse(moveBody, body));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transport_trips:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDto> {
    return this.trips.cancel(user, id, parse(reasonBody, body).reason);
  }

  @Post(':id/expenses')
  @RequirePermission('transport_trips:view', 'expenses:create')
  async addExpense(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TripDto> {
    await this.costs.addExpense(user, id, parse(expenseBody, body));
    return this.trips.get(user, id);
  }

  @Post(':id/expenses/:expenseId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transport_trips:view', 'expenses:cancel')
  async cancelExpense(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('expenseId', ParseUUIDPipe) expenseId: string,
    @Body() body: unknown,
  ): Promise<TripDto> {
    await this.costs.cancelExpense(user, id, expenseId, parse(reasonBody, body).reason);
    return this.trips.get(user, id);
  }
}

/** A shipment's trips (road legs) and proofs of delivery, on the shipment page. */
@Controller('shipments/:shipmentId')
export class ShipmentTransportController {
  constructor(
    private readonly trips: TripsService,
    private readonly pods: PodService,
  ) {}

  @AgentReadable()
  @Get('trips')
  @RequirePermission('transport_trips:view')
  shipmentTrips(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<ShipmentTripDto[]> {
    return this.trips.forShipment(user, shipmentId);
  }

  @AgentReadable()
  @Get('pods')
  @RequirePermission('pod:view')
  podList(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<ShipmentPodsDto> {
    return this.pods.view(user, shipmentId);
  }

  @Post('pods')
  @RequirePermission('pod:create', 'documents:create')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'signature', maxCount: 1 },
        { name: 'photos', maxCount: MAX_POD_PHOTOS },
      ],
      {
        // One more byte than allowed, so an oversized file is rejected rather than truncated.
        limits: {
          fileSize: MAX_DOCUMENT_BYTES + 1,
          files: MAX_POD_PHOTOS + 1,
          fields: 10,
          parts: MAX_POD_PHOTOS + 11,
        },
      },
    ),
  )
  record(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @UploadedFiles() files: { signature?: UploadedPart[]; photos?: UploadedPart[] } | undefined,
    @Body() body: unknown,
  ): Promise<PodDto> {
    const signature = files?.signature?.[0];
    if (!signature) throw new BadRequestException('Attach the signature');
    return this.pods.record(
      user,
      shipmentId,
      parse(podBody, body),
      { fileName: 'signature.png', data: signature.buffer },
      (files?.photos ?? []).map((p) => ({ fileName: p.originalname, data: p.buffer })),
    );
  }
}
