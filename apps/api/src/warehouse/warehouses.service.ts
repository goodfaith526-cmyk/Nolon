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
  WarehouseUpdateRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { Prisma, StorageLocation } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const withLocations = {
  storageLocations: { orderBy: { code: 'asc' } },
} satisfies Prisma.WarehouseInclude;

type WarehouseWithLocations = Prisma.WarehouseGetPayload<{ include: typeof withLocations }>;

/** What a movement needs from its warehouse. */
export interface MovementWarehouse {
  id: string;
  code: string;
  branchId: string;
  timezone: string;
  storageLocationId: string | null;
}

/**
 * Warehouses and their storage locations (scope 10): master data of each branch. A user sees and
 * manages the warehouses of their own branches only.
 */
@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser): Promise<WarehouseDto[]> {
    const warehouses = await this.prisma.warehouse.findMany({
      where: branchScope(user),
      include: withLocations,
      orderBy: { code: 'asc' },
    });
    return warehouses.map(toDto);
  }

  async create(user: AuthUser, input: WarehouseInput): Promise<WarehouseDto> {
    assertBranchAccess(user, input.branchId);
    try {
      return toDto(
        await this.prisma.warehouse.create({
          data: {
            branchId: input.branchId,
            code: input.code,
            nameEn: input.nameEn,
            nameAr: input.nameAr,
            address: input.address ?? null,
          },
          include: withLocations,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Warehouse code already exists');
      throw error;
    }
  }

  async update(user: AuthUser, id: string, input: WarehouseUpdateRequest): Promise<WarehouseDto> {
    await this.findScoped(user, id);
    return toDto(
      await this.prisma.warehouse.update({
        where: { id },
        data: {
          nameEn: input.nameEn,
          nameAr: input.nameAr,
          address: input.address,
          isActive: input.isActive,
        },
        include: withLocations,
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
   * For movements: the warehouse (and storage location) when the user may use it. 404 when it is
   * not in one of the user's branches; 400 when a receipt names an inactive warehouse or
   * location, or a location of another warehouse. A release may use an inactive warehouse, so
   * goods still there can leave.
   */
  async requireForMovement(
    user: AuthUser,
    warehouseId: string,
    storageLocationId: string | null,
    purpose: 'receipt' | 'release',
  ): Promise<MovementWarehouse> {
    const warehouse = await this.prisma.warehouse.findFirst({
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
    isActive: w.isActive,
    storageLocations: w.storageLocations.map(toLocationDto),
  };
}
