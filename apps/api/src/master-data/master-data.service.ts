import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CodeNameDto,
  CodeNameInput,
  CurrencyDto,
  LocationDto,
  LocationInput,
  MasterDataDto,
} from '@nolon/shared';
import type { ChargeType, ContainerType, Location } from '../generated/prisma/client.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Ports and cities, container types and charge types (plus the currency master, read through
 * here for the dropdowns). Other modules validate references through `requireLocation`,
 * `requireContainerType` and `requireChargeType`, never against constants.
 */
@Injectable()
export class MasterDataService {
  constructor(private readonly prisma: PrismaService) {}

  async all(): Promise<MasterDataDto> {
    const [locations, containerTypes, chargeTypes, currencies] = await Promise.all([
      this.prisma.location.findMany({ orderBy: [{ countryCode: 'asc' }, { code: 'asc' }] }),
      this.prisma.containerType.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.chargeType.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.currency.findMany({ orderBy: { code: 'asc' } }),
    ]);
    return {
      locations: locations.map(toLocationDto),
      containerTypes: containerTypes.map(toCodeNameDto),
      chargeTypes: chargeTypes.map(toCodeNameDto),
      currencies: currencies.map((c): CurrencyDto => ({
        code: c.code,
        nameEn: c.nameEn,
        nameAr: c.nameAr,
        isActive: c.isActive,
        symbol: c.symbol,
        decimalPlaces: c.decimalPlaces,
      })),
    };
  }

  async createLocation(input: LocationInput): Promise<LocationDto> {
    try {
      return toLocationDto(await this.prisma.location.create({ data: input }));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Location code already exists');
      throw error;
    }
  }

  async updateLocation(id: string, input: Partial<LocationInput>): Promise<LocationDto> {
    const existing = await this.prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Location not found');
    try {
      return toLocationDto(await this.prisma.location.update({ where: { id }, data: input }));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Location code already exists');
      throw error;
    }
  }

  async upsertContainerType(input: CodeNameInput): Promise<CodeNameDto> {
    const { code, ...fields } = input;
    return toCodeNameDto(
      await this.prisma.containerType.upsert({
        where: { code },
        create: input,
        update: fields,
      }),
    );
  }

  async upsertChargeType(input: CodeNameInput): Promise<CodeNameDto> {
    const { code, ...fields } = input;
    return toCodeNameDto(
      await this.prisma.chargeType.upsert({ where: { code }, create: input, update: fields }),
    );
  }

  /** 400 unless the location exists and is active. */
  async requireLocation(id: string): Promise<Location> {
    const location = await this.prisma.location.findUnique({ where: { id } });
    if (!location?.isActive) throw new BadRequestException('Unknown or inactive location');
    return location;
  }

  async requireRoute(originId: string, destinationId: string): Promise<void> {
    if (originId === destinationId) {
      throw new BadRequestException('Origin and destination must differ');
    }
    await this.requireLocation(originId);
    await this.requireLocation(destinationId);
  }

  async requireContainerType(code: string): Promise<ContainerType> {
    const type = await this.prisma.containerType.findUnique({ where: { code } });
    if (!type?.isActive)
      throw new BadRequestException(`Unknown or inactive container type: ${code}`);
    return type;
  }

  async requireChargeType(code: string): Promise<ChargeType> {
    const type = await this.prisma.chargeType.findUnique({ where: { code } });
    if (!type?.isActive) throw new BadRequestException(`Unknown or inactive charge type: ${code}`);
    return type;
  }
}

function toLocationDto(l: Location): LocationDto {
  return {
    id: l.id,
    code: l.code,
    kind: l.kind,
    nameEn: l.nameEn,
    nameAr: l.nameAr,
    countryCode: l.countryCode,
    isActive: l.isActive,
  };
}

function toCodeNameDto(t: ContainerType | ChargeType): CodeNameDto {
  return { code: t.code, nameEn: t.nameEn, nameAr: t.nameAr, isActive: t.isActive };
}
