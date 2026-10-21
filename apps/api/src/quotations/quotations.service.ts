import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateQuotationRequest,
  Page,
  PriceScope,
  PriceSourceDto,
  QuotationDefaultsDto,
  QuotationDraftValues,
  QuotationDto,
  QuotationInput,
  QuotationStatus,
  QuotationSummaryDto,
  RateUnit,
} from '@nolon/shared';
import { hasSeaLeg } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope, listBranchScope } from '../auth/branch-scope.js';
import { assertOutletInTx, salesOutletScope } from '../auth/outlet-scope.js';
import { addDays, fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { followLoadType } from '../common/load-type.js';
import {
  localDayFilter,
  matchedLocations,
  type RouteFilters,
  routeWhere,
} from '../common/list-filters.js';
import { ZERO, dec, toDecimalString } from '../common/money.js';
import { formatShortNumber, nextSequenceValue } from '../common/numbering.js';
import { onFields } from '../common/rule-issues.js';
import { fieldRefusal, type PageQuery } from '../common/validation.js';
import { draftBranch } from '../drafts/draft-rules.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { CustomersService } from '../customers/customers.service.js';
import type { Prisma, Quotation, QuotationLine } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type RatePricingContext, RatesService, type ScopedRate } from '../rates/rates.service.js';
import { DiscountExceedsLineError, computeQuotationAmounts } from './quotation-totals.js';

export interface QuotationFilters extends PageQuery, RouteFilters {
  status?: QuotationStatus;
  customerId?: string;
  /** One of the user's branches (403 otherwise); else all of them. */
  branchId?: string;
  /** Created from / to (local day of the branch), both included. */
  from?: string;
  to?: string;
}

type QuotationWithDetails = Quotation & {
  lines: QuotationLine[];
  customer: { name: string };
  booking: { id: string } | null;
};

type Tx = Prisma.TransactionClient;

/** Largest amount a Decimal(18, 4) column holds. */
const MAX_AMOUNT = dec('99999999999999.9999');

const details = {
  lines: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  booking: { select: { id: true } },
} satisfies Prisma.QuotationInclude;

