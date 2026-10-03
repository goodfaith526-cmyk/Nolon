import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BookingDto,
  BookingFromQuotationRequest,
  BookingInput,
  BookingItemInput,
  BookingService,
  BookingStatus,
  BookingSummaryDto,
  CreateBookingRequest,
  Page,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDateOrNull, toDbDate, todayIn } from '../common/dates.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { PageQuery } from '../common/validation.js';
import { CustomersService } from '../customers/customers.service.js';
import type { Booking, BookingItem, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { cbmFromDimensions } from './cbm.js';

export interface BookingFilters extends PageQuery {
  status?: BookingStatus;
  customerId?: string;
}

type BookingWithDetails = Booking & { items: BookingItem[]; customer: { name: string } };

type Tx = Prisma.TransactionClient;

/** Largest value `booking_items.volume_cbm` (Decimal(12, 4)) holds. */
const MAX_VOLUME_CBM = dec('99999999.9999');

const details = {
  items: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
} satisfies Prisma.BookingInclude;

/**
 * Bookings (annex B section 3): DRAFT → CONFIRMED → COMPLETED (when its shipment closes, group 3);
 * DRAFT or CONFIRMED → CANCELLED. Created directly or from an APPROVED quotation (at most one
 * booking per quotation). A booking belongs to its customer's branch.
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly quotations: QuotationsService,
    private readonly masterData: MasterDataService,
  ) {}

  async list(user: AuthUser, filters: BookingFilters): Promise<Page<BookingSummaryDto>> {
    const where: Prisma.BookingWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
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
      this.prisma.booking.findMany({
        where,
        include: details,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.booking.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<BookingDto> {
    return toDto(await this.findScoped(user, id));
  }

  async create(user: AuthUser, input: CreateBookingRequest): Promise<BookingDto> {
    const customer = await this.customers.requireActiveCustomer(user, input.customerId);
    const prepared = await this.prepare(customer.id, input);
    return this.insert(user, customer.branchId, customer.id, null, prepared);
  }

  async createFromQuotation(
    user: AuthUser,
    quotationId: string,
    input: BookingFromQuotationRequest,
  ): Promise<BookingDto> {
    const quotation = await this.quotations.requireApproved(user, quotationId);
    const customer = await this.customers.requireActiveCustomer(user, quotation.customerId);
    const prepared = await this.prepare(customer.id, {
      originLocationId: quotation.originLocationId,
      destinationLocationId: quotation.destinationLocationId,
      mode: quotation.mode,
      loadType: quotation.loadType,
      cargoType: quotation.cargoType,
      cargoDescription: quotation.cargoDescription,
      services: input.services ?? ['MAIN_FREIGHT'],
      shipperId: input.shipperId,
      consigneeId: input.consigneeId,
      notifyPartyId: input.notifyPartyId,
      requestedDeparture: input.requestedDeparture,
      specialInstructions: input.specialInstructions,
      items: input.items ?? [],
    });
    try {
      return await this.insert(user, quotation.branchId, customer.id, quotation.id, prepared);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This quotation already has a booking');
      }
      throw error;
    }
  }

  /** Drafts only; the items are replaced as a whole. */
  async update(user: AuthUser, id: string, input: BookingInput): Promise<BookingDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT')
      throw new ConflictException('Only a draft booking can be edited');
    const prepared = await this.prepare(existing.customerId, input);
    await this.prisma.$transaction(async (tx) => {
      await casStatus(tx, id, ['DRAFT'], prepared.header);
      await tx.bookingItem.deleteMany({ where: { bookingId: id } });
      await tx.bookingItem.createMany({
        data: prepared.items.map((item) => ({ ...item, bookingId: id })),
      });
    });
    return this.get(user, id);
  }

  /**
   * Confirmation is what will create the booking's shipment (group 3). Status and cargo lines are
   * checked under the booking row lock: a concurrent draft edit (which takes the same lock when it
   * changes the status row) either finishes first and is seen, or waits and then finds the booking
   * confirmed.
   */
  async confirm(user: AuthUser, id: string): Promise<BookingDto> {
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "bookings" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (rows[0]?.status !== 'DRAFT') {
        throw new ConflictException('Only a draft booking can be confirmed');
      }
      if ((await tx.bookingItem.count({ where: { bookingId: id } })) === 0) {
        throw new BadRequestException('Add at least one cargo line before confirming');
      }
      await tx.booking.update({
        where: { id },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
    });
    return this.get(user, id);
  }

  /**
   * Annex B: cancellation is allowed before COMPLETED, provided the booking has no non-cancelled
   * invoices. Invoices arrive with billing (group 4), which adds that check here.
   */
  async cancel(user: AuthUser, id: string, reason: string): Promise<BookingDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT' && existing.status !== 'CONFIRMED') {
      throw new ConflictException('Only a draft or confirmed booking can be cancelled');
    }
    await casStatus(this.prisma, id, [existing.status], {
      status: 'CANCELLED',
      cancelReason: reason,
    });
    return this.get(user, id);
  }

  private async insert(
    user: AuthUser,
    branchId: string,
    customerId: string,
    quotationId: string | null,
    prepared: Awaited<ReturnType<BookingsService['prepare']>>,
  ): Promise<BookingDto> {
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: branchId } });
    const year = todayIn(branch.timezone).slice(0, 4);
    const created = await this.prisma.$transaction(async (tx) => {
      const number = formatDocumentNumber('BK', await nextSequenceValue(tx, 'BOOKING', year), year);
      return tx.booking.create({
        data: {
          ...prepared.header,
          number,
          branchId,
          customerId,
          quotationId,
          createdById: user.id,
          items: { create: prepared.items },
        },
        include: details,
      });
    });
    return toDto(created);
  }

  private async findScoped(user: AuthUser, id: string): Promise<BookingWithDetails> {
    const booking = await this.prisma.booking.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  private async prepare(customerId: string, input: BookingInput) {
    await this.masterData.requireRoute(input.originLocationId, input.destinationLocationId);
    if (input.mode !== 'SEA' && input.loadType) {
      throw new BadRequestException('FCL/LCL applies to sea shipments only');
    }
    const services: BookingService[] = [...new Set(input.services)];
    if (services.length === 0) throw new BadRequestException('Choose at least one service');
    await this.customers.requireOwnParties(customerId, [
      input.shipperId,
      input.consigneeId,
      input.notifyPartyId,
    ]);
    const items = [];
    for (const [index, item] of input.items.entries()) {
      items.push({ lineNo: index + 1, ...(await this.prepareItem(item)) });
    }
    return {
      header: {
        originLocationId: input.originLocationId,
        destinationLocationId: input.destinationLocationId,
        mode: input.mode,
        loadType: input.loadType ?? null,
        cargoType: input.cargoType,
        cargoDescription: input.cargoDescription ?? null,
        services,
        shipperId: input.shipperId ?? null,
        consigneeId: input.consigneeId ?? null,
        notifyPartyId: input.notifyPartyId ?? null,
        requestedDeparture: input.requestedDeparture ? toDbDate(input.requestedDeparture) : null,
        specialInstructions: input.specialInstructions ?? null,
      },
      items,
    };
  }

  private async prepareItem(item: BookingItemInput) {
    if (item.cargoType === 'CONTAINER') {
      if (!item.containerTypeCode) {
        throw new BadRequestException('A container line needs a container type');
      }
      await this.masterData.requireContainerType(item.containerTypeCode);
    } else if (item.containerTypeCode) {
      throw new BadRequestException('Container type applies to container lines only');
    }
    const length = item.lengthCm ? dec(item.lengthCm) : null;
    const width = item.widthCm ? dec(item.widthCm) : null;
    const height = item.heightCm ? dec(item.heightCm) : null;
    const dimensions = [length, width, height].filter((d) => d !== null).length;
    if (dimensions !== 0 && dimensions !== 3) {
      throw new BadRequestException('Give length, width and height together');
    }
    const volumeCbm =
      length && width && height
        ? cbmFromDimensions(length, width, height, item.quantity)
        : item.volumeCbm
          ? dec(item.volumeCbm)
          : null;
    if (volumeCbm?.gt(MAX_VOLUME_CBM)) {
      throw new BadRequestException('Volume is too large; check the dimensions and quantity');
    }
    return {
      cargoType: item.cargoType,
      containerTypeCode: item.containerTypeCode ?? null,
      description: item.description ?? null,
      quantity: item.quantity,
      lengthCm: length,
      widthCm: width,
      heightCm: height,
      weightKg: item.weightKg ? dec(item.weightKg) : null,
      volumeCbm,
    };
  }
}

