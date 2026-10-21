import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BookingDraftDirect,
  BookingDraftFromQuotation,
  BookingDraftItem,
  BookingDto,
  BookingFromQuotationPreviewDto,
  BookingFromQuotationRequest,
  BookingInput,
  BookingItemInput,
  BookingPartySuggestionDto,
  BookingService,
  BookingStatus,
  BookingSummaryDto,
  CreateBookingRequest,
  NewCustomerBookingRequest,
  Page,
} from '@nolon/shared';
import { hasSeaLeg } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope, listBranchScope } from '../auth/branch-scope.js';
import { outletForWrite, salesOutletScope } from '../auth/outlet-scope.js';
import { fromDbDateOrNull, toDbDate } from '../common/dates.js';
import {
  localDayFilter,
  matchedLocations,
  type RouteFilters,
  routeWhere,
} from '../common/list-filters.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import { formatShortNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { onFields } from '../common/rule-issues.js';
import { fieldRefusal, type PageQuery } from '../common/validation.js';
import { draftBranch } from '../drafts/draft-rules.js';
import { CustomersService } from '../customers/customers.service.js';
import type { Booking, BookingItem, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { bookingCargoHeader, type BookingCargo } from './booking-cargo.js';
import { bookingItemMissingFields } from './booking-draft-missing.js';
import { cbmFromDimensions } from './cbm.js';

export interface BookingFilters extends PageQuery, RouteFilters {
  status?: BookingStatus;
  customerId?: string;
  /** One of the user's branches (403 otherwise); else all of them. */
  branchId?: string;
  /** Created from / to (local day of the branch), both included. */
  from?: string;
  to?: string;
}

type BookingWithDetails = Booking & {
  items: BookingItem[];
  customer: { name: string };
  shipment: { id: string; number: string } | null;
};

type Tx = Prisma.TransactionClient;

/** Largest value `booking_items.volume_cbm` (Decimal(12, 4)) holds. */
const MAX_VOLUME_CBM = dec('99999999.9999');

/** Largest quantity a cargo line takes (the request schema's limit). */
const MAX_ITEM_QUANTITY = 100_000;

const details = {
  items: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  shipment: { select: { id: true, number: true } },
} satisfies Prisma.BookingInclude;

/**
 * Bookings (annex B section 3): DRAFT → CONFIRMED → COMPLETED (when its shipment closes);
 * DRAFT or CONFIRMED → CANCELLED. Confirming creates the booking's one shipment. Created directly or from an APPROVED quotation (at most one
 * booking per quotation). A booking belongs to its customer's branch.
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly quotations: QuotationsService,
    private readonly masterData: MasterDataService,
    private readonly shipments: ShipmentsService,
  ) {}

  async list(user: AuthUser, filters: BookingFilters): Promise<Page<BookingSummaryDto>> {
    const route = await this.masterData.matchRoute(filters);
    const created = await localDayFilter(this.prisma, 'createdAt', filters.from, filters.to);
    const where: Prisma.BookingWhereInput = {
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
      this.prisma.booking.findMany({
        where,
        include: details,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.booking.count({ where }),
    ]);
    return {
      items: items.map(toSummary),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      ...matchedLocations(route),
    };
  }

  async get(user: AuthUser, id: string): Promise<BookingDto> {
    return toDto(await this.findScoped(user, id));
  }

  async create(user: AuthUser, input: CreateBookingRequest): Promise<BookingDto> {
    return this.insert(user, await this.prepareCreate(user, input));
  }

  async createFromQuotation(
    user: AuthUser,
    quotationId: string,
    input: BookingFromQuotationRequest,
  ): Promise<BookingDto> {
    return this.insert(user, await this.prepareFromQuotation(user, quotationId, input));
  }

  /**
   * The parties a new booking of this customer may start from (functional review B5). Generated
   * when the person picks the customer on a new booking: the shipper, consignee and notify party
   * of the customer's latest booking (not cancelled, in the user's branches) that names any, else
   * the customer's only party as consignee when it has exactly one. Each suggested party is
   * checked to be the customer's still. Picking another customer asks again and drops the old
   * suggestion; the form shows where it comes from and keeps a party the person chose; the save
   * checks each party again. The customer must be active and in the user's branches (404).
   */
  async partySuggestion(user: AuthUser, customerId: string): Promise<BookingPartySuggestionDto> {
    const customer = await this.customers.requireActiveCustomer(user, customerId);
    return this.suggestParties(user, customer.id);
  }

  /**
   * What a booking made from this approved quotation starts from (functional review B1), for the
   * person to review and then save with createFromQuotation; nothing is written here. Generated
   * when the person opens "To booking": route, mode, load type and cargo are the quotation's (a
   * booking from a quotation keeps them); the container lines come from the quotation lines priced
   * per container whose rate card names an active container type, one line per container type
   * with the largest whole quantity of its lines (two charges on the same containers, freight and
   * handling say, are the same containers, not twice as many). Other charges are never turned
   * into cargo lines. The parties are partySuggestion's. Whatever the person changes before saving
   * is what is saved.
   */
  async previewFromQuotation(
    user: AuthUser,
    quotationId: string,
  ): Promise<BookingFromQuotationPreviewDto> {
    const quotation = await this.quotations.requireApproved(user, quotationId);
    const customer = await this.customers.requireActiveCustomer(user, quotation.customerId);
    requireSameBranch(quotation.branchId, customer.branchId);
    const existing = await this.prisma.booking.findFirst({
      where: { quotationId: quotation.id },
      select: { id: true },
    });
    if (existing) throw new ConflictException('This quotation already has a booking');
    const items: BookingItemInput[] = [];
    if (quotation.cargoType === 'CONTAINER') {
      const lines = await this.quotations.perContainerLines(quotation.id);
      const active = await this.masterData.activeContainerTypeCodes(
        lines.map((l) => l.containerTypeCode),
      );
      const containers = new Map<string, number>();
      for (const line of lines) {
        // A booking counts whole containers (1 to 100000, as a cargo line takes).
        if (!active.has(line.containerTypeCode) || !line.quantity.isInteger()) continue;
        if (line.quantity.lt(1) || line.quantity.gt(MAX_ITEM_QUANTITY)) continue;
        // A count of containers (whole, checked above), not an amount.
        const quantity = line.quantity.toNumber();
        containers.set(
          line.containerTypeCode,
          Math.max(quantity, containers.get(line.containerTypeCode) ?? 0),
        );
      }
      for (const [containerTypeCode, quantity] of containers) {
        items.push({ cargoType: 'CONTAINER', containerTypeCode, quantity });
      }
    }
    return {
      quotationId: quotation.id,
      quotationNumber: quotation.number,
      branchId: quotation.branchId,
      customerId: customer.id,
      customerName: customer.name,
      originLocationId: quotation.originLocationId,
      destinationLocationId: quotation.destinationLocationId,
      mode: quotation.mode,
      loadType: quotation.loadType,
      cargoType: quotation.cargoType,
      cargoDescription: quotation.cargoDescription,
      items,
      parties: await this.suggestParties(user, customer.id),
    };
  }

  private async suggestParties(
    user: AuthUser,
    customerId: string,
  ): Promise<BookingPartySuggestionDto> {
    const own = new Set(await this.customers.partyIds(customerId));
    const none = {
      customerId,
      source: null,
      bookingId: null,
      bookingNumber: null,
      shipperId: null,
      consigneeId: null,
      notifyPartyId: null,
    };
    const last = await this.prisma.booking.findFirst({
      where: {
        customerId,
        ...branchScope(user),
        ...salesOutletScope(user),
        status: { not: 'CANCELLED' },
        OR: [
          { shipperId: { not: null } },
          { consigneeId: { not: null } },
          { notifyPartyId: { not: null } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, number: true, shipperId: true, consigneeId: true, notifyPartyId: true },
    });
    const kept = (id: string | null) => (id !== null && own.has(id) ? id : null);
    if (last) {
      const parties = {
        shipperId: kept(last.shipperId),
        consigneeId: kept(last.consigneeId),
        notifyPartyId: kept(last.notifyPartyId),
      };
      if (parties.shipperId || parties.consigneeId || parties.notifyPartyId) {
        return {
          ...none,
          source: 'LAST_BOOKING',
          bookingId: last.id,
          bookingNumber: last.number,
          ...parties,
        };
      }
    }
    const [only, ...more] = own;
    if (only !== undefined && more.length === 0) {
      return { ...none, source: 'ONLY_PARTY', consigneeId: only };
    }
    return none;
  }

  /**
   * Checks a create request for this user without writing (customer in the user's branches and
   * active, route, parties, cargo lines). insertInTx then records it, so a caller (an approved
   * assistant draft) can do so inside its own transaction.
   */
  async prepareCreate(user: AuthUser, input: CreateBookingRequest): Promise<PreparedBooking> {
    const customer = await this.customers.requireActiveCustomer(user, input.customerId);
    const prepared = await this.prepare(customer.id, input);
    return { branchId: customer.branchId, customerId: customer.id, quotationId: null, ...prepared };
  }

  /**
   * The checks of prepareCreate that need no customer (route, sea-only load type, services, cargo
   * lines and their container types), for a booking proposed with a customer not in NOLON yet.
   * prepareCreate runs them all again once the customer exists. Nothing is written.
   */
  async prepareWithoutCustomer(input: NewCustomerBookingRequest): Promise<void> {
    await this.prepare(null, input);
  }

  /**
   * prepareWithoutCustomer for a booking whose new customer is created in the same transaction
   * (a booking for a new customer approved with its customer draft): the booking to insert, in
   * `branchId` (the customer's), once that customer's id is known. A new customer is active, in
   * the user's branch, and has no parties yet, so nothing of prepareCreate is left unchecked.
   */
  async prepareForNewCustomer(
    input: NewCustomerBookingRequest,
    branchId: string,
  ): Promise<(customerId: string) => PreparedBooking> {
    const prepared = await this.prepare(null, input);
    return (customerId) => ({ branchId, customerId, quotationId: null, ...prepared });
  }

  /** As prepareCreate, for a booking made from an approved quotation of the user's branches. */
  async prepareFromQuotation(
    user: AuthUser,
    quotationId: string,
    input: BookingFromQuotationRequest,
  ): Promise<PreparedBooking> {
    const quotation = await this.quotations.requireApproved(user, quotationId);
    const customer = await this.customers.requireActiveCustomer(user, quotation.customerId);
    requireSameBranch(quotation.branchId, customer.branchId);
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
    return {
      branchId: quotation.branchId,
      customerId: customer.id,
      quotationId: quotation.id,
      ...prepared,
    };
  }

  /**
   * The checks of prepareCreate on the values a direct booking draft holds so far (a draft is
   * saved with missing values): the customer (active, in the user's branches), and each value
   * present checked as a booking checks it; what is missing is left for the person to fill in.
   * prepareCreate runs in full once nothing is missing. Nothing is written.
   */
  async checkPresent(
    user: AuthUser,
    input: BookingDraftDirect,
    givenBranchId: string | null,
  ): Promise<{ branchId: string; customerId: string | null }> {
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
    await this.checkPresentLines(customer?.id ?? null, input);
    return { branchId, customerId: customer?.id ?? null };
  }

  /** As checkPresent, for a booking draft made from an approved quotation of the user's branches. */
  async checkPresentFromQuotation(
    user: AuthUser,
    quotationId: string,
    input: BookingDraftFromQuotation,
  ): Promise<{ branchId: string; customerId: string; quotationId: string }> {
    const quotation = await this.quotations.requireApproved(user, quotationId);
    const customer = await this.customers.requireActiveCustomer(user, quotation.customerId);
    requireSameBranch(quotation.branchId, customer.branchId);
    await this.checkPresentLines(customer.id, input);
    return { branchId: quotation.branchId, customerId: customer.id, quotationId: quotation.id };
  }

  /** The parties and cargo lines of a draft: a complete line in full, others on what they hold. */
  private async checkPresentLines(
    customerId: string | null,
    input: {
      shipperId?: string | null;
      consigneeId?: string | null;
      notifyPartyId?: string | null;
      items?: BookingDraftItem[];
    },
  ): Promise<void> {
    if (customerId === null) {
      // A party is one of the customer's: it is named once the customer is.
      const named = (['shipperId', 'consigneeId', 'notifyPartyId'] as const).filter(
        (field) => input[field],
      );
      if (named.length > 0) {
        throw fieldRefusal(null, "Name the customer before the customer's parties", named);
      }
    } else {
      await this.customers.requireOwnParties(customerId, [
        input.shipperId,
        input.consigneeId,
        input.notifyPartyId,
      ]);
    }
    for (const [index, item] of (input.items ?? []).entries()) {
      const path = `items.${index}`;
      const { cargoType, quantity } = item;
      if (cargoType && quantity && bookingItemMissingFields(item).length === 0) {
        await this.prepareItem({ ...item, cargoType, quantity }, path);
        continue;
      }
      const code = item.containerTypeCode;
      if (!code) continue;
      const containerType = [`${path}.containerTypeCode`];
      if (cargoType && cargoType !== 'CONTAINER') {
        throw fieldRefusal(
          'CONTAINER_TYPE_NOT_APPLICABLE',
          'Container type applies to container lines only',
          containerType,
        );
      }
      await onFields(
        containerType,
        () => this.masterData.requireContainerType(code),
        'UNKNOWN_CONTAINER_TYPE',
      );
    }
  }

  /** Records a prepared booking (DRAFT) in the caller's transaction; its id. */
  async insertInTx(tx: Tx, user: AuthUser, prepared: PreparedBooking): Promise<string> {
    const number = formatShortNumber('BK', await nextSequenceValue(tx, 'BOOKING'));
    // Sold through the outlet of its quotation, or (Outlet Staff, plan 4.2) through theirs.
    const fromQuotation = prepared.quotationId
      ? await tx.quotation.findUniqueOrThrow({
          where: { id: prepared.quotationId },
          select: { salesOutletId: true },
        })
      : null;
    try {
      const created = await tx.booking.create({
        data: {
          ...prepared.header,
          number,
          branchId: prepared.branchId,
          customerId: prepared.customerId,
          quotationId: prepared.quotationId,
          salesOutletId: fromQuotation ? fromQuotation.salesOutletId : outletForWrite(user),
          createdById: user.id,
          items: { create: prepared.items },
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (prepared.quotationId && isUniqueViolation(error)) {
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
    if (existing.quotationId) {
      // The quotation priced this route and mode, and the invoice is priced from the quotation.
      const changed = [
        input.originLocationId.toLowerCase() !== existing.originLocationId && 'originLocationId',
        input.destinationLocationId.toLowerCase() !== existing.destinationLocationId &&
          'destinationLocationId',
        input.mode !== existing.mode && 'mode',
      ].filter((f): f is string => typeof f === 'string');
      if (changed.length > 0) {
        throw fieldRefusal(
          'QUOTED_ROUTE_FIXED',
          'A booking made from a quotation keeps the quotation route and mode',
          changed,
        );
      }
    }
    const prepared = await this.prepare(existing.customerId, input, existing);
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
   * Confirmation creates the booking's shipment in the same transaction. Status and cargo lines are
   * checked under the booking row lock: a concurrent draft edit (which takes the same lock when it
   * changes the status row) either finishes first and is seen, or waits and then finds the booking
   * confirmed.
   */
  async confirm(user: AuthUser, id: string): Promise<BookingDto> {
    await this.findScoped(user, id);
    await this.prisma.$transaction((tx) => this.confirmInTx(tx, user, id));
    return this.get(user, id);
  }

  /**
   * Confirms a draft booking of the user's branches (the caller checked that) inside the caller's
   * transaction; the id of the shipment it creates.
   */
  async confirmInTx(tx: Tx, user: AuthUser, id: string): Promise<{ id: string }> {
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
    return this.shipments.createForBooking(tx, user, id);
  }

  /**
   * Annex B: cancellation is allowed before COMPLETED, provided the booking has no non-cancelled
   * invoices. Invoices arrive with billing (group 4), which adds that check here. A confirmed
   * booking has a shipment: it is cancelled through the shipment's rules (not once delivery has
   * started, and only by a Branch Manager after loading), which cancels the booking in the same
   * transaction.
   */
  async cancel(user: AuthUser, id: string, reason: string): Promise<BookingDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status === 'DRAFT') {
      await casStatus(this.prisma, id, ['DRAFT'], { status: 'CANCELLED', cancelReason: reason });
    } else if (existing.status === 'CONFIRMED') {
      await this.prisma.$transaction(async (tx) => {
        if (!(await this.shipments.cancelForBooking(tx, user, id, reason))) {
          await casStatus(tx, id, ['CONFIRMED'], { status: 'CANCELLED', cancelReason: reason });
        }
      });
    } else {
      throw new ConflictException('Only a draft or confirmed booking can be cancelled');
    }
    return this.get(user, id);
  }

  private async insert(user: AuthUser, prepared: PreparedBooking): Promise<BookingDto> {
    const id = await this.prisma.$transaction((tx) => this.insertInTx(tx, user, prepared));
    return this.get(user, id);
  }

  private async findScoped(user: AuthUser, id: string): Promise<BookingWithDetails> {
    const booking = await this.prisma.booking.findFirst({
      where: { id, ...branchScope(user), ...salesOutletScope(user) },
      include: details,
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  /**
   * `customerId` null: a booking for a customer not in NOLON yet, which names no parties.
   * `stored`: the booking an edit changes, whose cargo header a value left out keeps
   * (bookingCargoHeader).
   */
  private async prepare(
    customerId: string | null,
    input: BookingInput,
    stored?: BookingCargo | null,
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
    // Every booking carries the main freight (owner, 2026-10-19): it is not a choice on the form.
    const services: BookingService[] = [
      ...new Set<BookingService>(['MAIN_FREIGHT', ...input.services]),
    ];
    const parties = [input.shipperId, input.consigneeId, input.notifyPartyId];
    if (customerId !== null) {
      await this.customers.requireOwnParties(customerId, parties);
    } else if (parties.some((p) => p !== null && p !== undefined)) {
      throw new BadRequestException('A booking for a new customer names no parties yet');
    }
    // Asked on each line only; a booking with no lines names its cargo type.
    const cargo = bookingCargoHeader(input, stored);
    const cargoType = cargo.cargoType;
    if (cargoType === null) {
      throw fieldRefusal(null, 'Give the cargo type or a cargo line', ['cargoType']);
    }
    const items = [];
    for (const [index, item] of input.items.entries()) {
      items.push({ lineNo: index + 1, ...(await this.prepareItem(item, `items.${index}`)) });
    }
    return {
      header: {
        originLocationId: input.originLocationId,
        destinationLocationId: input.destinationLocationId,
        mode: input.mode,
        loadType: cargo.loadType,
        cargoType,
        cargoDescription: cargo.cargoDescription,
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

  /** One cargo line; a refusal names its fields under `path` (`items.<index>`). */
  private async prepareItem(item: BookingItemInput, path: string) {
    const containerType = [`${path}.containerTypeCode`];
    if (item.cargoType === 'CONTAINER') {
      if (!item.containerTypeCode) {
        throw fieldRefusal(
          'CONTAINER_TYPE_REQUIRED',
          'A container line needs a container type',
          containerType,
        );
      }
      const code = item.containerTypeCode;
      await onFields(
        containerType,
        () => this.masterData.requireContainerType(code),
        'UNKNOWN_CONTAINER_TYPE',
      );
    } else if (item.containerTypeCode) {
      throw fieldRefusal(
        'CONTAINER_TYPE_NOT_APPLICABLE',
        'Container type applies to container lines only',
        containerType,
      );
    }
    const length = item.lengthCm ? dec(item.lengthCm) : null;
    const width = item.widthCm ? dec(item.widthCm) : null;
    const height = item.heightCm ? dec(item.heightCm) : null;
    const dimensions = [length, width, height].filter((d) => d !== null).length;
    if (dimensions !== 0 && dimensions !== 3) {
      // The missing ones are named: those are the fields to fill in.
      const missing = (['lengthCm', 'widthCm', 'heightCm'] as const).filter((k) => !item[k]);
      throw fieldRefusal(
        'DIMENSIONS_TOGETHER',
        'Give length, width and height together',
        missing.map((k) => `${path}.${k}`),
      );
    }
    const volumeCbm =
      length && width && height
        ? cbmFromDimensions(length, width, height, item.quantity)
        : item.volumeCbm
          ? dec(item.volumeCbm)
          : null;
    if (volumeCbm?.gt(MAX_VOLUME_CBM)) {
      const fields = length
        ? ['lengthCm', 'widthCm', 'heightCm', 'quantity']
        : ['volumeCbm', 'quantity'];
      throw fieldRefusal(
        'VOLUME_TOO_LARGE',
        'Volume is too large; check the dimensions and quantity',
        fields.map((k) => `${path}.${k}`),
      );
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

export interface PreparedBooking {
  branchId: string;
  customerId: string;
  quotationId: string | null;
  header: Awaited<ReturnType<BookingsService['prepare']>>['header'];
  items: Awaited<ReturnType<BookingsService['prepare']>>['items'];
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
    shipmentId: b.shipment?.id ?? null,
    shipmentNumber: b.shipment?.number ?? null,
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

/**
 * A booking made from a quotation is filed in the quotation's branch, which is its customer's: a
 * quotation is priced in its customer's branch and a customer never changes branch. Checked anyway,
 * so a booking can never land in a branch other than its customer's (409).
 */
function requireSameBranch(quotationBranchId: string, customerBranchId: string): void {
  if (quotationBranchId !== customerBranchId) {
    throw new ConflictException("This quotation is not in its customer's branch");
  }
}