/**
 * Quotations (annex B section 2): DRAFT → SENT → APPROVED (customer accepted) or REJECTED; DRAFT
 * or SENT → EXPIRED. Only an APPROVED quotation becomes a booking. A quotation belongs to its
 * customer's branch, and amounts are computed here from the lines, never taken from the client.
 */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly rates: RatesService,
    private readonly masterData: MasterDataService,
    private readonly currencies: CurrenciesService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async list(user: AuthUser, filters: QuotationFilters): Promise<Page<QuotationSummaryDto>> {
    const route = await this.masterData.matchRoute(filters);
    const created = await localDayFilter(this.prisma, 'createdAt', filters.from, filters.to);
    const where: Prisma.QuotationWhereInput = {
      ...listBranchScope(user, filters.branchId),
      ...salesOutletScope(user),
      AND: created,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...routeWhere(route),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { customer: { name: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.quotation.findMany({
        where,
        include: details,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.quotation.count({ where }),
    ]);
    return {
      items: items.map(toSummary),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      ...matchedLocations(route),
    };
  }

  async get(user: AuthUser, id: string): Promise<QuotationDto> {
    return toDto(await this.findScoped(user, id));
  }

  /**
   * For billing: the agreed currency and lines of the quotation a shipment was booked from. The
   * caller has already checked access to the shipment.
   */
  async invoiceSource(id: string): Promise<{
    id: string;
    updatedAt: Date;
    currency: string;
    lines: {
      chargeTypeCode: string;
      description: string | null;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
      unit: RateUnit;
    }[];
  } | null> {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!quotation) return null;
    return {
      id: quotation.id,
      updatedAt: quotation.updatedAt,
      currency: quotation.currency,
      lines: quotation.lines.map((l) => ({
        chargeTypeCode: l.chargeTypeCode,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        unit: l.unit,
      })),
    };
  }

  /**
   * What a new quotation for this customer starts from (functional review B3, B4). Generated when
   * the person picks the customer on a new quotation: the currency is the customer's preferred one
   * when it is set and active, else the customer's branch's default currency; valid-until is that
   * branch's today plus QUOTATION_VALIDITY_DAYS. Picking another customer asks again. These are
   * suggestions: the form keeps a currency or date the person chose, and create/update still take
   * whatever is sent. The customer must be active and in the user's branches (404 otherwise).
   */
  async defaults(user: AuthUser, customerId: string): Promise<QuotationDefaultsDto> {
    const customer = await this.customers.requireActiveCustomer(user, customerId);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: customer.branchId },
    });
    const today = todayIn(branch.timezone);
    const preferred = customer.preferredCurrency;
    const fromCustomer = preferred !== null && (await this.currencies.isActive(preferred));
    const validityDays = this.env.QUOTATION_VALIDITY_DAYS;
    return {
      customerId: customer.id,
      currency: fromCustomer ? preferred : branch.defaultCurrency,
      currencySource: fromCustomer ? 'CUSTOMER' : 'BRANCH',
      today,
      validUntil: addDays(today, validityDays),
      validityDays,
    };
  }

  async create(user: AuthUser, input: CreateQuotationRequest): Promise<QuotationDto> {
    const prepared = await this.prepareCreate(user, input);
    const created = await this.prisma.$transaction((tx) => this.insertInTx(tx, user, prepared));
    return toDto(created);
  }

  /**
   * Checks a create request for this user and prices it (customer in the user's branches and
   * active, route, currency, rates, valid-until), without writing. insertInTx then records it, so
   * a caller (an approved assistant draft) can do so inside its own transaction.
   */
  async prepareCreate(user: AuthUser, input: CreateQuotationRequest) {
    const customer = await this.customers.requireActiveCustomer(user, input.customerId);
    const branchId = customer.branchId;
    const today = await this.branchToday(branchId);
    const prepared = await this.prepare(branchId, today, input);
    return { customerId: customer.id, branchId, ...prepared };
  }

  /**
   * The checks of prepareCreate on the values a quotation draft holds so far (a draft is saved
   * with missing values): the customer (active, in the user's branches), and each value present
   * checked as a quotation checks it (route, sea-only load type, currency, validity, each line's
   * rate card and charge type). Prices and totals wait for the missing values; prepareCreate runs
   * in full once nothing is missing. Nothing is written.
   */
  async checkPresent(
    user: AuthUser,
    input: QuotationDraftValues,
    givenBranchId: string | null,
  ): Promise<{ customerId: string | null; branchId: string }> {
    const customer = input.customerId
      ? await this.customers.requireActiveCustomer(user, input.customerId)
      : null;
    // The customer's branch, or with none yet the branch the draft names (one of the user's).
    const branchId = draftBranch(user, givenBranchId, customer?.branchId ?? null);
    const from = input.originLocationId ?? null;
    const to = input.destinationLocationId ?? null;
    if (from !== null && to !== null) {
      const route = ['originLocationId', 'destinationLocationId'];
      if (from === to)
        throw fieldRefusal('SAME_ROUTE', 'Origin and destination must differ', route);
      await onFields(route, () => this.masterData.requireRoute(from, to));
    } else if (from !== null) {
      await onFields(['originLocationId'], () => this.masterData.requireLocation(from));
    } else if (to !== null) {
      await onFields(['destinationLocationId'], () => this.masterData.requireLocation(to));
    }
    if (input.mode && !hasSeaLeg(input.mode) && input.loadType) {
      throw fieldRefusal('LOAD_TYPE_SEA_ONLY', 'FCL/LCL applies to sea shipments only', [
        'loadType',
      ]);
    }
    const currency = input.currency;
    if (currency) {
      await onFields(
        ['currency'],
        () => this.currencies.requireActive(currency),
        'CURRENCY_NOT_ACTIVE',
      );
    }
    if (input.validUntil && input.validUntil < (await this.branchToday(branchId))) {
      throw fieldRefusal('VALID_UNTIL_PAST', 'Valid-until is in the past', ['validUntil']);
    }
    for (const [index, line] of input.lines.entries()) {
      const path = `lines.${index}`;
      const rateCardId = line.rateCardId;
      if (rateCardId) {
        await onFields(
          [`${path}.rateCardId`],
          () => this.rates.requireApprovedRate(rateCardId),
          'RATE_NOT_USABLE',
        );
      }
      const chargeTypeCode = line.chargeTypeCode;
      if (chargeTypeCode) {
        await onFields(
          [`${path}.chargeTypeCode`],
          () => this.masterData.requireChargeType(chargeTypeCode),
          'UNKNOWN_CHARGE_TYPE',
        );
      }
    }
    return { customerId: customer?.id ?? null, branchId };
  }

  /**
   * As prepareCreate, for a customer not in NOLON yet (a quotation for a new customer, proposed
   * with it): priced in one of the user's branches, the one the customer will belong to. The
   * caller adds the customer's id once it exists, before insertInTx.
   */
  async prepareForNewCustomer(user: AuthUser, branchId: string, input: QuotationInput) {
    assertBranchAccess(user, branchId);
    const today = await this.branchToday(branchId);
    const prepared = await this.prepare(branchId, today, input);
    return { branchId, ...prepared };
  }

  async insertInTx(
    tx: Tx,
    user: AuthUser,
    prepared: Awaited<ReturnType<QuotationsService['prepareCreate']>>,
  ): Promise<QuotationWithDetails> {
    // Outlet Staff (plan 4.2): sold through their outlet, checked first in the transaction;
    // everyone else records none yet.
    const salesOutletId = await this.customers.outletForSaleInTx(
      tx,
      user,
      prepared.branchId,
      prepared.customerId,
    );
    const number = formatShortNumber('QT', await nextSequenceValue(tx, 'QUOTATION'));
    return tx.quotation.create({
      data: {
        ...prepared.header,
        number,
        branchId: prepared.branchId,
        customerId: prepared.customerId,
        salesOutletId,
        createdById: user.id,
        lines: { create: prepared.lines },
      },
      include: details,
    });
  }

  /** Drafts only; the lines are replaced as a whole. */
  async update(user: AuthUser, id: string, input: QuotationInput): Promise<QuotationDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('Only a draft quotation can be edited');
    }
    const today = await this.branchToday(existing.branchId);
    const prepared = await this.prepare(existing.branchId, today, input, existing);
    await this.prisma.$transaction(async (tx) => {
      await assertOutletInTx(tx, user, existing.salesOutletId, 'Quotation not found');
      await casStatus(tx, id, ['DRAFT'], prepared.header);
      await tx.quotationLine.deleteMany({ where: { quotationId: id } });
      await tx.quotationLine.createMany({
        data: prepared.lines.map((line) => ({ ...line, quotationId: id })),
      });
    });
    return this.get(user, id);
  }

  async send(user: AuthUser, id: string): Promise<QuotationDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') throw new ConflictException('Only a draft can be sent');
    await this.assertNotExpired(existing);
    await this.prisma.$transaction(async (tx) => {
      await assertOutletInTx(tx, user, existing.salesOutletId, 'Quotation not found');
      await casStatus(tx, id, ['DRAFT'], { status: 'SENT', sentAt: new Date() });
    });
    return this.get(user, id);
  }

  /** Records the customer's acceptance. */
  async approve(user: AuthUser, id: string): Promise<QuotationDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'SENT') {
      throw new ConflictException('Only a sent quotation can be approved');
    }
    await this.assertNotExpired(existing);
    await casStatus(this.prisma, id, ['SENT'], { status: 'APPROVED', decidedAt: new Date() });
    return this.get(user, id);
  }

  async reject(user: AuthUser, id: string, reason: string): Promise<QuotationDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'SENT') {
      throw new ConflictException('Only a sent quotation can be rejected');
    }
    await casStatus(this.prisma, id, ['SENT'], {
      status: 'REJECTED',
      rejectionReason: reason,
      decidedAt: new Date(),
    });
    return this.get(user, id);
  }

  async expire(user: AuthUser, id: string): Promise<QuotationDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT' && existing.status !== 'SENT') {
      throw new ConflictException('Only a draft or sent quotation can expire');
    }
    await casStatus(this.prisma, id, [existing.status], { status: 'EXPIRED' });
    return this.get(user, id);
  }

  /** For bookings: an APPROVED quotation in the user's branches. */
  async requireApproved(user: AuthUser, id: string): Promise<Quotation> {
    const quotation = await this.prisma.quotation.findFirst({
      where: { id, ...branchScope(user), ...salesOutletScope(user) },
    });
    if (!quotation) throw new NotFoundException('Quotation not found');
    if (quotation.status !== 'APPROVED') {
      throw new ConflictException('Only an approved quotation can become a booking');
    }
    return quotation;
  }

  /**
   * For bookings: the lines of a quotation (the caller checked it is the user's) priced per
   * container whose rate card names the container type, in line order. A manual line names no
   * container type, so it is not among them.
   */
  async perContainerLines(
    quotationId: string,
  ): Promise<{ containerTypeCode: string; quantity: Prisma.Decimal }[]> {
    const lines = await this.prisma.quotationLine.findMany({
      where: { quotationId, unit: 'PER_CONTAINER', rateCard: { containerTypeCode: { not: null } } },
      select: { quantity: true, rateCard: { select: { containerTypeCode: true } } },
      orderBy: { lineNo: 'asc' },
    });
    return lines.flatMap((l) =>
      l.rateCard?.containerTypeCode
        ? [{ containerTypeCode: l.rateCard.containerTypeCode, quantity: l.quantity }]
        : [],
    );
  }

  private async findScoped(user: AuthUser, id: string): Promise<QuotationWithDetails> {
    const quotation = await this.prisma.quotation.findFirst({
      where: { id, ...branchScope(user), ...salesOutletScope(user) },
      include: details,
    });
    if (!quotation) throw new NotFoundException('Quotation not found');
    return quotation;
  }

  private async branchToday(branchId: string): Promise<string> {
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: branchId } });
    return todayIn(branch.timezone);
  }

  /** Past its validity date, a quotation can no longer be sent or approved: it is marked EXPIRED. */
  private async assertNotExpired(quotation: Quotation): Promise<void> {
    const today = await this.branchToday(quotation.branchId);
    if (fromDbDate(quotation.validUntil) < today) {
      await casStatus(this.prisma, quotation.id, [quotation.status], { status: 'EXPIRED' });
      throw new ConflictException('Quotation has expired');
    }
  }

  /**
   * Checks and prices a quotation. A load type left out follows the mode and cargo type, or on an
   * edit (`stored`) keeps one the person chose (functional review B2).
   */
  private async prepare(
    branchId: string,
    today: string,
    input: QuotationInput,
    stored?: (Quotation & { lines?: QuotationLine[] }) | null,
  ) {
    const route = ['originLocationId', 'destinationLocationId'];
    if (input.originLocationId === input.destinationLocationId) {
      throw fieldRefusal('SAME_ROUTE', 'Origin and destination must differ', route);
    }
    await onFields(route, () =>
      this.masterData.requireRoute(input.originLocationId, input.destinationLocationId),
    );
    if (!hasSeaLeg(input.mode) && input.loadType) {
      throw fieldRefusal('LOAD_TYPE_SEA_ONLY', 'FCL/LCL applies to sea shipments only', [
        'loadType',
      ]);
    }
    const loadType = followLoadType(input.loadType, input, stored);
    const currency = await onFields(
      ['currency'],
      () => this.currencies.requireActive(input.currency),
      'CURRENCY_NOT_ACTIVE',
    );
    if (input.validUntil < today)
      throw fieldRefusal('VALID_UNTIL_PAST', 'Valid-until is in the past', ['validUntil']);

    const pricing = {
      branchId,
      onDate: today,
      currency: input.currency,
      originLocationId: input.originLocationId,
      destinationLocationId: input.destinationLocationId,
      mode: input.mode,
      loadType,
      cargoType: input.cargoType,
    };
    const resolved = [];
    for (const [index, line] of input.lines.entries()) {
      const path = `lines.${index}`;
      const category = line.priceCategoryCode ?? null;
      if (category) {
        await onFields(
          [`${path}.priceCategoryCode`],
          () => this.masterData.requirePriceCategory(category, input.cargoType),
          'PRICE_CATEGORY_NOT_USABLE',
        );
      }
      const context = { ...pricing, priceCategoryCode: category };
      const rateLine = (scoped: ScopedRate) => ({
        rateCardId: scoped.rate.id,
        chargeTypeCode: scoped.rate.chargeTypeCode,
        unit: scoped.rate.unit,
        unitPrice: scoped.rate.price,
        minimumCharge: scoped.rate.minimumCharge,
        description: line.description ?? null,
        quantity: dec(line.quantity),
        discount: dec(line.discount ?? '0'),
        priceCategoryCode: category,
        priceSource: 'RATE_CARD' as const,
        priceSourceSnapshot: sourceSnapshot(scoped, context),
      });
      const suggest = (chargeTypeCode: string | null, unit: RateUnit | null) =>
        // No rate card and no price: the system price, from the one rate card that matches.
        this.rates.systemRate(
          { ...context, chargeTypeCode, unit },
          { noMatch: [`${path}.unitPrice`], several: [`${path}.rateCardId`] },
        );
      if (line.rateCardId) {
        const rateCardId = line.rateCardId;
        // The line as saved, priced from this card (an edit sends the card back).
        const was = stored?.lines?.find((l) => l.rateCardId === rateCardId);
        if (was && stored && sourceChanged(stored, was, context, line.unit)) {
          // Plan 5.2: a price suggested for another route, currency, mode, load, cargo, unit or
          // category is never kept. Priced again from the card that matches now, or refused.
          resolved.push(
            rateLine(await suggest(line.chargeTypeCode ?? was.chargeTypeCode, line.unit ?? null)),
          );
          continue;
        }
        const scoped = await onFields(
          [`${path}.rateCardId`],
          () => this.rates.requireUsableRate(rateCardId, context),
          'RATE_NOT_USABLE',
        );
        // A card newly chosen by hand meets the scope and category rules (plan 5.3); one the line
        // already held keeps its price (a line saved before, without a source, included).
        if (!was) await this.rates.assertRateChoice(scoped, context, [`${path}.rateCardId`]);
        resolved.push(rateLine(scoped));
      } else if (line.unitPrice === undefined) {
        resolved.push(rateLine(await suggest(line.chargeTypeCode ?? null, line.unit ?? null)));
      } else {
        if (!line.unit || !line.chargeTypeCode) {
          const missing = [!line.chargeTypeCode && 'chargeTypeCode', !line.unit && 'unit'].filter(
            (k): k is string => k !== false,
          );
          throw fieldRefusal(
            'MANUAL_LINE_INCOMPLETE',
            'A line without a rate needs a charge type, unit and price',
            missing.map((k) => `${path}.${k}`),
          );
        }
        const chargeTypeCode = line.chargeTypeCode;
        await onFields(
          [`${path}.chargeTypeCode`],
          () => this.masterData.requireChargeType(chargeTypeCode),
          'UNKNOWN_CHARGE_TYPE',
        );
        resolved.push({
          rateCardId: null,
          chargeTypeCode: line.chargeTypeCode,
          unit: line.unit,
          unitPrice: dec(line.unitPrice),
          minimumCharge: ZERO,
          description: line.description ?? null,
          quantity: dec(line.quantity),
          discount: dec(line.discount ?? '0'),
          priceCategoryCode: category,
          priceSource: 'TYPED' as const,
          priceSourceSnapshot: undefined,
        });
      }
    }

    let amounts;
    try {
      amounts = computeQuotationAmounts(resolved, currency.decimalPlaces);
    } catch (error) {
      if (error instanceof DiscountExceedsLineError) {
        throw fieldRefusal('DISCOUNT_EXCEEDS_LINE', error.message, [
          `lines.${error.lineNo - 1}.discount`,
        ]);
      }
      throw error;
    }
    // Every line amount is at most the subtotal, so one check keeps all of them in Decimal(18, 4).
    if (amounts.subtotal.gt(MAX_AMOUNT)) {
      throw new BadRequestException('Amounts are too large');
    }

    return {
      header: {
        originLocationId: input.originLocationId,
        destinationLocationId: input.destinationLocationId,
        mode: input.mode,
        loadType,
        cargoType: input.cargoType,
        cargoDescription: input.cargoDescription ?? null,
        currency: currency.code,
        validUntil: toDbDate(input.validUntil),
        terms: input.terms ?? null,
        subtotal: amounts.subtotal,
        discountTotal: amounts.discountTotal,
        total: amounts.total,
      },
      lines: resolved.map((line, index) => ({
        ...line,
        lineNo: index + 1,
        discount: amounts.lines[index]?.discount ?? ZERO,
        lineTotal: amounts.lines[index]?.lineTotal ?? ZERO,
      })),
    };
  }
}

