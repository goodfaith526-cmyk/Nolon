import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CarrierDto,
  CarrierInput,
  CarrierUpdateRequest,
  DriverDto,
  DriverInput,
  DriverUpdateRequest,
  DriverUserOptionDto,
  VehicleDto,
  VehicleInput,
  VehicleUpdateRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { Carrier, Prisma, Vehicle } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';

type Tx = Prisma.TransactionClient;

const withUser = { user: { select: { fullName: true } } } satisfies Prisma.DriverInclude;
type DriverWithUser = Prisma.DriverGetPayload<{ include: typeof withUser }>;

/**
 * Fleet master data (scope 12): the owned vehicles and drivers of each branch, and the external
 * carriers every branch hires. Vehicles and drivers are branch-owned: a user sees and manages
 * those of their own branches only. Carriers are shared master data the client extends.
 */
@Injectable()
export class FleetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  // ---- Vehicles ------------------------------------------------------------------------------

  async listVehicles(user: AuthUser): Promise<VehicleDto[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: branchScope(user),
      orderBy: { plateNumber: 'asc' },
    });
    return vehicles.map(toVehicleDto);
  }

  async createVehicle(user: AuthUser, input: VehicleInput): Promise<VehicleDto> {
    assertBranchAccess(user, input.branchId);
    try {
      return toVehicleDto(
        await this.prisma.vehicle.create({
          data: {
            branchId: input.branchId,
            plateNumber: input.plateNumber,
            vehicleType: input.vehicleType,
            capacityKg: input.capacityKg ? dec(input.capacityKg) : null,
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This plate is already registered');
      throw error;
    }
  }

  async updateVehicle(
    user: AuthUser,
    id: string,
    input: VehicleUpdateRequest,
  ): Promise<VehicleDto> {
    await this.findVehicle(user, id);
    return toVehicleDto(
      await this.prisma.vehicle.update({
        where: { id },
        data: {
          vehicleType: input.vehicleType,
          capacityKg:
            input.capacityKg === undefined ? undefined : input.capacityKg && dec(input.capacityKg),
          isActive: input.isActive,
        },
      }),
    );
  }

  /**
   * For a trip of `branchId`, inside the trip's transaction: an active vehicle of that branch the
   * user can see; 400 otherwise. The row is share-locked first, so a concurrent deactivation
   * either commits before and is seen here, or waits until the trip is saved.
   */
  async requireVehicleForTrip(
    tx: Tx,
    user: AuthUser,
    id: string,
    branchId: string,
  ): Promise<Vehicle> {
    await tx.$queryRaw`SELECT 1 FROM "vehicles" WHERE "id" = ${id}::uuid FOR SHARE`;
    const vehicle = await tx.vehicle.findFirst({ where: { id, ...branchScope(user) } });
    if (!vehicle?.isActive || vehicle.branchId !== branchId) {
      throw new BadRequestException('Choose an active vehicle of the trip branch');
    }
    return vehicle;
  }

  // ---- Drivers -------------------------------------------------------------------------------

  async listDrivers(user: AuthUser): Promise<DriverDto[]> {
    const drivers = await this.prisma.driver.findMany({
      where: branchScope(user),
      include: withUser,
      orderBy: { name: 'asc' },
    });
    return drivers.map(toDriverDto);
  }

  async createDriver(user: AuthUser, input: DriverInput): Promise<DriverDto> {
    assertBranchAccess(user, input.branchId);
    if (input.userId) await this.users.requireDriverUser(input.userId, input.branchId);
    try {
      return toDriverDto(
        await this.prisma.driver.create({
          data: {
            branchId: input.branchId,
            name: input.name,
            phone: input.phone ?? null,
            licenseNumber: input.licenseNumber ?? null,
            userId: input.userId ?? null,
          },
          include: withUser,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This user is already linked to another driver');
      }
      throw error;
    }
  }

  /**
   * Updates a driver. The linked user cannot change once the driver has trips: the user sees the
   * trips of the driver record, so relinking would hand one driver's history to another (409).
   * The driver row is locked while its trips are counted, so a trip being planned for it either
   * commits first and is counted, or waits for the update.
   */
  async updateDriver(user: AuthUser, id: string, input: DriverUpdateRequest): Promise<DriverDto> {
    const driver = await this.findDriver(user, id);
    if (input.userId) await this.users.requireDriverUser(input.userId, driver.branchId);
    try {
      return toDriverDto(
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "drivers" WHERE "id" = ${id}::uuid FOR UPDATE`;
          if (input.userId !== undefined) {
            const current = await tx.driver.findUniqueOrThrow({
              where: { id },
              select: { userId: true },
            });
            if (
              input.userId !== current.userId &&
              (await tx.trip.count({ where: { driverId: id } }))
            ) {
              throw new ConflictException(
                'This driver has trips: its user cannot change. Add a new driver record instead',
              );
            }
          }
          return tx.driver.update({
            where: { id },
            data: {
              name: input.name,
              phone: input.phone,
              licenseNumber: input.licenseNumber,
              userId: input.userId,
              isActive: input.isActive,
            },
            include: withUser,
          });
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This user is already linked to another driver');
      }
      throw error;
    }
  }

  /** Users that may be linked to a driver of the user's branches. */
  driverUsers(user: AuthUser): Promise<DriverUserOptionDto[]> {
    return this.users.driverUsers(user.allowedBranchIds);
  }

  /**
   * For a trip of `branchId`, inside the trip's transaction: an active driver of that branch the
   * user can see; 400 otherwise. Share-locked like requireVehicleForTrip.
   */
  async requireDriverForTrip(tx: Tx, user: AuthUser, id: string, branchId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "drivers" WHERE "id" = ${id}::uuid FOR SHARE`;
    const driver = await tx.driver.findFirst({ where: { id, ...branchScope(user) } });
    if (!driver?.isActive || driver.branchId !== branchId) {
      throw new BadRequestException('Choose an active driver of the trip branch');
    }
  }

  // ---- Carriers ------------------------------------------------------------------------------

  async listCarriers(): Promise<CarrierDto[]> {
    const carriers = await this.prisma.carrier.findMany({ orderBy: { name: 'asc' } });
    return carriers.map(toCarrierDto);
  }

  async createCarrier(input: CarrierInput): Promise<CarrierDto> {
    try {
      return toCarrierDto(
        await this.prisma.carrier.create({
          data: { name: input.name, phone: input.phone ?? null },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This carrier already exists');
      throw error;
    }
  }

  async updateCarrier(id: string, input: CarrierUpdateRequest): Promise<CarrierDto> {
    const existing = await this.prisma.carrier.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Carrier not found');
    try {
      return toCarrierDto(
        await this.prisma.carrier.update({
          where: { id },
          data: { name: input.name, phone: input.phone, isActive: input.isActive },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This carrier already exists');
      throw error;
    }
  }

  /**
   * For an external trip, inside its transaction: an active carrier; 400 otherwise. Share-locked
   * like requireVehicleForTrip.
   */
  async requireCarrierForTrip(tx: Tx, id: string): Promise<Carrier> {
    await tx.$queryRaw`SELECT 1 FROM "carriers" WHERE "id" = ${id}::uuid FOR SHARE`;
    const carrier = await tx.carrier.findUnique({ where: { id } });
    if (!carrier?.isActive) throw new BadRequestException('Choose an active carrier');
    return carrier;
  }

  // -------------------------------------------------------------------------------------------

  private async findVehicle(user: AuthUser, id: string): Promise<Vehicle> {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, ...branchScope(user) } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  private async findDriver(user: AuthUser, id: string): Promise<DriverWithUser> {
    const driver = await this.prisma.driver.findFirst({
      where: { id, ...branchScope(user) },
      include: withUser,
    });
    if (!driver) throw new NotFoundException('Driver not found');
    return driver;
  }
}

function toVehicleDto(v: Vehicle): VehicleDto {
  return {
    id: v.id,
    branchId: v.branchId,
    plateNumber: v.plateNumber,
    vehicleType: v.vehicleType,
    capacityKg: toDecimalStringOrNull(v.capacityKg),
    isActive: v.isActive,
  };
}

function toDriverDto(d: DriverWithUser): DriverDto {
  return {
    id: d.id,
    branchId: d.branchId,
    name: d.name,
    phone: d.phone,
    licenseNumber: d.licenseNumber,
    userId: d.userId,
    userName: d.user?.fullName ?? null,
    isActive: d.isActive,
  };
}

function toCarrierDto(c: Carrier): CarrierDto {
  return { id: c.id, name: c.name, phone: c.phone, isActive: c.isActive };
}
