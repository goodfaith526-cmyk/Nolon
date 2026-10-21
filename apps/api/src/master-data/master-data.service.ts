import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CodeNameDto,
  CodeNameInput,
  CodeNameUpdate,
  CurrencyDto,
  LocationDto,
  LocationInput,
  LocationKind,
  MasterDataDto,
  PriceCategoryDto,
  PriceCategoryInput,
  PriceCategoryUpdate,
  RouteMatch,
} from '@nolon/shared';
import { AuditService, changedFields, codeEntityId } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import {
  Prisma,
  type ChargeType,
  type ContainerType,
  type CustomerSegment,
  type DocumentType,
  type Location,
  type PriceCategory,
} from '../generated/prisma/client.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RouteFilters } from '../common/list-filters.js';
import { codedRefusal, fieldRefusal } from '../common/validation.js';

type Tx = Prisma.TransactionClient;

/** The master data kept by code that the master data screen edits here (currencies have theirs). */
export type CodeType = 'CONTAINER_TYPE' | 'CHARGE_TYPE' | 'DOCUMENT_TYPE' | 'CUSTOMER_SEGMENT';

type CodeRow = ContainerType | ChargeType | DocumentType | CustomerSegment;

/** The fields the audit log shows for a price category, in this order. */
const PRICE_CATEGORY_FIELDS = [
  'code',
  'nameEn',
  'nameAr',
  'cargoType',
  'defaultUnit',
  'isActive',
] as const;

/** The fields the audit log shows for a code type, in this order. */
const AUDITED_FIELDS = ['code', 'nameEn', 'nameAr', 'isActive'] as const;

const CODE_TYPE_NAMES: Record<CodeType, string> = {
  CONTAINER_TYPE: 'Container type',
  CHARGE_TYPE: 'Charge type',
  DOCUMENT_TYPE: 'Document type',
  CUSTOMER_SEGMENT: 'Customer segment',
};

/**
 * Ports and cities, container types, charge types and document types (plus the currency master, read through
 * here for the dropdowns). Other modules validate references through `requireLocation`,
 * `requireContainerType` and `requireChargeType`, never against constants.
 */