/** Status compare-and-set: two concurrent transitions cannot both win. */
async function casStatus(
  db: Tx,
  id: string,
  from: QuotationStatus[],
  data: Prisma.QuotationUncheckedUpdateManyInput,
): Promise<void> {
  const { count } = await db.quotation.updateMany({ where: { id, status: { in: from } }, data });
  if (count === 0) throw new ConflictException('Quotation changed meanwhile; reload and retry');
}

function toSummary(q: QuotationWithDetails): QuotationSummaryDto {
  return {
    id: q.id,
    number: q.number,
    branchId: q.branchId,
    customerId: q.customerId,
    customerName: q.customer.name,
    originLocationId: q.originLocationId,
    destinationLocationId: q.destinationLocationId,
    mode: q.mode,
    currency: q.currency,
    total: toDecimalString(q.total),
    validUntil: fromDbDate(q.validUntil),
    status: q.status,
    createdAt: q.createdAt.toISOString(),
  };
}

function toDto(q: QuotationWithDetails): QuotationDto {
  return {
    ...toSummary(q),
    loadType: q.loadType,
    cargoType: q.cargoType,
    cargoDescription: q.cargoDescription,
    subtotal: toDecimalString(q.subtotal),
    discountTotal: toDecimalString(q.discountTotal),
    terms: q.terms,
    rejectionReason: q.rejectionReason,
    sentAt: q.sentAt?.toISOString() ?? null,
    decidedAt: q.decidedAt?.toISOString() ?? null,
    bookingId: q.booking?.id ?? null,
    lines: q.lines.map((l) => ({
      lineNo: l.lineNo,
      chargeTypeCode: l.chargeTypeCode,
      description: l.description,
      rateCardId: l.rateCardId,
      priceCategoryCode: l.priceCategoryCode,
      priceSource: l.priceSource,
      priceSourceDetail: sourceDetail(l),
      unit: l.unit,
      quantity: toDecimalString(l.quantity),
      unitPrice: toDecimalString(l.unitPrice),
      minimumCharge: toDecimalString(l.minimumCharge),
      discount: toDecimalString(l.discount),
      lineTotal: toDecimalString(l.lineTotal),
    })),
  };
}

