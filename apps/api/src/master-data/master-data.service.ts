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
  LocationKind,
  MasterDataDto,
  RouteMatch,
} from '@nolon/shared';
import type {
  ChargeType,
  ContainerType,
  DocumentType,
  Location,
  Prisma,
} from '../generated/prisma/client.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RouteFilters } from '../common/list-filters.js';
import { fieldRefusal } from '../common/validation.js';

type Tx = Prisma.TransactionClient;

/**
 * Ports and cities, container types, charge types and document types (plus the currency master, read through
 * here for the dropdowns). Other modules validate references through `requireLocation`,
 * `requireContainerType` and `requireChargeType`, never against constants.
 */
@Injectable()
export class MasterDataService {
  constructor(private readonly prisma: PrismaService) {}

  async all(): Promise<MasterDataDto> {
    const [branches, locations, containerTypes, chargeTypes, documentTypes, currencies] =
      await Promise.all([
        this.prisma.branch.findMany({
          select: { id: true, code: true, nameEn: true, nameAr: true },
          orderBy: { code: 'asc' },
        }),
        this.prisma.location.findMany({ orderBy: [{ countryCode: 'asc' }, { code: 'asc' }] }),
        this.prisma.containerType.findMany({ orderBy: { code: 'asc' } }),
        this.prisma.chargeType.findMany({ orderBy: { code: 'asc' } }),
        this.prisma.documentType.findMany({ orderBy: { code: 'asc' } }),
        this.prisma.currency.findMany({ orderBy: { code: 'asc' } }),
      ]);
    return {
      branches,
      locations: locations.map(toLocationDto),
      containerTypes: containerTypes.map(toCodeNameDto),
      chargeTypes: chargeTypes.map(toCodeNameDto),
      documentTypes: documentTypes.map(toCodeNameDto),
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

  /**
   * A new place, checked against its city under a share lock on the city row: a city's country
   * edit (which locks it for update) and the place's insert run one after the other, so a place
   * never lands in a city that moved to another country meanwhile (Codex F96-1).
   */
  async createLocation(input: LocationInput): Promise<LocationDto> {
    try {
      return toLocationDto(
        await this.prisma.$transaction(async (tx) => {
          const city = await requireCityOf(tx, null, input.kind, input.cityId);
          requireCityCountry(city, input.countryCode);
          return tx.location.create({ data: input });
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Location code already exists');
      throw error;
    }
  }

  /**
   * The location is locked for update and read again, then its new city (if any) is share-locked,
   * so the checks below and the write see the same city and the same places (Codex F96-1). A place
   * locks itself before its city, and a city has no city, so the order never cycles.
   */
  async updateLocation(id: string, input: Partial<LocationInput>): Promise<LocationDto> {
    try {
      return toLocationDto(
        await this.prisma.$transaction(async (tx) => {
          const existing = await lockLocation(tx, id, 'UPDATE');
          if (!existing) throw new NotFoundException('Location not found');
          const kind = input.kind ?? existing.kind;
          const cityId = input.cityId === undefined ? existing.cityId : input.cityId;
          const countryCode = input.countryCode ?? existing.countryCode;
          const city = await requireCityOf(tx, id, kind, cityId);
          // Checked when the country or the city changes (a place saved before the check keeps
          // its own).
          if (input.countryCode !== undefined || input.cityId !== undefined) {
            requireCityCountry(city, countryCode);
          }
          // A city's places stay in its country.
          if (kind === 'CITY' && countryCode !== existing.countryCode) {
            const elsewhere = await tx.location.count({
              where: { cityId: id, countryCode: { not: countryCode } },
            });
            if (elsewhere > 0) {
              throw fieldRefusal(null, 'Places of this city are in its current country', [
                'countryCode',
              ]);
            }
          }
          // A city that places name as theirs stays a city.
          if (kind !== 'CITY' && existing.kind === 'CITY') {
            const places = await tx.location.count({ where: { cityId: id } });
            if (places > 0)
              throw new BadRequestException('Places name this location as their city');
          }
          return tx.location.update({ where: { id }, data: input });
        }),
      );
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

  async upsertDocumentType(input: CodeNameInput): Promise<CodeNameDto> {
    const { code, ...fields } = input;
    return toCodeNameDto(
      await this.prisma.documentType.upsert({ where: { code }, create: input, update: fields }),
    );
  }

  /**
   * The locations a route filter matches: a location matches itself and the places whose city it
   * is (a city finds its ports). Reads only: a write keeps the location it was given.
   */
  async matchRoute(filters: RouteFilters): Promise<RouteMatch> {
    const ends = [filters.originLocationId, filters.destinationLocationId].filter(
      (id): id is string => id !== undefined,
    );
    const places =
      ends.length === 0
        ? []
        : await this.prisma.location.findMany({
            where: { cityId: { in: ends } },
            select: { id: true, cityId: true },
            orderBy: { code: 'asc' },
          });
    const of = (id: string | undefined): string[] | null =>
      id === undefined ? null : [id, ...places.filter((p) => p.cityId === id).map((p) => p.id)];
    return {
      originLocationIds: of(filters.originLocationId),
      destinationLocationIds: of(filters.destinationLocationId),
    };
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

  /** The codes among `codes` of active container types. */
  async activeContainerTypeCodes(codes: readonly string[]): Promise<Set<string>> {
    const types = await this.prisma.containerType.findMany({
      where: { code: { in: [...codes] }, isActive: true },
      select: { code: true },
    });
    return new Set(types.map((t) => t.code));
  }

  async requireChargeType(code: string): Promise<ChargeType> {
    const type = await this.prisma.chargeType.findUnique({ where: { code } });
    if (!type?.isActive) throw new BadRequestException(`Unknown or inactive charge type: ${code}`);
    return type;
  }

  /** The active charge types among `codes` (for their service), by code. */
  async activeChargeTypes(codes: readonly string[]): Promise<Map<string, ChargeType>> {
    const types = await this.prisma.chargeType.findMany({
      where: { code: { in: [...codes] }, isActive: true },
    });
    return new Map(types.map((t) => [t.code, t]));
  }

  async requireDocumentType(code: string): Promise<DocumentType> {
    const type = await this.prisma.documentType.findUnique({ where: { code } });
    if (!type?.isActive)
      throw new BadRequestException(`Unknown or inactive document type: ${code}`);
    return type;
  }
}

/**
 * A place's city: a CITY location other than itself; a city has none (one level only). Returns
 * the city, share-locked until the caller commits, or null for a location without one.
 */
async function requireCityOf(
  tx: Tx,
  id: string | null,
  kind: LocationKind,
  cityId: string | null | undefined,
): Promise<Location | null> {
  if (!cityId) return null;
  if (kind === 'CITY') throw new BadRequestException('A city does not belong to another city');
  if (cityId === id) throw new BadRequestException('A location cannot be its own city');
  const city = await lockLocation(tx, cityId, 'SHARE');
  if (city?.kind !== 'CITY') throw new BadRequestException('cityId must be a city');
  return city;
}

/** A location row locked until the caller commits, read after the lock; null when missing. */
async function lockLocation(
  tx: Tx,
  id: string,
  mode: 'UPDATE' | 'SHARE',
): Promise<Location | null> {
  const rows =
    mode === 'UPDATE'
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "locations" WHERE "id" = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "locations" WHERE "id" = ${id}::uuid FOR SHARE`;
  if (rows.length === 0) return null;
  return tx.location.findUniqueOrThrow({ where: { id } });
}

/** A place with a city is in the city's country (the form fills it in from the city). */
function requireCityCountry(city: Location | null, countryCode: string): void {
  if (city && city.countryCode !== countryCode) {
    throw fieldRefusal(
      'CITY_OTHER_COUNTRY',
      `The city ${city.code} is in ${city.countryCode}: the place must be in the same country`,
      ['countryCode', 'cityId'],
      { city: city.code, country: city.countryCode },
    );
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
    cityId: l.cityId,
  };
}

function toCodeNameDto(t: ContainerType | ChargeType | DocumentType): CodeNameDto {
  return { code: t.code, nameEn: t.nameEn, nameAr: t.nameAr, isActive: t.isActive };
}
