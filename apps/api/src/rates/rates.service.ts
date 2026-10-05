import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AuditChangeDto,
  CargoType,
  CreateRateCardRequest,
  LoadType,
  Page,
  RateCardDto,
  RateCardInput,
  RateStatus,
  ShippingMode,
} from '@nolon/shared';
import { AuditService, changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { lockActiveBranches, lockBranchRule } from '../common/branch-locks.js';
import { fromDbDate, fromDbDateOrNull, toDbDate } from '../common/dates.js';
import { type Decimal, dec, toDecimalString } from '../common/money.js';
import {
  type RuleIssue,
  memoAsync,
  refusal,
  throwFirstConflict,
  throwFirstIssue,
} from '../common/rule-issues.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma, RateCard } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Rows per INSERT of a bulk import (keeps the statement under PostgreSQL's parameter limit). */
const WRITE_CHUNK = 1000;

/** The per-branch lock every write that can add a draft or approved rate takes. */
export const RATE_UNIQUE_RULE = 'rate-offer';

/** The fields that make two rates the same offer. */
export interface RateKeyFields {
  branchId: string;
  originLocationId: string;
  destinationLocationId: string;
  mode: string;
  loadType?: string | null;
  cargoType: string;
  containerTypeCode?: string | null;
  chargeTypeCode?: string | null;
  unit: string;
  currency: string;
  validFrom: string;
}

/**
 * What makes two rates the same offer: branch, route, mode, load, cargo, container, charge,
 * unit, currency and start date. Two such rates in DRAFT or APPROVED would make quotation pricing
 * ambiguous, so a branch holds at most one.
 */
export function rateKey(r: RateKeyFields): string {
  return [
    r.branchId,
    r.originLocationId,
    r.destinationLocationId,
    r.mode,
    r.loadType ?? '',
    r.cargoType,
    r.containerTypeCode ?? '',
    r.chargeTypeCode ?? 'FREIGHT',
    r.unit,
    r.currency,
    r.validFrom,
  ].join('|');
}

const duplicateRate: RuleIssue = {
  field: 'validFrom',
  code: 'DUPLICATE_IN_DB',
  message: 'The same rate already exists in this branch',
};

