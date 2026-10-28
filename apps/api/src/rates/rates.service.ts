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
  PriceScope,
  RateCardDto,
  RateCardInput,
  RateStatus,
  RateUnit,
  RouteMatch,
  ShippingMode,
} from '@nolon/shared';
import { hasSeaLeg } from '@nolon/shared';
import { AuditService, changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { lockActiveBranches, lockBranchRule } from '../common/branch-locks.js';
import { fromDbDate, fromDbDateOrNull, toDbDate } from '../common/dates.js';
import { followLoadType } from '../common/load-type.js';
import { type Decimal, dec, toDecimalString } from '../common/money.js';
import {
  type RuleIssue,
  memoAsync,
  refusal,
  throwFirstConflict,
  throwFirstIssue,
} from '../common/rule-issues.js';
import { fieldRefusal, type PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma, RateCard } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { matchedLocations, routeWhere } from '../common/list-filters.js';

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
  priceCategoryCode?: string | null;
  unit: string;
  currency: string;
  validFrom: string;
}

/**
 * What makes two rates the same offer: branch, route, mode, load, cargo, container, charge,
 * price category, unit, currency and start date. Two such rates in DRAFT or APPROVED would make quotation pricing
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
    r.priceCategoryCode ?? '',
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
  /**
   * The line's price category (plan 5.3): null or left out, the line is priced from general
   * cards only; with one, from its category's cards first, else the general ones.
   */
  priceCategoryCode?: string | null;
}

/** The scope a rate card's end matched a document's place at, narrowest first (plan 5.3). */
const SCOPE_RANK: Readonly<Record<PriceScope, number>> = { PLACE: 0, CITY: 1, COUNTRY: 2 };

/** A rate card that prices a document's route, and at which scope each end matched. */
export interface ScopedRate {
  rate: RateCard;
  originScope: PriceScope;
  destinationScope: PriceScope;
}

/** What the system price looks for: the document's context, and the line's charge and unit when given. */
export interface RateMatchContext extends RatePricingContext {
  chargeTypeCode?: string | null;
  unit?: RateUnit | null;
}

/**
 * A system-price context with no document branch (the customer-service quote, when no single
 * branch serves the route): the narrowest offers of every branch, never one branch's preferred.
 */
export type OpenRateMatchContext = Omit<RateMatchContext, 'branchId'> & { branchId: string | null };

/** What the customer-service quote asks the cards for before mode, load and currency are known. */
export interface RouteOfferQuery {
  onDate: string;
  originLocationId: string;
  destinationLocationId: string;
  cargoType: CargoType;
  priceCategoryCode: string | null;
  chargeTypeCode: string;
}

/** The fields a system-price refusal names: no rate card matches; several do. */
export interface RateMatchFields {
  noMatch: readonly string[];
  several: readonly string[];
}

/** Rate cards a refusal lists, at most. */
const LISTED_RATES = 5;

export interface RateFilters extends PageQuery {
  status?: RateStatus;
  originLocationId?: string;
  destinationLocationId?: string;
  mode?: ShippingMode;
  /** Valid on this date (YYYY-MM-DD). */
  validOn?: string;
  /** The rates of this branch; else of every branch. */
  branchId?: string;
  /** The origin and destination are a document's places: the cards covering them (plan 5.3). */
  covering?: boolean;
  /**
   * Leave out the cards of one price category. The assistant reads rates through contract v1,
   * which has no category: it would show a category's price as a general one, so it gets the
   * general cards only until its contract carries the category.
   */
  generalOnly?: boolean;
}

/**
 * Selling rates (scope 7). Workflow: the Sales & Marketing Manager creates and edits DRAFT rates
 * and approves them (rates:approve); an approved rate is never edited, only cancelled
 * (rates:cancel) and replaced. Only approved rates in their validity window feed quotations.
 *
 * Rate cards are read by every branch (owner, 2026-10-19): any user with rates:view sees the rates
 * of all branches, and a quotation or invoice of any branch is priced from them. A rate still
 * belongs to a branch, and only a user of that branch changes it.
 */
