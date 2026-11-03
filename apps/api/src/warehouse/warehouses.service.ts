import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  StorageLocationDto,
  StorageLocationInput,
  StorageLocationUpdateRequest,
  WarehouseDto,
  WarehouseInput,
  WarehouseKind,
  WarehouseUpdateRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { Prisma, type StorageLocation } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { partnerRefSelect, toPartnerRef } from '../partners/partner-refs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

const withLocations = {
  storageLocations: { orderBy: { code: 'asc' } },
  partner: partnerRefSelect,
} satisfies Prisma.WarehouseInclude;

type WarehouseWithLocations = Prisma.WarehouseGetPayload<{ include: typeof withLocations }>;

/** A facility's details: what it does, the number customers call and where it is on the map. */
export interface WarehouseFacility {
  kind: WarehouseKind;
  /** E.164. */
  phone: string;
  /** WGS 84 degrees, as decimal strings. */
  latitude: string;
  longitude: string;
}

/** What a movement needs from its warehouse. */
export interface MovementWarehouse {
  id: string;
  code: string;
  branchId: string;
  timezone: string;
  storageLocationId: string | null;
  /** Where the warehouse is (functional review D9); null when not set. */
  locationId: string | null;
}

/**
 * Warehouses and their storage locations (scope 10): master data of each branch. A user sees and
 * manages the warehouses of their own branches only.
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser): Promise<WarehouseDto[]> {
    const warehouses = await this.prisma.warehouse.findMany({
      where: branchScope(user),
      include: withLocations,
      orderBy: { code: 'asc' },
    });
    return warehouses.map(toDto);
  }

  /**
   * `facility` (kind, phone, map position) is not part of the API body yet: only the trial
   * facilities script (seed/trial-facilities.ts) sets it.
   */
  async create(
    user: AuthUser,
    input: WarehouseInput,
    facility?: WarehouseFacility,
  ): Promise<WarehouseDto> {
    assertBranchAccess(user, input.branchId);
    try {
      return toDto(
        await this.prisma.$transaction(async (tx) => {
          const locationId = input.locationId ?? null;
          if (locationId) await this.masterData.requireLocationInTx(tx, locationId);
          return tx.warehouse.create({
            data: {
              branchId: input.branchId,
              code: input.code,
              nameEn: input.nameEn,
              nameAr: input.nameAr,
              address: input.address ?? null,
              locationId,
              kind: facility?.kind ?? null,
              phone: facility?.phone ?? null,
              latitude: facility ? new Prisma.Decimal(facility.latitude) : null,
              longitude: facility ? new Prisma.Decimal(facility.longitude) : null,
            },
            include: withLocations,
          });
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Warehouse code already exists');
      throw error;
    }
  }

  /**
   * Plan 09 section 11: the drop-off details are checked here (the outlet a SALES_OUTLET partner
   * of the warehouse's branch, the map position both or neither) and their changes audited.
   */
  async update(user: AuthUser, id: string, input: WarehouseUpdateRequest): Promise<WarehouseDto> {
    const before = await this.findScoped(user, id);
    return toDto(
      await this.prisma.$transaction(async (tx) => {
        const locationId = input.locationId;
        if (locationId) await this.masterData.requireLocationInTx(tx, locationId);
        if (input.partnerId) {
          const outlet = await tx.partner.findUnique({
            where: { id: input.partnerId },
            select: { kind: true, branchId: true, isActive: true },
          });
          if (
            outlet?.kind !== 'SALES_OUTLET' ||
            outlet.branchId !== before.branchId ||
            !outlet.isActive
          )
            throw new BadRequestException(
              "Choose an active sales outlet of the warehouse's branch",
            );
        }
        const latitude = input.latitude === undefined ? before.latitude : input.latitude;
        const longitude = input.longitude === undefined ? before.longitude : input.longitude;
        if ((latitude === null) !== (longitude === null))
          throw new BadRequestException('Set both latitude and longitude, or neither');
        const after = await tx.warehouse.update({
          where: { id },
          data: {
            nameEn: input.nameEn,
            nameAr: input.nameAr,
            address: input.address,
            locationId,
            isActive: input.isActive,
            addressEn: input.addressEn,
            acceptsDropOff: input.acceptsDropOff,
            partnerId: input.partnerId,
            mapUrl: input.mapUrl,
            hoursAr: input.hoursAr,
            hoursEn: input.hoursEn,
            phone: input.phone,
            latitude:
              input.latitude === undefined
                ? undefined
                : input.latitude === null
                  ? null
                  : new Prisma.Decimal(input.latitude),
            longitude:
              input.longitude === undefined
                ? undefined
                : input.longitude === null
                  ? null
                  : new Prisma.Decimal(input.longitude),
          },
          include: withLocations,
        });
        const changes = DROP_OFF_FIELDS.flatMap((field) => {
          const was = textOf(before[field]);
          const now = textOf(after[field]);
          return was === now ? [] : [{ field, before: was, after: now }];
        });
        if (changes.length > 0)
          await this.audit.record(tx, user, {
            branchId: after.branchId,
            entity: 'WAREHOUSE',
            entityId: after.id,
            reference: after.code,
            action: 'UPDATED',
            changes,
          });
        return after;
      }),
    );
  }

  async addLocation(
    user: AuthUser,
    id: string,
    input: StorageLocationInput,
  ): Promise<WarehouseDto> {
    const warehouse = await this.findScoped(user, id);
    try {
      await this.prisma.storageLocation.create({
        data: {
          branchId: warehouse.branchId,
          warehouseId: id,
          code: input.code,
          name: input.name ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This location code already exists in the warehouse');
      }
      throw error;
    }
    return toDto(await this.findScoped(user, id));
  }

  async updateLocation(
    user: AuthUser,
    id: string,
    locationId: string,
    input: StorageLocationUpdateRequest,
  ): Promise<WarehouseDto> {
    await this.findScoped(user, id);
    const { count } = await this.prisma.storageLocation.updateMany({
      where: { id: locationId, warehouseId: id, ...branchScope(user) },
      data: { name: input.name, isActive: input.isActive },
    });
    if (count === 0) throw new NotFoundException('Storage location not found');
    return toDto(await this.findScoped(user, id));
  }

  /**
   * For movements, inside the movement's transaction: the warehouse (and storage location) when
   * the user may use it. Both rows are share-locked first, so a concurrent deactivation either
   * waits for the movement to commit or commits first and is seen here. 404 when the warehouse is
   * not in one of the user's branches; 400 when a receipt names an inactive warehouse or
   * location, or a location of another warehouse. A release may use an inactive warehouse, so
   * goods still there can leave.
   */
  async requireForMovement(
    tx: Tx,
    user: AuthUser,
    warehouseId: string,
    storageLocationId: string | null,
    purpose: 'receipt' | 'release',
  ): Promise<MovementWarehouse> {
    await tx.$queryRaw`SELECT 1 FROM "warehouses" WHERE "id" = ${warehouseId}::uuid FOR SHARE`;
    if (storageLocationId) {
      await tx.$queryRaw`
        SELECT 1 FROM "storage_locations" WHERE "id" = ${storageLocationId}::uuid FOR SHARE`;
    }
    const warehouse = await tx.warehouse.findFirst({
      where: { id: warehouseId, ...branchScope(user) },
      include: { branch: { select: { timezone: true } }, storageLocations: true },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    if (purpose === 'receipt' && !warehouse.isActive) {
      throw new BadRequestException('The warehouse is inactive');
    }
    let location: StorageLocation | undefined;
    if (storageLocationId) {
      location = warehouse.storageLocations.find((l) => l.id === storageLocationId);
      if (!location?.isActive) {
        throw new BadRequestException('Unknown or inactive storage location for this warehouse');
      }
    }
    return {
      id: warehouse.id,
      code: warehouse.code,
      branchId: warehouse.branchId,
      timezone: warehouse.branch.timezone,
      storageLocationId: location?.id ?? null,
      locationId: warehouse.locationId,
    };
  }

  private async findScoped(user: AuthUser, id: string): Promise<WarehouseWithLocations> {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id, ...branchScope(user) },
      include: withLocations,
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return warehouse;
  }
}

/** The fields a customer reads about a drop-off point, audited when they change. */
const DROP_OFF_FIELDS = [
  'address',
  'addressEn',
  'acceptsDropOff',
  'partnerId',
  'mapUrl',
  'hoursAr',
  'hoursEn',
  'phone',
  'latitude',
  'longitude',
  'isActive',
] as const;

function textOf(v: string | boolean | Prisma.Decimal | null): string | null {
  return v === null ? null : v.toString();
}

function toLocationDto(l: StorageLocation): StorageLocationDto {
  return { id: l.id, code: l.code, name: l.name, isActive: l.isActive };
}

function toDto(w: WarehouseWithLocations): WarehouseDto {
  return {
    id: w.id,
    branchId: w.branchId,
    code: w.code,
    nameEn: w.nameEn,
    nameAr: w.nameAr,
    address: w.address,
    locationId: w.locationId,
    kind: w.kind,
    phone: w.phone,
    latitude: w.latitude?.toString() ?? null,
    longitude: w.longitude?.toString() ?? null,
    addressEn: w.addressEn,
    acceptsDropOff: w.acceptsDropOff,
    partnerId: w.partnerId,
    partner: toPartnerRef(w.partner),
    mapUrl: w.mapUrl,
    hoursAr: w.hoursAr,
    hoursEn: w.hoursEn,
    isActive: w.isActive,
    storageLocations: w.storageLocations.map(toLocationDto),
  };
}