const inactiveBranch: RuleIssue = {
  field: 'branchId',
  code: 'BRANCH_NOT_ALLOWED',
  message: 'Not one of your active branches',
};

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
    private readonly audit: AuditService,
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

  /**
   * A draft or approved rate is unique per branch by its rateKey(): the check runs under the
   * branch's rate lock (shared with update and the Excel import), so two writers cannot both pass
   * it. A duplicate is a 409.
   */
  async create(user: AuthUser, input: CreateRateCardRequest): Promise<RateCardDto> {
    assertBranchAccess(user, input.branchId);
    await this.validate(input);
    const { branchId, ...fields } = input;
    const rate = await this.prisma.$transaction(async (tx) => {
      await lockBranchRule(tx, RATE_UNIQUE_RULE, [branchId]);
      throwFirstConflict(await this.duplicateIssues(tx, [input]));
      const created = await tx.rateCard.create({
        data: { ...toData(fields), branchId, createdById: user.id },
      });
      await this.log(tx, user, 'CREATED', [created], (r) =>
        changedFields(null, auditFields(r), RATE_AUDIT_FIELDS),
      );
      return created;
    });
    return toDto(rate);
  }

  /**
   * Writes the rates of an Excel import, as drafts, inside the caller's transaction, each with its
   * given id. The import has already checked each input's schema and rules; here, under the same
   * locks as create, branch access is asserted again, each branch must still be active (its row
   * is locked, so it stays active until the import commits) and no rate may repeat a draft or
   * approved one of its branch. Imported rates go through the normal approval.
   *
   * Returns the issues of each row, in order. When any row has one, nothing is written.
   */
  async createImported(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    rows: readonly { id: string; input: CreateRateCardRequest }[],
  ): Promise<RuleIssue[][]> {
    for (const { input } of rows) assertBranchAccess(user, input.branchId);
    if (rows.length === 0) return [];
    const branchIds = rows.map((r) => r.input.branchId);
    const active = await lockActiveBranches(tx, branchIds);
    await lockBranchRule(tx, RATE_UNIQUE_RULE, branchIds);
    const duplicates = await this.duplicateIssues(
      tx,
      rows.map((r) => r.input),
    );
    const issues = rows.map(({ input }, i): RuleIssue[] => [
      ...(active.has(input.branchId) ? [] : [inactiveBranch]),
      ...(duplicates[i] ?? []),
    ]);
    if (issues.some((list) => list.length > 0)) return issues;
    const data = rows.map(({ id, input }) => {
      const { branchId, ...fields } = input;
      return { ...toData(fields), id, branchId, createdById: user.id };
    });
    for (let i = 0; i < data.length; i += WRITE_CHUNK) {
      await tx.rateCard.createMany({ data: data.slice(i, i + WRITE_CHUNK) });
    }
    const created = await tx.rateCard.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    await this.log(tx, user, 'CREATED', created, () => [
      { field: 'source', before: null, after: 'Excel import' },
    ]);
    return issues;
  }

  /**
   * For each candidate, a DUPLICATE_IN_DB issue when a draft or approved rate of its branch
   * (other than the rate `excludeId`) is the same offer. Binding only while the caller holds the
   * branch's rate lock (create, update, import); without it (the import preview) it is advice.
   */
  async duplicateIssues(
    client: Prisma.TransactionClient,
    candidates: readonly (RateKeyFields & { excludeId?: string })[],
  ): Promise<RuleIssue[][]> {
    if (candidates.length === 0) return [];
    const unique = (values: string[]) => [...new Set(values)];
    const existing = await client.rateCard.findMany({
      where: {
        branchId: { in: unique(candidates.map((c) => c.branchId)) },
        status: { in: ['DRAFT', 'APPROVED'] },
        originLocationId: { in: unique(candidates.map((c) => c.originLocationId)) },
        destinationLocationId: { in: unique(candidates.map((c) => c.destinationLocationId)) },
      },
    });
    const holders = new Map<string, string[]>();
    for (const r of existing) {
      const key = rateKey({ ...r, validFrom: fromDbDate(r.validFrom) });
      holders.set(key, [...(holders.get(key) ?? []), r.id]);
    }
    return candidates.map((c) =>
      (holders.get(rateKey(c)) ?? []).some((id) => id !== c.excludeId) ? [duplicateRate] : [],
    );
  }

  /**
   * Drafts only. A change that makes it the same offer as another rate is a 409. The status and
   * the offer are checked against the rate as it is now, not as it was read before the
   * transaction: the row is locked and read again first, so a stale form cannot put back an offer
   * the rate gave up and another rate took meanwhile.
   *
   * Lock order: the rate row (FOR NO KEY UPDATE), then the branch's rate rule lock. Create and
   * import take the rule lock and only insert new rows, so no path takes the rule lock and then
   * this row: the two orders cannot deadlock.
   */
  async update(user: AuthUser, id: string, input: Partial<RateCardInput>): Promise<RateCardDto> {
    const read = await this.findScoped(user, id);
    if (read.status !== 'DRAFT') throw new ConflictException('Only a draft rate can be edited');
    const merge = (r: RateCard) => {
      const before = { ...fromRow(r), branchId: r.branchId };
      return { before, after: { ...before, ...input } };
    };
    const stale = merge(read);
    await this.validate(stale.after);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "rate_cards" WHERE "id" = ${read.id}::uuid FOR NO KEY UPDATE`;
      const current = await tx.rateCard.findFirst({ where: { id: read.id, ...branchScope(user) } });
      if (!current) throw new NotFoundException('Rate not found');
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Only a draft rate can be edited');
      }
      const { before, after } = merge(current);
      if (JSON.stringify(after) !== JSON.stringify(stale.after)) await this.validate(after);
      if (rateKey(after) !== rateKey(before)) {
        await lockBranchRule(tx, RATE_UNIQUE_RULE, [current.branchId]);
        throwFirstConflict(await this.duplicateIssues(tx, [{ ...after, excludeId: current.id }]));
      }
      const dto = await this.transition(tx, current.id, 'DRAFT', toData(input));
      const updated = await tx.rateCard.findUniqueOrThrow({ where: { id: current.id } });
      await this.log(tx, user, 'UPDATED', [updated], (r) =>
        changedFields(auditFields(current), auditFields(r), RATE_AUDIT_FIELDS),
      );
      return dto;
    });
  }

  async approve(user: AuthUser, id: string): Promise<RateCardDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT')
      throw new ConflictException('Only a draft rate can be approved');
    // Approving keeps the rate among the drafts and approved ones: it cannot add a duplicate.
    return this.prisma.$transaction(async (tx) => {
      const dto = await this.transition(tx, existing.id, 'DRAFT', {
        status: 'APPROVED',
        approvedById: user.id,
        approvedAt: new Date(),
      });
      await this.logStatus(tx, user, 'APPROVED', existing.id, 'DRAFT', 'APPROVED');
      return dto;
    });
  }

  async cancel(user: AuthUser, id: string): Promise<RateCardDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status === 'CANCELLED') throw new ConflictException('Rate is already cancelled');
    return this.prisma.$transaction(async (tx) => {
      const dto = await this.transition(tx, existing.id, existing.status, { status: 'CANCELLED' });
      await this.logStatus(tx, user, 'CANCELLED', existing.id, existing.status, 'CANCELLED');
      return dto;
    });
  }

  /**
   * Audit log (AuditService): one row per rate, with the changes `changes` finds; locations by
   * code.
   */
  private async log(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    action: 'CREATED' | 'UPDATED',
    rates: readonly RateCard[],
    changes: (r: RateCard) => AuditChangeDto[],
  ): Promise<void> {
    const found = rates.map((r) => ({ rate: r, changes: changes(r) }));
    const ids = found.flatMap(({ rate, changes: c }) => [
      rate.originLocationId,
      rate.destinationLocationId,
      ...c.filter((x) => LOCATION_FIELDS.has(x.field)).flatMap((x) => [x.before, x.after]),
    ]);
    const codes = await this.locationCodes(tx, ids);
    const code = (id: string | null) => (id === null ? null : (codes.get(id) ?? id));
    await this.audit.recordMany(
      tx,
      user,
      found.map(({ rate, changes: c }) => ({
        branchId: rate.branchId,
        entity: 'RATE',
        entityId: rate.id,
        reference: rateReference(rate, codes),
        action,
        changes: c.map((x) =>
          LOCATION_FIELDS.has(x.field) ? { ...x, before: code(x.before), after: code(x.after) } : x,
        ),
      })),
    );
  }

  private async logStatus(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    action: 'APPROVED' | 'CANCELLED',
    id: string,
    from: RateStatus,
    to: RateStatus,
  ): Promise<void> {
    const rate = await tx.rateCard.findUniqueOrThrow({ where: { id } });
    await this.audit.record(tx, user, {
      branchId: rate.branchId,
      entity: 'RATE',
      entityId: rate.id,
      reference: rateReference(
        rate,
        await this.locationCodes(tx, [rate.originLocationId, rate.destinationLocationId]),
      ),
      action,
      changes: [{ field: 'status', before: from, after: to }],
    });
  }

  private async locationCodes(
    tx: Prisma.TransactionClient,
    ids: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const locations = await tx.location.findMany({
      where: { id: { in: [...new Set(ids.filter((id) => id !== null))] } },
      select: { id: true, code: true },
    });
    return new Map(locations.map((l) => [l.id, l.code]));
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
    client: Prisma.TransactionClient,
    id: string,
    from: RateStatus,
    data: Prisma.RateCardUncheckedUpdateManyInput,
  ): Promise<RateCardDto> {
    const { count } = await client.rateCard.updateMany({ where: { id, status: from }, data });
    if (count === 0) throw new ConflictException('Rate changed meanwhile; reload and retry');
    return toDto(await client.rateCard.findUniqueOrThrow({ where: { id } }));
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

/** The fields of a rate the audit log compares, as the API shows them. */
function auditFields(r: RateCard): RateFields & { status: RateStatus } {
  return { ...fromRow(r), status: r.status };
}

/** Rate fields that hold a location id: the log shows the location's code. */
const LOCATION_FIELDS: ReadonlySet<string> = new Set(['originLocationId', 'destinationLocationId']);

const RATE_AUDIT_FIELDS = [
  'status',
  'originLocationId',
  'destinationLocationId',
  'mode',
  'loadType',
  'cargoType',
  'containerTypeCode',
  'chargeTypeCode',
  'unit',
  'price',
  'minimumCharge',
  'currency',
  'validFrom',
  'validTo',
  'transitDays',
  'notes',
] as const;

/** How a rate is named in the audit log: route, charge, container, currency. */
function rateReference(r: RateCard, codes: ReadonlyMap<string, string>): string {
  const route = `${codes.get(r.originLocationId) ?? '?'}→${codes.get(r.destinationLocationId) ?? '?'}`;
  return [route, r.chargeTypeCode, r.containerTypeCode, r.currency].filter(Boolean).join(' ');
}

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