/**
 * What a RATE_CARD line's price was suggested from (plan 5.2), kept on the line: the card (and its
 * last change), its currency, unit and category, the route it covers with each end's scope, and
 * the quotation's route, mode, load and cargo it priced. Read back by sourceDetail.
 */
function sourceSnapshot(scoped: ScopedRate, context: RatePricingContext): Prisma.InputJsonObject {
  const { rate } = scoped;
  return {
    rateCardId: rate.id,
    rateUpdatedAt: rate.updatedAt.toISOString(),
    currency: rate.currency,
    unit: rate.unit,
    priceCategoryCode: rate.priceCategoryCode,
    originLocationId: rate.originLocationId,
    originScope: scoped.originScope,
    destinationLocationId: rate.destinationLocationId,
    destinationScope: scoped.destinationScope,
    price: toDecimalString(rate.price),
    minimumCharge: toDecimalString(rate.minimumCharge),
    priced: {
      originLocationId: context.originLocationId,
      destinationLocationId: context.destinationLocationId,
      mode: context.mode,
      loadType: context.loadType,
      cargoType: context.cargoType,
      priceCategoryCode: context.priceCategoryCode ?? null,
    },
  };
}

/** The saved source of a RATE_CARD line, for the screen; null for a line without one. */
function sourceDetail(l: QuotationLine): PriceSourceDto | null {
  const v = l.priceSourceSnapshot;
  if (l.priceSource !== 'RATE_CARD' || v === null || typeof v !== 'object' || Array.isArray(v)) {
    return null;
  }
  const text = (key: string): string => {
    const x = v[key];
    return typeof x === 'string' ? x : '';
  };
  const scope = (key: string): PriceScope => {
    const x = v[key];
    return x === 'CITY' || x === 'COUNTRY' ? x : 'PLACE';
  };
  return {
    rateCardId: text('rateCardId'),
    currency: text('currency'),
    unit: l.unit,
    priceCategoryCode: typeof v.priceCategoryCode === 'string' ? v.priceCategoryCode : null,
    originLocationId: text('originLocationId'),
    originScope: scope('originScope'),
    destinationLocationId: text('destinationLocationId'),
    destinationScope: scope('destinationScope'),
    price: text('price'),
    minimumCharge: text('minimumCharge'),
  };
}

/**
 * Whether an edit changed what a saved rate card line was priced for (plan 5.2): the quotation's
 * currency, route, mode, load or cargo, or the line's unit or category. Compared with the
 * quotation as saved, so a line saved before sources were kept is covered too.
 */
function sourceChanged(
  stored: Quotation,
  was: QuotationLine,
  now: RatePricingContext,
  unit: RateUnit | undefined,
): boolean {
  return (
    stored.currency !== now.currency ||
    stored.originLocationId !== now.originLocationId ||
    stored.destinationLocationId !== now.destinationLocationId ||
    stored.mode !== now.mode ||
    stored.loadType !== now.loadType ||
    stored.cargoType !== now.cargoType ||
    (unit !== undefined && unit !== was.unit) ||
    (was.priceCategoryCode ?? null) !== (now.priceCategoryCode ?? null)
  );
}
