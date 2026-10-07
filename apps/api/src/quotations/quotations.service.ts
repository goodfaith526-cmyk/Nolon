import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateQuotationRequest,
  Page,
  QuotationDto,
  QuotationInput,
  QuotationStatus,
  QuotationSummaryDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope, listBranchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { localDayFilter, type RouteFilters, routeWhere } from '../common/list-filters.js';
import { ZERO, dec, toDecimalString } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { CustomersService } from '../customers/customers.service.js';
import type { Prisma, Quotation, QuotationLine } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RatesService } from '../rates/rates.service.js';
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
  ) {}

  async list(user: AuthUser, filters: QuotationFilters): Promise<Page<QuotationSummaryDto>> {
    const created = await localDayFilter(this.prisma, 'createdAt', filters.from, filters.to);
    const where: Prisma.QuotationWhereInput = {
      ...listBranchScope(user, filters.branchId),
      AND: created,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...routeWhere(filters),
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
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<QuotationDto> {
    return toDto(await this.findScoped(user, id));
  }

  /**
   * For billing: the agreed currency and lines of the quotation a shipment was booked from. The
   * caller has already checked access to the shipment.
   */
  async invoiceSource(id: string): Promise<{
    currency: string;
    lines: {
      chargeTypeCode: string;
      description: string | null;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
      unit: string;
    }[];
  } | null> {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!quotation) return null;
    return {
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

  async create(user: AuthUser, input: CreateQuotationRequest): Promise<QuotationDto> {
    const customer = await this.customers.requireActiveCustomer(user, input.customerId);
    const branchId = customer.branchId;
    const today = await this.branchToday(branchId);
    const prepared = await this.prepare(branchId, today, input);
    const created = await this.prisma.$transaction(async (tx) => {
      const year = today.slice(0, 4);
      const number = formatDocumentNumber(
        'QT',
        await nextSequenceValue(tx, 'QUOTATION', year),
        year,
      );
      return tx.quotation.create({
        data: {
          ...prepared.header,
          number,
          branchId,
          customerId: customer.id,
          createdById: user.id,
          lines: { create: prepared.lines },
        },
        include: details,
      });
    });
    return toDto(created);
  }

  /** Drafts only; the lines are replaced as a whole. */
  async update(user: AuthUser, id: string, input: QuotationInput): Promise<QuotationDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('Only a draft quotation can be edited');
    }
    const today = await this.branchToday(existing.branchId);
    const prepared = await this.prepare(existing.branchId, today, input);
    await this.prisma.$transaction(async (tx) => {
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
    await casStatus(this.prisma, id, ['DRAFT'], { status: 'SENT', sentAt: new Date() });
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
      where: { id, ...branchScope(user) },
    });
    if (!quotation) throw new NotFoundException('Quotation not found');
    if (quotation.status !== 'APPROVED') {
      throw new ConflictException('Only an approved quotation can become a booking');
    }
    return quotation;
  }

  private async findScoped(user: AuthUser, id: string): Promise<QuotationWithDetails> {
    const quotation = await this.prisma.quotation.findFirst({
      where: { id, ...branchScope(user) },
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

  private async prepare(branchId: string, today: string, input: QuotationInput) {
    await this.masterData.requireRoute(input.originLocationId, input.destinationLocationId);
    if (input.mode !== 'SEA' && input.loadType) {
      throw new BadRequestException('FCL/LCL applies to sea shipments only');
    }
    const currency = await this.currencies.requireActive(input.currency);
    if (input.validUntil < today) throw new BadRequestException('Valid-until is in the past');

    const resolved = [];
    for (const line of input.lines) {
      if (line.rateCardId) {
        const rate = await this.rates.requireUsableRate(line.rateCardId, {
          branchId,
          onDate: today,
          currency: input.currency,
          originLocationId: input.originLocationId,
          destinationLocationId: input.destinationLocationId,
          mode: input.mode,
          loadType: input.loadType ?? null,
          cargoType: input.cargoType,
        });
        resolved.push({
          rateCardId: rate.id,
          chargeTypeCode: rate.chargeTypeCode,
          unit: rate.unit,
          unitPrice: rate.price,
          minimumCharge: rate.minimumCharge,
          description: line.description ?? null,
          quantity: dec(line.quantity),
          discount: dec(line.discount ?? '0'),
        });
      } else {
        if (!line.unit || line.unitPrice === undefined || !line.chargeTypeCode) {
          throw new BadRequestException(
            'A line without a rate needs a charge type, unit and price',
          );
        }
        await this.masterData.requireChargeType(line.chargeTypeCode);
        resolved.push({
          rateCardId: null,
          chargeTypeCode: line.chargeTypeCode,
          unit: line.unit,
          unitPrice: dec(line.unitPrice),
          minimumCharge: ZERO,
          description: line.description ?? null,
          quantity: dec(line.quantity),
          discount: dec(line.discount ?? '0'),
        });
      }
    }

    let amounts;
    try {
      amounts = computeQuotationAmounts(resolved, currency.decimalPlaces);
    } catch (error) {
      if (error instanceof DiscountExceedsLineError) throw new BadRequestException(error.message);
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
        loadType: input.loadType ?? null,
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
      unit: l.unit,
      quantity: toDecimalString(l.quantity),
      unitPrice: toDecimalString(l.unitPrice),
      minimumCharge: toDecimalString(l.minimumCharge),
      discount: toDecimalString(l.discount),
      lineTotal: toDecimalString(l.lineTotal),
    })),
  };
}