/** Status compare-and-set: two concurrent transitions cannot both win. */
async function casStatus(
  db: Tx,
  id: string,
  from: BookingStatus[],
  data: Prisma.BookingUncheckedUpdateManyInput,
): Promise<void> {
  const { count } = await db.booking.updateMany({ where: { id, status: { in: from } }, data });
  if (count === 0) throw new ConflictException('Booking changed meanwhile; reload and retry');
}

function toSummary(b: BookingWithDetails): BookingSummaryDto {
  return {
    id: b.id,
    number: b.number,
    branchId: b.branchId,
    customerId: b.customerId,
    customerName: b.customer.name,
    quotationId: b.quotationId,
    originLocationId: b.originLocationId,
    destinationLocationId: b.destinationLocationId,
    mode: b.mode,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
  };
}

function toDto(b: BookingWithDetails): BookingDto {
  return {
    ...toSummary(b),
    loadType: b.loadType,
    cargoType: b.cargoType,
    cargoDescription: b.cargoDescription,
    services: b.services,
    shipperId: b.shipperId,
    consigneeId: b.consigneeId,
    notifyPartyId: b.notifyPartyId,
    requestedDeparture: fromDbDateOrNull(b.requestedDeparture),
    specialInstructions: b.specialInstructions,
    cancelReason: b.cancelReason,
    confirmedAt: b.confirmedAt?.toISOString() ?? null,
    items: b.items.map((i) => ({
      lineNo: i.lineNo,
      cargoType: i.cargoType,
      containerTypeCode: i.containerTypeCode,
      description: i.description,
      quantity: i.quantity,
      lengthCm: toDecimalStringOrNull(i.lengthCm),
      widthCm: toDecimalStringOrNull(i.widthCm),
      heightCm: toDecimalStringOrNull(i.heightCm),
      weightKg: toDecimalStringOrNull(i.weightKg),
      volumeCbm: toDecimalStringOrNull(i.volumeCbm),
    })),
  };
}