@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataService,
    private readonly currencies: CurrenciesService,
    private readonly audit: AuditService,
  ) {}

  async list(filters: RateFilters): Promise<Page<RateCardDto>> {
    const route = filters.covering
      ? await this.coveringRoute(filters)
      : await this.masterData.matchRoute(filters);
    const where: Prisma.RateCardWhereInput = {
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...routeWhere(route),
      ...(filters.mode ? { mode: filters.mode } : {}),
      ...(filters.generalOnly ? { priceCategoryCode: null } : {}),
      AND: [
        ...(filters.validOn
          ? [
              { validFrom: { lte: toDbDate(filters.validOn) } },
              { OR: [{ validTo: null }, { validTo: { gte: toDbDate(filters.validOn) } }] },
            ]
          : []),
        ...(filters.q ? [{ OR: rateSearch(filters.q) }] : []),
      ],
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
    return {
      items: items.map(toDto),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      ...matchedLocations(route),
    };
  }

  /** The locations whose cards price each given end of a document's route (scopesOf). */
  private async coveringRoute(filters: RateFilters): Promise<RouteMatch> {
    const of = async (id: string | undefined) =>
      id === undefined ? null : [...(await this.scopesOf(id)).keys()].sort();
    return {
      originLocationIds: await of(filters.originLocationId),
      destinationLocationIds: await of(filters.destinationLocationId),
    };
  }

  /** A rate of any branch (rate cards are read by every branch). */
  /** One rate card; with `generalOnly` (RateFilters), a card of a price category is not found. */
  async get(id: string, { generalOnly = false } = {}): Promise<RateCardDto> {
    const rate = await this.prisma.rateCard.findUnique({ where: { id } });
    if (!rate || (generalOnly && rate.priceCategoryCode !== null)) {
      throw new NotFoundException('Rate not found');
    }
    return toDto(rate);
  }

  /**
   * A draft or approved rate is unique per branch by its rateKey(): the check runs under the
   * branch's rate lock (shared with update and the Excel import), so two writers cannot both pass
   * it. A duplicate is a 409.
   */
  async create(user: AuthUser, given: CreateRateCardRequest): Promise<RateCardDto> {
    const input = withLoadType(given);
    await this.prepareCreate(user, input);
    return toDto(await this.prisma.$transaction((tx) => this.createInTx(tx, user, input)));
  }

  /** The checks of create that need no lock (branch access, the rate's rules); nothing is written. */
  async prepareCreate(user: AuthUser, input: CreateRateCardRequest): Promise<void> {
    assertBranchAccess(user, input.branchId);
    await this.validate(input);
  }

  /**
   * The rules of a rate on the values a rate card draft holds so far (a draft is saved with
   * missing values): branch access, and each value present checked as create checks it. What is
   * missing, and the container type a container rate still needs, are left for the person to fill
   * in; prepareCreate runs in full once nothing is missing. Nothing is written.
   */
  async checkPresent(
    user: AuthUser,
    branchId: string,
    input: Partial<RateCardInput>,
  ): Promise<void> {
    assertBranchAccess(user, branchId);
    // The rules check a location with the other end of its route; one given alone is checked here.
    const { originLocationId: from, destinationLocationId: to } = input;
    const alone = from && !to ? from : to && !from ? to : null;
    if (alone) await this.masterData.requireRateLocation(alone);
    const issues = await this.ruleChecker()(input);
    throwFirstIssue(issues.filter((issue) => issue.code !== 'CONTAINER_TYPE_REQUIRED'));
  }

  /**
   * create's write, in the caller's transaction (an approved rate card draft): a DRAFT rate,
   * under the branch's rate lock, with its audit row. The caller ran prepareCreate.
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    input: CreateRateCardRequest,
  ): Promise<RateCard> {
    const { branchId, ...fields } = input;
    await lockBranchRule(tx, RATE_UNIQUE_RULE, [branchId]);
    throwFirstConflict(await this.duplicateIssues(tx, [input]));
    const created = await tx.rateCard.create({
      data: { ...toData(fields), branchId, createdById: user.id },
    });
    await this.log(tx, user, 'CREATED', [created], (r) =>
      changedFields(null, auditFields(r), RATE_AUDIT_FIELDS),
    );
    return created;
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
    const created = await tx.rateCard.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      orderBy: { id: 'asc' },
    });
    // Every field as written, like a rate created on screen, and where it came from.
    await this.log(tx, user, 'CREATED', created, (r) => [
      ...changedFields(null, auditFields(r), RATE_AUDIT_FIELDS),
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
    // A load type left out follows a changed mode or cargo type, unless the person chose it (B2).
    const merge = (r: RateCard) => {
      const before = { ...fromRow(r), branchId: r.branchId };
      const after = { ...before, ...input };
      return {
        before,
        after: { ...after, loadType: followLoadType(input.loadType, after, before) },
      };
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
      const dto = await this.transition(
        tx,
        current.id,
        'DRAFT',
        toData({ ...input, loadType: after.loadType }),
      );
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
   * For quotation lines: an APPROVED rate of any branch, valid on `onDate` (YYYY-MM-DD, branch
   * time), that prices this quotation: same currency, mode, load type and cargo type, a route that
   * covers the quotation's (each end the place itself, its city or its country, plan 5.3), and no
   * other price category than the line's. 400 on any mismatch. The rate and the scope each end
   * matched at.
   */
  async requireUsableRate(rateId: string, context: RatePricingContext): Promise<ScopedRate> {
    const rate = await this.requireApprovedRate(rateId);
    const day = toDbDate(context.onDate);
    if (rate.validFrom > day || (rate.validTo !== null && rate.validTo < day)) {
      throw new BadRequestException('Rate is not valid today');
    }
    const [origins, destinations] = await Promise.all([
      this.scopesOf(context.originLocationId),
      this.scopesOf(context.destinationLocationId),
    ]);
    const originScope = origins.get(rate.originLocationId);
    const destinationScope = destinations.get(rate.destinationLocationId);
    const category = context.priceCategoryCode ?? null;
    const mismatches = [
      rate.currency !== context.currency && 'currency',
      originScope === undefined && 'origin',
      destinationScope === undefined && 'destination',
      rate.mode !== context.mode && 'mode',
      rate.loadType !== context.loadType && 'load type',
      rate.cargoType !== context.cargoType && 'cargo type',
      category !== null &&
        rate.priceCategoryCode !== null &&
        rate.priceCategoryCode !== category &&
        'price category',
    ].filter((m): m is string => typeof m === 'string');
    if (mismatches.length > 0 || originScope === undefined || destinationScope === undefined) {
      throw new BadRequestException(`Rate does not match the quotation: ${mismatches.join(', ')}`);
    }
    return { rate, originScope, destinationScope };
  }

  /**
   * The rules of a rate card chosen by hand, after requireUsableRate (plan 5.3): a category card
   * needs the line's category chosen first (RATE_CATEGORY_REQUIRED), and a broader card is refused
   * while a narrower one of the same charge, unit and container type matches (RATE_SUPERSEDED,
   * naming it): the narrowest scope is a rule, not a hint.
   */
  async assertRateChoice(
    chosen: ScopedRate,
    context: RatePricingContext,
    fields: readonly string[],
  ): Promise<void> {
    const { rate } = chosen;
    if (rate.priceCategoryCode !== null && !context.priceCategoryCode) {
      throw fieldRefusal(
        'RATE_CATEGORY_REQUIRED',
        `Rate card ${rate.id} prices the category ${rate.priceCategoryCode}: choose the line's ` +
          'price category first',
        fields,
        { category: rate.priceCategoryCode },
      );
    }
    const narrower = (await this.scopedRates(context)).find(
      (r) =>
        r.rate.chargeTypeCode === rate.chargeTypeCode &&
        r.rate.unit === rate.unit &&
        r.rate.containerTypeCode === rate.containerTypeCode &&
        compareScopes(r, chosen) < 0,
    );
    if (narrower) {
      throw fieldRefusal(
        'RATE_SUPERSEDED',
        `Rate card ${narrower.rate.id} prices this route more narrowly ` +
          `(${narrower.originScope} to ${narrower.destinationScope}): use it`,
        fields,
        { rate: narrower.rate.id },
      );
    }
  }

  /**
   * An approved rate of any branch (a quotation line naming it, before the quotation it must match
   * is complete); requireUsableRate checks the rest.
   */
  async requireApprovedRate(rateId: string): Promise<RateCard> {
    const rate = await this.prisma.rateCard.findUnique({ where: { id: rateId } });
    if (!rate || rate.status !== 'APPROVED') {
      throw new BadRequestException('Rate is not an approved rate card');
    }
    return rate;
  }

  /**
   * The locations a rate card may name to price a document's place, by scope (plan 5.3): the
   * place itself, its city, and its country's pricing scope (a COUNTRY location of its country).
   * A city is its own city scope.
   */
  private async scopesOf(locationId: string): Promise<Map<string, PriceScope>> {
    const place = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, kind: true, cityId: true, countryCode: true },
    });
    const scopes = new Map<string, PriceScope>();
    if (!place) return scopes;
    const countries = await this.prisma.location.findMany({
      where: { kind: 'COUNTRY', countryCode: place.countryCode },
      select: { id: true },
    });
    for (const c of countries) scopes.set(c.id, 'COUNTRY');
    if (place.cityId) scopes.set(place.cityId, 'CITY');
    scopes.set(
      place.id,
      place.kind === 'CITY' ? 'CITY' : place.kind === 'COUNTRY' ? 'COUNTRY' : 'PLACE',
    );
    return scopes;
  }

  /**
   * Every APPROVED rate of any branch valid on `onDate` that prices the context (currency, mode,
   * load, cargo, and the charge and unit when given), with a route that covers the document's
   * (scopesOf) and a category the line may use: a line without a category only general cards; a
   * line with one its category's cards and the general ones. Read-only.
   */
  private async scopedRates(context: OpenRateMatchContext): Promise<ScopedRate[]> {
    const day = toDbDate(context.onDate);
    const [origins, destinations] = await Promise.all([
      this.scopesOf(context.originLocationId),
      this.scopesOf(context.destinationLocationId),
    ]);
    const category = context.priceCategoryCode ?? null;
    const rates = await this.prisma.rateCard.findMany({
      where: {
        status: 'APPROVED',
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gte: day } }],
        currency: context.currency,
        originLocationId: { in: [...origins.keys()] },
        destinationLocationId: { in: [...destinations.keys()] },
        mode: context.mode,
        loadType: context.loadType,
        cargoType: context.cargoType,
        AND: [
          category === null
            ? { priceCategoryCode: null }
            : { OR: [{ priceCategoryCode: null }, { priceCategoryCode: category }] },
        ],
        ...(context.chargeTypeCode ? { chargeTypeCode: context.chargeTypeCode } : {}),
        ...(context.unit ? { unit: context.unit } : {}),
      },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    return rates.map((rate) => ({
      rate,
      originScope: origins.get(rate.originLocationId) ?? 'COUNTRY',
      destinationScope: destinations.get(rate.destinationLocationId) ?? 'COUNTRY',
    }));
  }

  /**
   * The offers systemRate chooses from, with their scopes (plan 5.3). For each charge type, only
   * the rates of the narrowest scope that has any: the origin's scope first (place, city,
   * country), then the destination's; at the same scope, the line's category cards before the
   * general ones. Of those, the document's own branch's rates when it has any; else those of
   * every branch (rate cards are shared by all branches): so a city card of any branch beats a
   * country card of the document's branch. One offer per branch, container type, charge and unit
   * (the latest started of rates that differ only by start date: two branches' rates are always
   * two offers). Read-only.
   */
  async systemScopedRates(context: OpenRateMatchContext): Promise<ScopedRate[]> {
    const category = context.priceCategoryCode ?? null;
    const tier = (r: ScopedRate) => [
      SCOPE_RANK[r.originScope],
      SCOPE_RANK[r.destinationScope],
      category !== null && r.rate.priceCategoryCode === category ? 0 : 1,
    ];
    const all = await this.scopedRates(context);
    const best = new Map<string, number[]>();
    for (const r of all) {
      const known = best.get(r.rate.chargeTypeCode);
      if (!known || compareTiers(tier(r), known) < 0) best.set(r.rate.chargeTypeCode, tier(r));
    }
    const narrowest = all.filter(
      (r) => compareTiers(tier(r), best.get(r.rate.chargeTypeCode) ?? []) === 0,
    );
    const own =
      context.branchId === null
        ? []
        : narrowest.filter((r) => r.rate.branchId === context.branchId);
    const offers = new Map<string, ScopedRate>();
    for (const r of own.length > 0 ? own : narrowest) {
      // Per branch: two branches' rates are different offers (rateKey), never revisions of one.
      const offer = [
        r.rate.branchId,
        r.rate.containerTypeCode ?? '',
        r.rate.chargeTypeCode,
        r.rate.unit,
      ].join('|');
      if (!offers.has(offer)) offers.set(offer, r);
    }
    return [...offers.values()];
  }

  /**
   * The locations APPROVED rate cards valid on `onDate` start and end at (any branch: rate cards
   * are shared), for the customer-service catalog. Read-only.
   */
  async approvedRouteEnds(onDate: string): Promise<{ origins: string[]; destinations: string[] }> {
    const day = toDbDate(onDate);
    const rates = await this.prisma.rateCard.findMany({
      where: {
        status: 'APPROVED',
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gte: day } }],
      },
      select: { originLocationId: true, destinationLocationId: true },
      distinct: ['originLocationId', 'destinationLocationId'],
    });
    return {
      origins: [...new Set(rates.map((r) => r.originLocationId))],
      destinations: [...new Set(rates.map((r) => r.destinationLocationId))],
    };
  }

  /**
   * The (mode, load type, currency) of the APPROVED cards valid on `onDate` that cover a route
   * (scopesOf at each end), for a cargo type, a charge and a category the line may use (as
   * scopedRates). The customer-service quote asks the customer when there is more than one, rather
   * than choosing for them. Read-only.
   */
  async routeOfferKinds(
    q: RouteOfferQuery,
  ): Promise<{ mode: ShippingMode; loadType: LoadType | null; currency: string }[]> {
    const day = toDbDate(q.onDate);
    const [origins, destinations] = await Promise.all([
      this.scopesOf(q.originLocationId),
      this.scopesOf(q.destinationLocationId),
    ]);
    const rows = await this.prisma.rateCard.findMany({
      where: {
        status: 'APPROVED',
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gte: day } }],
        originLocationId: { in: [...origins.keys()] },
        destinationLocationId: { in: [...destinations.keys()] },
        cargoType: q.cargoType,
        chargeTypeCode: q.chargeTypeCode,
        AND: [
          q.priceCategoryCode === null
            ? { priceCategoryCode: null }
            : { OR: [{ priceCategoryCode: null }, { priceCategoryCode: q.priceCategoryCode }] },
        ],
      },
      select: { mode: true, loadType: true, currency: true },
      distinct: ['mode', 'loadType', 'currency'],
      orderBy: [{ mode: 'asc' }, { loadType: 'asc' }, { currency: 'asc' }],
    });
    return rows;
  }

  /** systemScopedRates, as the rate cards only. */
  async systemRates(context: RateMatchContext): Promise<RateCard[]> {
    return (await this.systemScopedRates(context)).map((r) => r.rate);
  }

  /**
   * The system price of a line that names no rate card and gives no price: the only offer of
   * systemScopedRates, for this route, mode, load type, cargo type and currency, and for the
   * charge type and unit when given. RATE_NO_MATCH when none matches; RATE_SEVERAL (with the
   * candidates) when the line must say which (a charge type, a unit or the rate card).
   */
  async systemRate(context: RateMatchContext, fields: RateMatchFields): Promise<ScopedRate> {
    const [only, ...others] = await this.systemScopedRates(context);
    if (!only) {
      throw fieldRefusal(
        'RATE_NO_MATCH',
        `No approved rate card matches (route, mode, load, cargo, currency${
          context.chargeTypeCode ? `, charge ${context.chargeTypeCode}` : ''
        }${context.unit ? `, unit ${context.unit}` : ''}${
          context.priceCategoryCode ? `, category ${context.priceCategoryCode}` : ''
        }, valid on ${context.onDate}): enter the price`,
        fields.noMatch,
      );
    }
    if (others.length > 0) {
      const listed = [only, ...others]
        .slice(0, LISTED_RATES)
        .map(
          ({ rate: r }) =>
            `${r.chargeTypeCode} per ${r.unit}${
              r.containerTypeCode ? ` ${r.containerTypeCode}` : ''
            } ${toDecimalString(r.price)} ${r.currency} (rate card ${r.id})`,
        )
        .join('; ');
      throw fieldRefusal(
        'RATE_SEVERAL',
        `${others.length + 1} approved rate cards match: choose one (${listed}), or give the ` +
          'charge type and unit, or enter the price',
        fields.several,
      );
    }
    return only;
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
   * cached per checker, so a file of thousands of rows asks for each code once. A rule whose
   * fields are missing is skipped: the import checks what is left of a row that failed its schema,
   * so every problem of the row shows at once.
   */
  ruleChecker(): (input: Partial<RateCardInput>) => Promise<RuleIssue[]> {
    const routeRefusal = memoAsync((key: string) => {
      const [origin = '', destination = ''] = key.split('|');
      return refusal(() => this.masterData.requireRateRoute(origin, destination));
    });
    const locationRefusal = memoAsync((id: string) =>
      refusal(() => this.masterData.requireRateLocation(id)),
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
    const categoryRefusal = memoAsync((key: string) => {
      const [code = '', cargoType = ''] = key.split('|');
      return refusal(() =>
        this.masterData.requirePriceCategory(code, (cargoType || null) as CargoType | null),
      );
    });
    return async (input) => {
      const issues: RuleIssue[] = [];
      const add = (field: string, code: RuleIssue['code'], message: string) =>
        issues.push({ field, code, message });

      const { originLocationId: from, destinationLocationId: to } = input;
      const route = from && to ? await routeRefusal(`${from}|${to}`) : null;
      if (from && to && route) {
        const origin = await locationRefusal(from);
        const destination = await locationRefusal(to);
        if (origin) add('originLocationId', 'UNKNOWN_LOCATION', origin);
        if (destination) add('destinationLocationId', 'UNKNOWN_LOCATION', destination);
        if (!origin && !destination) add('destinationLocationId', 'SAME_ROUTE', route);
      }
      if (input.mode && !hasSeaLeg(input.mode) && input.loadType) {
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
      } else if (input.cargoType && input.containerTypeCode) {
        add(
          'containerTypeCode',
          'CONTAINER_TYPE_NOT_APPLICABLE',
          'Container type applies to container rates only',
        );
      }
      const charge = await chargeRefusal(input.chargeTypeCode ?? 'FREIGHT');
      if (charge) add('chargeTypeCode', 'UNKNOWN_CHARGE_TYPE', charge);
      const currency = input.currency ? await currencyRefusal(input.currency) : null;
      if (currency) add('currency', 'UNKNOWN_CURRENCY', currency);
      // A category card (plan 5.3): an active category of the card's cargo type.
      if (input.priceCategoryCode) {
        const category = await categoryRefusal(
          `${input.priceCategoryCode}|${input.cargoType ?? ''}`,
        );
        if (category) add('priceCategoryCode', 'INVALID_VALUE', category);
      }
      if (input.validFrom && input.validTo && input.validTo < input.validFrom) {
        add('validTo', 'VALID_TO_BEFORE_FROM', 'Valid-to is before valid-from');
      }
      return issues;
    };
  }
}

/**
 * A new rate as saved: FCL/LCL left out follows the mode and cargo type (functional review B2); a
 * load type given, null included, is kept. Rate card drafts keep theirs as they were checked.
 */
export function withLoadType<T extends CreateRateCardRequest>(input: T): T {
  return { ...input, loadType: followLoadType(input.loadType, input) };
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
  'priceCategoryCode',
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
/** Lexicographic order of two scope tiers: negative when `a` is narrower. */
function compareTiers(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** compareTiers of two rates' scopes, origin first (plan 5.3). */
function compareScopes(a: ScopedRate, b: ScopedRate): number {
  return compareTiers(
    [SCOPE_RANK[a.originScope], SCOPE_RANK[a.destinationScope]],
    [SCOPE_RANK[b.originScope], SCOPE_RANK[b.destinationScope]],
  );
}

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
    priceCategoryCode: r.priceCategoryCode,
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

/** `q` on a rate: its route (location code or name) or its container / charge type code. */
function rateSearch(q: string): Prisma.RateCardWhereInput[] {
  const text = { contains: q, mode: 'insensitive' } as const;
  const location = { OR: [{ code: text }, { nameEn: text }, { nameAr: text }] };
  return [
    { origin: location },
    { destination: location },
    { containerTypeCode: text },
    { chargeTypeCode: text },
  ];
}
