import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CargoType,
  CreateRateCardRequest,
  LoadType,
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
import { type RuleIssue, memoAsync, refusal, throwFirstIssue } from '../common/rule-issues.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma, RateCard } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Rows per INSERT of a bulk import (keeps the statement under PostgreSQL's parameter limit). */
const WRITE_CHUNK = 1000;

/** What a quotation line's rate must match. */
export interface RatePricingContext {
  branchId: string;
  onDate: string;
  currency: string;
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  loadType: LoadType | null;
  cargoType: CargoType;
}

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

  /**
   * Writes the rates of an Excel import, as drafts, inside the caller's transaction, each with its
   * given id. The import has already checked every input (schema, rules, duplicates); branch
   * access is asserted again here. Imported rates go through the normal approval.
   */
  async createImported(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    rows: readonly { id: string; input: CreateRateCardRequest }[],
  ): Promise<void> {
    for (const { input } of rows) assertBranchAccess(user, input.branchId);
    const data = rows.map(({ id, input }) => {
      const { branchId, ...fields } = input;
      return { ...toData(fields), id, branchId, createdById: user.id };
    });
    for (let i = 0; i < data.length; i += WRITE_CHUNK) {
      await tx.rateCard.createMany({ data: data.slice(i, i + WRITE_CHUNK) });
    }
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
   * For quotation lines: an APPROVED rate of the quotation's branch, valid on `onDate`
   * (YYYY-MM-DD, branch time), that prices exactly this quotation: same currency, route, mode,
   * load type and cargo type. 400 on any mismatch.
   */
  async requireUsableRate(rateId: string, context: RatePricingContext): Promise<RateCard> {
    const rate = await this.prisma.rateCard.findFirst({
      where: { id: rateId, branchId: context.branchId },
    });
    if (!rate || rate.status !== 'APPROVED') {
      throw new BadRequestException('Rate is not an approved rate of this branch');
    }
    const day = toDbDate(context.onDate);
    if (rate.validFrom > day || (rate.validTo !== null && rate.validTo < day)) {
      throw new BadRequestException('Rate is not valid today');
    }
    const mismatches = [
      rate.currency !== context.currency && 'currency',
      rate.originLocationId !== context.originLocationId && 'origin',
      rate.destinationLocationId !== context.destinationLocationId && 'destination',
      rate.mode !== context.mode && 'mode',
      rate.loadType !== context.loadType && 'load type',
      rate.cargoType !== context.cargoType && 'cargo type',
    ].filter((m): m is string => typeof m === 'string');
    if (mismatches.length > 0) {
      throw new BadRequestException(`Rate does not match the quotation: ${mismatches.join(', ')}`);
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
    throwFirstIssue(await this.ruleChecker()(input));
  }

  /**
   * The rules a rate must meet (scope 7), as issues by field: create and update throw the first,
   * the Excel import reports them all. Master data is checked through its services; lookups are
   * cached per checker, so a file of thousands of rows asks for each code once.
   */
  ruleChecker(): (input: RateCardInput) => Promise<RuleIssue[]> {
    const routeRefusal = memoAsync((key: string) => {
      const [origin = '', destination = ''] = key.split('|');
      return refusal(() => this.masterData.requireRoute(origin, destination));
    });
    const locationRefusal = memoAsync((id: string) =>
      refusal(() => this.masterData.requireLocation(id)),
    );
    const containerRefusal = memoAsync((code: string) =>
      refusal(() => this.masterData.requireContainerType(code)),
    );
    const chargeRefusal = memoAsync((code: string) =>
      refusal(() => this.masterData.requireChargeType(code)),
    );
    const currencyRefusal = memoAsync((code: string) =>
      refusal(() => this.currencies.requireActive(code)),
    );
    return async (input) => {
      const issues: RuleIssue[] = [];
      const add = (field: string, code: RuleIssue['code'], message: string) =>
        issues.push({ field, code, message });

      const route = await routeRefusal(`${input.originLocationId}|${input.destinationLocationId}`);
      if (route) {
        const origin = await locationRefusal(input.originLocationId);
        const destination = await locationRefusal(input.destinationLocationId);
        if (origin) add('originLocationId', 'UNKNOWN_LOCATION', origin);
        if (destination) add('destinationLocationId', 'UNKNOWN_LOCATION', destination);
        if (!origin && !destination) add('destinationLocationId', 'SAME_ROUTE', route);
      }
      if (input.mode !== 'SEA' && input.loadType) {
        add('loadType', 'LOAD_TYPE_SEA_ONLY', 'FCL/LCL applies to sea rates only');
      }
      if (input.cargoType === 'CONTAINER') {
        if (!input.containerTypeCode) {
          add(
            'containerTypeCode',
            'CONTAINER_TYPE_REQUIRED',
            'A container rate needs a container type',
          );
        } else {
          const refused = await containerRefusal(input.containerTypeCode);
          if (refused) add('containerTypeCode', 'UNKNOWN_CONTAINER_TYPE', refused);
        }
      } else if (input.containerTypeCode) {
        add(
          'containerTypeCode',
          'CONTAINER_TYPE_NOT_APPLICABLE',
          'Container type applies to container rates only',
        );
      }
      const charge = await chargeRefusal(input.chargeTypeCode ?? 'FREIGHT');
      if (charge) add('chargeTypeCode', 'UNKNOWN_CHARGE_TYPE', charge);
      const currency = await currencyRefusal(input.currency);
      if (currency) add('currency', 'UNKNOWN_CURRENCY', currency);
      if (input.validTo && input.validTo < input.validFrom) {
        add('validTo', 'VALID_TO_BEFORE_FROM', 'Valid-to is before valid-from');
      }
      return issues;
    };
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