@Injectable()
export class MasterDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async all(): Promise<MasterDataDto> {
    const [
      branches,
      locations,
      containerTypes,
      chargeTypes,
      documentTypes,
      currencies,
      priceCategories,
      customerSegments,
    ] = await Promise.all([
      this.prisma.branch.findMany({
        select: { id: true, code: true, nameEn: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.location.findMany({ orderBy: [{ countryCode: 'asc' }, { code: 'asc' }] }),
      this.prisma.containerType.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.chargeType.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.documentType.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.currency.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.priceCategory.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.customerSegment.findMany({ orderBy: { code: 'asc' } }),
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
      priceCategories: priceCategories.map(toPriceCategoryDto),
      customerSegments: customerSegments.map(toCodeNameDto),
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

  /**
   * A new, active container, charge or document type, in the audit log. Its code never changes
   * afterwards (other records name it).
   */
  async createCodeType(user: AuthUser, type: CodeType, input: CodeNameInput): Promise<CodeNameDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await codeTable(tx, type).create(input);
        await this.logCodeType(tx, user, type, 'CREATED', null, created);
        return toCodeNameDto(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'MASTER_CODE_TAKEN',
          `${CODE_TYPE_NAMES[type]} ${input.code} already exists`,
          { code: input.code },
        );
      }
      throw error;
    }
  }

  /** Renames a container, charge or document type (the code stays). */
  async updateCodeType(
    user: AuthUser,
    type: CodeType,
    code: string,
    input: CodeNameUpdate,
  ): Promise<CodeNameDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await lockCodeType(tx, type, code);
      const after = await codeTable(tx, type).update(code, input);
      await this.logCodeType(tx, user, type, 'UPDATED', before, after);
      return toCodeNameDto(after);
    });
  }

  /**
   * Deactivates or reactivates a container, charge or document type. Records that already name it
   * keep it and still read; new ones are refused while it is inactive (requireContainerType,
   * requireChargeType, requireDocumentType and the like).
   */
  async setCodeTypeActive(
    user: AuthUser,
    type: CodeType,
    code: string,
    isActive: boolean,
  ): Promise<CodeNameDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await lockCodeType(tx, type, code);
      if (before.isActive === isActive) return toCodeNameDto(before);
      const after = await codeTable(tx, type).update(code, { isActive });
      await this.logCodeType(tx, user, type, 'UPDATED', before, after);
      return toCodeNameDto(after);
    });
  }

  /**
   * A new, active price category, in the audit log. Its code and cargo type never change
   * afterwards: rates and cargo lines name it, and its cargo type is what it prices.
   */
  async createPriceCategory(user: AuthUser, input: PriceCategoryInput): Promise<PriceCategoryDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.priceCategory.create({ data: input });
        await this.logPriceCategory(tx, user, 'CREATED', null, created);
        return toPriceCategoryDto(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'MASTER_CODE_TAKEN',
          `Price category ${input.code} already exists`,
          { code: input.code },
        );
      }
      throw error;
    }
  }

  /** Renames a price category or changes its suggested unit (code and cargo type stay). */
  async updatePriceCategory(
    user: AuthUser,
    code: string,
    input: PriceCategoryUpdate,
  ): Promise<PriceCategoryDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await lockPriceCategory(tx, code);
      const after = await tx.priceCategory.update({ where: { code }, data: input });
      await this.logPriceCategory(tx, user, 'UPDATED', before, after);
      return toPriceCategoryDto(after);
    });
  }

  /** Deactivates or reactivates a price category, as setCodeTypeActive does a code type. */
  async setPriceCategoryActive(
    user: AuthUser,
    code: string,
    isActive: boolean,
  ): Promise<PriceCategoryDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await lockPriceCategory(tx, code);
      if (before.isActive === isActive) return toPriceCategoryDto(before);
      const after = await tx.priceCategory.update({ where: { code }, data: { isActive } });
      await this.logPriceCategory(tx, user, 'UPDATED', before, after);
      return toPriceCategoryDto(after);
    });
  }

  private async logPriceCategory(
    tx: Tx,
    user: AuthUser,
    action: 'CREATED' | 'UPDATED',
    before: PriceCategory | null,
    after: PriceCategory,
  ): Promise<void> {
    await this.audit.record(tx, user, {
      branchId: null,
      entity: 'PRICE_CATEGORY',
      entityId: codeEntityId('PRICE_CATEGORY', after.code),
      reference: `${after.code} ${after.nameEn}`,
      action,
      changes: changedFields(before, after, PRICE_CATEGORY_FIELDS),
    });
  }

  private async logCodeType(
    tx: Tx,
    user: AuthUser,
    type: CodeType,
    action: 'CREATED' | 'UPDATED',
    before: CodeRow | null,
    after: CodeRow,
  ): Promise<void> {
    await this.audit.record(tx, user, {
      branchId: null,
      entity: type,
      entityId: codeEntityId(type, after.code),
      reference: `${after.code} ${after.nameEn}`,
      action,
      changes: changedFields(before, after, AUDITED_FIELDS),
    });
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

  /**
   * As requireLocation, inside the caller's transaction: the location is share-locked until it
   * commits, so it cannot be deactivated or changed meanwhile (an edit locks it for update).
   */
  async requireLocationInTx(tx: Tx, id: string): Promise<Location> {
    const location = await lockLocation(tx, id, 'SHARE');
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

/** The same few writes on each of the three code tables (their rows have the same fields). */
interface CodeTable {
  create(data: CodeNameInput): Promise<CodeRow>;
  update(code: string, data: CodeNameUpdate & { isActive?: boolean }): Promise<CodeRow>;
  find(code: string): Promise<CodeRow | null>;
}

function codeTable(tx: Tx, type: CodeType): CodeTable {
  switch (type) {
    case 'CONTAINER_TYPE':
      return {
        create: (data) => tx.containerType.create({ data }),
        update: (code, data) => tx.containerType.update({ where: { code }, data }),
        find: (code) => tx.containerType.findUnique({ where: { code } }),
      };
    case 'CHARGE_TYPE':
      return {
        create: (data) => tx.chargeType.create({ data }),
        update: (code, data) => tx.chargeType.update({ where: { code }, data }),
        find: (code) => tx.chargeType.findUnique({ where: { code } }),
      };
    case 'DOCUMENT_TYPE':
      return {
        create: (data) => tx.documentType.create({ data }),
        update: (code, data) => tx.documentType.update({ where: { code }, data }),
        find: (code) => tx.documentType.findUnique({ where: { code } }),
      };
    case 'CUSTOMER_SEGMENT':
      return {
        create: (data) => tx.customerSegment.create({ data }),
        update: (code, data) => tx.customerSegment.update({ where: { code }, data }),
        find: (code) => tx.customerSegment.findUnique({ where: { code } }),
      };
  }
}

/** Table names for the row lock below: fixed values, never request input. */
const CODE_TABLE_NAMES: Record<CodeType, string> = {
  CONTAINER_TYPE: 'container_types',
  CHARGE_TYPE: 'charge_types',
  DOCUMENT_TYPE: 'document_types',
  CUSTOMER_SEGMENT: 'customer_segments',
};

/**
 * The code type's row locked for update until the caller commits, read after the lock, so two
 * edits run one after the other and each logs the values it really changed. 404 when missing.
 */
async function lockCodeType(tx: Tx, type: CodeType, code: string): Promise<CodeRow> {
  const table = Prisma.raw(`"${CODE_TABLE_NAMES[type]}"`);
  const rows = await tx.$queryRaw<{ code: string }[]>(
    Prisma.sql`SELECT "code" FROM ${table} WHERE "code" = ${code} FOR UPDATE`,
  );
  const row = rows.length > 0 ? await codeTable(tx, type).find(code) : null;
  if (!row) throw new NotFoundException(`${CODE_TYPE_NAMES[type]} not found`);
  return row;
}

/** The price category's row locked for update, read after the lock. 404 when missing. */
async function lockPriceCategory(tx: Tx, code: string): Promise<PriceCategory> {
  const rows = await tx.$queryRaw<{ code: string }[]>`
    SELECT "code" FROM "price_categories" WHERE "code" = ${code} FOR UPDATE`;
  const row = rows.length > 0 ? await tx.priceCategory.findUnique({ where: { code } }) : null;
  if (!row) throw new NotFoundException('Price category not found');
  return row;
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

function toPriceCategoryDto(c: PriceCategory): PriceCategoryDto {
  return {
    code: c.code,
    nameEn: c.nameEn,
    nameAr: c.nameAr,
    isActive: c.isActive,
    cargoType: c.cargoType,
    defaultUnit: c.defaultUnit,
  };
}

function toCodeNameDto(t: CodeRow): CodeNameDto {
  return { code: t.code, nameEn: t.nameEn, nameAr: t.nameAr, isActive: t.isActive };
}
