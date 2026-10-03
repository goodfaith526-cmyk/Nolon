import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateRateCardRequest,
  Page,
  RateCardDto,
  RateCardInput,
  RateStatus,
  ShippingMode,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { fromDbDate, fromDbDateOrNull, toDbDate } from '../common/dates.js';
import { type Decimal, dec, toDecimalString } from '../common/money.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma, RateCard } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RateFilters extends PageQuery {
  status?: RateStatus;
  originLocationId?: string;
  destinationLocationId?: string;
  mode?: ShippingMode;
}

/**
 * Selling rates (scope 7). Workflow: Sales create and edit DRAFT rates; a user with rates:approve
 * approves them; an approved rate is never edited, only cancelled (rates:cancel) and replaced.
 * Only approved rates in their validity window feed quotations.
 */
@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataService,
    private readonly currencies: CurrenciesService,
  ) {}

  async list(user: AuthUser, filters: RateFilters): Promise<Page<RateCardDto>> {
    const where: Prisma.RateCardWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.originLocationId ? { originLocationId: filters.originLocationId } : {}),
      ...(filters.destinationLocationId
        ? { destinationLocationId: filters.destinationLocationId }
        : {}),
      ...(filters.mode ? { mode: filters.mode } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.rateCard.findMany({
        where,
        orderBy: [{ status: 'asc' }, { validFrom: 'desc' }, { createdAt: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.rateCard.count({ where }),
    ]);
    return { items: items.map(toDto), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<RateCardDto> {
    return toDto(await this.findScoped(user, id));
  }

  async create(user: AuthUser, input: CreateRateCardRequest): Promise<RateCardDto> {
    assertBranchAccess(user, input.branchId);
    await this.validate(input);
    const { branchId, ...fields } = input;
    const rate = await this.prisma.rateCard.create({
      data: { ...toData(fields), branchId, createdById: user.id },
    });
    return toDto(rate);
  }

  /** Drafts only. */
  async update(user: AuthUser, id: string, input: Partial<RateCardInput>): Promise<RateCardDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') throw new ConflictException('Only a draft rate can be edited');
    await this.validate({ ...fromRow(existing), ...input });
    return this.transition(existing.id, 'DRAFT', toData(input));
  }

  async approve(user: AuthUser, id: string): Promise<RateCardDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT')
      throw new ConflictException('Only a draft rate can be approved');
    return this.transition(existing.id, 'DRAFT', {
      status: 'APPROVED',
      approvedById: user.id,
      approvedAt: new Date(),
    });
  }

  async cancel(user: AuthUser, id: string): Promise<RateCardDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status === 'CANCELLED') throw new ConflictException('Rate is already cancelled');
    return this.transition(existing.id, existing.status, { status: 'CANCELLED' });
  }

  /**
   * For quotation lines: an APPROVED rate of this branch, valid on `onDate` (YYYY-MM-DD, branch
   * time), in this currency. 400 otherwise.
   */
  async requireUsableRate(
    rateId: string,
    branchId: string,
    currency: string,
    onDate: string,
  ): Promise<RateCard> {
    const rate = await this.prisma.rateCard.findFirst({ where: { id: rateId, branchId } });
    if (!rate || rate.status !== 'APPROVED') {
      throw new BadRequestException('Rate is not an approved rate of this branch');
    }
    const day = toDbDate(onDate);
    if (rate.validFrom > day || (rate.validTo !== null && rate.validTo < day)) {
      throw new BadRequestException('Rate is not valid today');
    }
    if (rate.currency !== currency) {
      throw new BadRequestException('Rate currency differs from the quotation currency');
    }
    return rate;
  }

  /** Compare-and-set on the status, so two concurrent transitions cannot both win. */
  private async transition(
    id: string,
    from: RateStatus,
    data: Prisma.RateCardUncheckedUpdateManyInput,
  ): Promise<RateCardDto> {
    const { count } = await this.prisma.rateCard.updateMany({ where: { id, status: from }, data });
    if (count === 0) throw new ConflictException('Rate changed meanwhile; reload and retry');
    return toDto(await this.prisma.rateCard.findUniqueOrThrow({ where: { id } }));
  }

  private async findScoped(user: AuthUser, id: string): Promise<RateCard> {
    const rate = await this.prisma.rateCard.findFirst({ where: { id, ...branchScope(user) } });
    if (!rate) throw new NotFoundException('Rate not found');
    return rate;
  }

  private async validate(input: RateCardInput): Promise<void> {
    await this.masterData.requireRoute(input.originLocationId, input.destinationLocationId);
    if (input.mode !== 'SEA' && input.loadType) {
      throw new BadRequestException('FCL/LCL applies to sea rates only');
    }
    if (input.cargoType === 'CONTAINER') {
      if (!input.containerTypeCode) {
        throw new BadRequestException('A container rate needs a container type');
      }
      await this.masterData.requireContainerType(input.containerTypeCode);
    } else if (input.containerTypeCode) {
      throw new BadRequestException('Container type applies to container rates only');
    }
    await this.masterData.requireChargeType(input.chargeTypeCode ?? 'FREIGHT');
    await this.currencies.requireActive(input.currency);
    if (input.validTo && input.validTo < input.validFrom) {
      throw new BadRequestException('Valid-to is before valid-from');
    }
  }
}

type RateData<T> = Omit<T, 'price' | 'minimumCharge' | 'validFrom' | 'validTo'> & {
  price: T extends { price: string } ? Decimal : Decimal | undefined;
  minimumCharge?: Decimal;
  validFrom: T extends { validFrom: string } ? Date : Date | undefined;
  validTo?: Date | null;
};

function toData<T extends Partial<RateCardInput>>(input: T): RateData<T> {
  const { price, minimumCharge, validFrom, validTo, ...rest } = input;
  return {
    ...rest,
    price: (price === undefined ? undefined : dec(price)) as RateData<T>['price'],
    validFrom: (validFrom === undefined
      ? undefined
      : toDbDate(validFrom)) as RateData<T>['validFrom'],
    ...(minimumCharge === undefined ? {} : { minimumCharge: dec(minimumCharge) }),
    ...(validTo === undefined ? {} : { validTo: validTo === null ? null : toDbDate(validTo) }),
  };
}

type RateFields = Omit<RateCardDto, 'id' | 'branchId' | 'status' | 'approvedAt' | 'createdAt'>;

function fromRow(r: RateCard): RateFields {
  return {
    originLocationId: r.originLocationId,
    destinationLocationId: r.destinationLocationId,
    mode: r.mode,
    loadType: r.loadType,
    cargoType: r.cargoType,
    containerTypeCode: r.containerTypeCode,
    chargeTypeCode: r.chargeTypeCode,
    unit: r.unit,
    price: toDecimalString(r.price),
    minimumCharge: toDecimalString(r.minimumCharge),
    currency: r.currency,
    validFrom: fromDbDate(r.validFrom),
    validTo: fromDbDateOrNull(r.validTo),
    transitDays: r.transitDays,
    notes: r.notes,
  };
}

function toDto(r: RateCard): RateCardDto {
  return {
    ...fromRow(r),
    id: r.id,
    branchId: r.branchId,
    status: r.status,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
