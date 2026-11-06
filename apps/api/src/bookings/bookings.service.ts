import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  CsDropOffChoiceDto,
  NewCustomerBookingRequest,
  Page,
} from '@nolon/shared';
import { hasSeaLeg } from '@nolon/shared';
import QRCode from 'qrcode';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope, listBranchScope, workBranch } from '../auth/branch-scope.js';
import { assertOutletInTx, lockRecordOutletInTx, salesOutletScope } from '../auth/outlet-scope.js';
import { fromDbDateOrNull, toDbDate } from '../common/dates.js';
import {
  localDayFilter,
  matchedLocations,
  type RouteFilters,
  routeWhere,
} from '../common/list-filters.js';
import { toDecimalStringOrNull } from '../common/money.js';
import { formatShortNumber, nextSequenceValue } from '../common/numbering.js';
import { oldNumberTerm } from '../common/old-numbers.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { onFields } from '../common/rule-issues.js';
import { fieldRefusal, type PageQuery } from '../common/validation.js';
import { draftBranch } from '../drafts/draft-rules.js';
import {
  AGREED_TERMS_VERSION,
  agreedTermsHash,
  agreedTermsReconciled,
} from '../billing/agreed-terms.js';
import { CustomersService } from '../customers/customers.service.js';
import {
  type DropOffRow,
  dropOffChoice,
  dropOffChoiceSelect,
  dropOffDto,
  dropOffSelect,
} from '../customer-service/drop-off.js';
import type { Booking, BookingItem, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import {
  PartnerRefsService,
  partnerRefSelect,
  toPartnerRef,
} from '../partners/partner-refs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type AgreedRequestLine, QuotationsService } from '../quotations/quotations.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { BookingConfirmChecksRegistry } from './booking-confirm-checks.registry.js';
import { bookingCargoHeader, type BookingCargo } from './booking-cargo.js';
import { bookingItemMissingFields } from './booking-draft-missing.js';
import { refuseRequestBookingInTx, requireDropOffPointInTx } from './booking-drop-off.js';
import { prepareCargoLine } from './cargo-line.js';

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
  salesOutlet: { id: string; number: string; name: string; isActive: boolean } | null;
  dropOff: (DropOffRow & { code: string }) | null;
};

type Tx = Prisma.TransactionClient;

/** Largest quantity a cargo line takes (the request schema's limit). */
const MAX_ITEM_QUANTITY = 100_000;

const details = {
  items: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  shipment: { select: { id: true, number: true } },
  salesOutlet: partnerRefSelect,
  dropOff: { select: { ...dropOffSelect, code: true } },
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
    private readonly partnerRefs: PartnerRefsService,
    private readonly confirmChecks: BookingConfirmChecksRegistry,
  ) {}

  async list(user: AuthUser, filters: BookingFilters): Promise<Page<BookingSummaryDto>> {
    const route = await this.masterData.matchRoute(filters);
    const created = await localDayFilter(this.prisma, 'createdAt', filters.from, filters.to);
    const oldNumbers = filters.q ? await oldNumberTerm(this.prisma, 'BOOKING', filters.q) : [];
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
              ...oldNumbers,
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
  /**
   * Plan 13 section 1: the windows a booking of the branch may name, for a person who creates or
   * edits bookings there (403 otherwise), each labelled with the outlet that runs it.
   */
  async dropOffPoints(user: AuthUser, branchId: string): Promise<CsDropOffChoiceDto[]> {
    if (
      !user.access.has('bookings:create', branchId) &&
      !user.access.has('bookings:update', branchId)
    )
      throw new ForbiddenException('You may not write bookings in this branch');
    const rows = await this.prisma.warehouse.findMany({
      where: { branchId, isActive: true, acceptsDropOff: true },
      orderBy: { code: 'asc' },
      select: dropOffChoiceSelect,
    });
    return rows.map(dropOffChoice);
  }

  /** Plan 13 section 1: a QR code (SVG) of the window's map link; 404 when it has none. */
  async dropOffQrSvg(user: AuthUser, id: string): Promise<string> {
    const url = bookingDropOff((await this.findScoped(user, id)).dropOff)?.mapUrl;
    if (!url) throw new NotFoundException('This booking has no drop-off map link');
    return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  }

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
  async prepareCreate(
    user: AuthUser,
    input: CreateBookingRequest,
    /** A bot request's approval: its branch, which the approval's own checks cover. */
    inBranch?: string,
  ): Promise<PreparedBooking> {
    const customer = await this.customers.requireActiveCustomer(user, input.customerId);
    const prepared = await this.prepare(customer.id, input);
    return {
      // Plan 09d: the branch the work is done in, never the customer's by rule.
      branchId: inBranch ?? workBranch(user, 'bookings:create', input.branchId),
      customerId: customer.id,
      quotationId: null,
      ...prepared,
      // Only when sent (NOLON screens, plan 7.2).
      ...(input.salesOutletId !== undefined ? { salesOutletId: input.salesOutletId } : {}),
      ...(input.dropOffWarehouseId ? { dropOffWarehouseId: input.dropOffWarehouseId } : {}),
    };
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
    // Plan 09d: the branch the draft names, or the work branch for the customer; with no
    // customer yet, the branch the draft names (one of the user's).
    const branchId = customer
      ? workBranch(user, 'bookings:create', givenBranchId)
      : draftBranch(user, givenBranchId, null);
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

  /**
   * A new booking's number, inside the caller's transaction: the next BK number, whatever its
   * cargo or load type (owner, 2026-11-04: one BK series, kept by its shipment).
   */
  private async allocateNumber(tx: Tx): Promise<string> {
    return formatShortNumber('BK', await nextSequenceValue(tx, 'BOOKING'));
  }

  /**
   * Records a prepared booking (DRAFT) in the caller's transaction; its id. `reserved`: the BK
   * number a bot request took when it arrived, which its booking keeps (owner, 2026-11-04).
   */
  async insertInTx(
    tx: Tx,
    user: AuthUser,
    prepared: PreparedBooking,
    reserved?: string,
  ): Promise<string> {
    // Sold through the outlet of its quotation, or (Outlet Staff, plan 4.2) through theirs, or
    // the one of the branch's outlets the person names. For Outlet Staff the outlet is checked as
    // it is now, first in the transaction.
    // The quotation's outlet as it is now, share-locked with the quotation.
    const fromQuotation = prepared.quotationId
      ? await lockApprovedQuotation(tx, prepared.quotationId)
      : null;
    if (fromQuotation) {
      await assertOutletInTx(tx, user, fromQuotation.salesOutletId, 'Quotation not found');
      await this.customers.lockActiveCustomerInTx(tx, prepared.customerId);
      requireQuotedOutlet(prepared.salesOutletId, fromQuotation.salesOutletId);
    }
    const salesOutletId = fromQuotation
      ? fromQuotation.salesOutletId
      : await this.partnerRefs.chooseInTx(tx, user, {
          kind: 'SALES_OUTLET',
          requested: prepared.salesOutletId,
          held: await this.customers.outletForSaleInTx(
            tx,
            user,
            prepared.branchId,
            prepared.customerId,
          ),
          branchIds: [prepared.branchId],
          field: 'salesOutletId',
        });
    // Plan 13 section 1: the window named on a staff booking (a bot request's comes on approval).
    const dropOffWarehouseId = prepared.dropOffWarehouseId
      ? await requireDropOffPointInTx(tx, prepared.dropOffWarehouseId, prepared.branchId)
      : null;
    const number = reserved ?? (await this.allocateNumber(tx));
    try {
      const created = await tx.booking.create({
        data: {
          ...prepared.header,
          number,
          branchId: prepared.branchId,
          customerId: prepared.customerId,
          quotationId: prepared.quotationId,
          salesOutletId,
          dropOffWarehouseId,
          createdById: user.id,
          items: { create: prepared.items },
        },
        select: { id: true },
      });
      // Plan 12 section 1: what the quotation priced, pinned as the booking is made from it.
      if (prepared.quotationId) await this.pinAgreedTermsInTx(tx, created.id);
      return created.id;
    } catch (error) {
      if (prepared.quotationId && isUniqueViolation(error)) {
        throw new ConflictException('This quotation already has a booking');
      }
      throw error;
    }
  }

  /**
   * Plan 12 section 1: the booking's agreed terms as they are now, inside the caller's
   * transaction: the hash of its quotation's lines and its own lines (agreedTermsHash), the hash
   * pinned when the price was agreed, and whether the quotation is still APPROVED. Null for a
   * booking with no quotation.
   */
  async agreedTermsInTx(
    tx: Tx,
    bookingId: string,
  ): Promise<{
    quotationId: string;
    approved: boolean;
    current: string;
    /** Codex F193-1: the quotation's quantities are those of the booking's goods. */
    reconciled: boolean;
    pinned: string | null;
  } | null> {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: {
        items: true,
        quotation: {
          include: { lines: { include: { rateCard: { select: { containerTypeCode: true } } } } },
        },
      },
    });
    const quotation = booking.quotation;
    if (!quotation) return null;
    const input = {
      booking: {
        originLocationId: booking.originLocationId,
        destinationLocationId: booking.destinationLocationId,
        mode: booking.mode,
        loadType: booking.loadType,
        cargoType: booking.cargoType,
        services: booking.services,
        items: booking.items,
      },
      quotation: {
        id: quotation.id,
        updatedAt: quotation.updatedAt,
        currency: quotation.currency,
        lines: quotation.lines.map((l) => ({
          ...l,
          containerTypeCode: l.rateCard?.containerTypeCode ?? null,
        })),
      },
    };
    return {
      quotationId: quotation.id,
      approved: quotation.status === 'APPROVED',
      current: agreedTermsHash(input),
      reconciled: agreedTermsReconciled(input),
      // An older version's hash is never compared with this version's.
      pinned: booking.agreedTermsVersion === AGREED_TERMS_VERSION ? booking.agreedTermsHash : null,
    };
  }

  /**
   * Plan 12 section 1: pins the booking's agreed terms as they are now, in the transaction that
   * agrees the price (a booking made from a quotation; a bot request's approval).
   */
  async pinAgreedTermsInTx(tx: Tx, bookingId: string): Promise<void> {
    const terms = await this.agreedTermsInTx(tx, bookingId);
    if (!terms) throw new Error('Agreed terms are pinned on a booking with a quotation');
    await tx.booking.update({
      where: { id: bookingId },
      data: { agreedTermsHash: terms.current, agreedTermsVersion: AGREED_TERMS_VERSION },
    });
  }

  /**
   * Plan 12 section 1: the prices staff approved for a bot request, made an APPROVED quotation
   * (source BOT_REQUEST) of the booking just made from it, in the approval's transaction, and the
   * booking's agreed terms pinned. The booking has no quotation yet.
   */
  async agreeFromRequestInTx(
    tx: Tx,
    user: AuthUser,
    bookingId: string,
    agreed: { requestId: string; currency: string; lines: readonly AgreedRequestLine[] },
  ): Promise<void> {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (booking.quotationId !== null) throw new Error('The booking already has a quotation');
    const quotationId = await this.quotations.insertFromRequestInTx(tx, user, {
      ...agreed,
      branchId: booking.branchId,
      customerId: booking.customerId,
      salesOutletId: booking.salesOutletId,
      header: {
        originLocationId: booking.originLocationId,
        destinationLocationId: booking.destinationLocationId,
        mode: booking.mode,
        loadType: booking.loadType,
        cargoType: booking.cargoType,
        cargoDescription: booking.cargoDescription,
      },
    });
    await tx.booking.update({ where: { id: bookingId }, data: { quotationId } });
    await this.pinAgreedTermsInTx(tx, bookingId);
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
      // The outlet as it is now: another user may have moved the booking since it was read.
      const held = await lockRecordOutletInTx(
        tx,
        user,
        'bookings',
        id,
        'Booking not found',
        'UPDATE',
      );
      if (existing.quotationId) requireQuotedOutlet(input.salesOutletId, held);
      const salesOutletId = await this.partnerRefs.chooseInTx(tx, user, {
        kind: 'SALES_OUTLET',
        requested: input.salesOutletId,
        held,
        branchIds: [existing.branchId],
        field: 'salesOutletId',
      });
      await this.lockDraftInTx(tx, id);
      // Plan 13 section 1: omitted, the window stays; a bot request's booking changes it there.
      const dropOff =
        input.dropOffWarehouseId === undefined ||
        (input.dropOffWarehouseId?.toLowerCase() ?? null) === existing.dropOffWarehouseId
          ? {}
          : {
              dropOffWarehouseId: await this.dropOffForEditInTx(
                tx,
                id,
                existing.branchId,
                input.dropOffWarehouseId,
              ),
            };
      await casStatus(tx, id, ['DRAFT'], { ...prepared.header, salesOutletId, ...dropOff });
      await tx.bookingItem.deleteMany({ where: { bookingId: id } });
      await tx.bookingItem.createMany({
        data: prepared.items.map((item) => ({ ...item, bookingId: id })),
      });
    });
    return this.get(user, id);
  }

  private async dropOffForEditInTx(
    tx: Tx,
    id: string,
    branchId: string,
    requested: string | null,
  ): Promise<string | null> {
    await refuseRequestBookingInTx(tx, id);
    return requested === null ? null : requireDropOffPointInTx(tx, requested, branchId);
  }

  /**
   * Plan 13 section 1: a bot request's window, copied to its booking on approval and on the
   * request's correction, in the caller's transaction (which checked the point and holds the
   * request's lock; the booking row lock follows it, as the item link takes it).
   */
  async setDropOffInTx(
    tx: Tx,
    bookingId: string,
    dropOffWarehouseId: string | null,
  ): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "bookings" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
    await tx.booking.update({ where: { id: bookingId }, data: { dropOffWarehouseId } });
  }

  /**
   * Locks a draft being edited (the booking row lock that confirm also takes) and checks it is
   * still a draft. Its number never changes: a BK number fits any route (owner, 2026-11-04).
   */
  private async lockDraftInTx(tx: Tx, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS "status" FROM "bookings" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows[0]?.status !== 'DRAFT') {
      throw new ConflictException('Booking changed meanwhile; reload and retry');
    }
  }

  /**
   * Confirmation creates the booking's shipment in the same transaction. Status and cargo lines are
   * checked under the booking row lock: a concurrent draft edit (which takes the same lock when it
   * changes the status row) either finishes first and is seen, or waits and then finds the booking
   * confirmed.
   */
  async confirm(user: AuthUser, id: string): Promise<BookingDto> {
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await this.confirmInTx(tx, user, id);
      await this.finalChecksInTx(tx, user, id);
    });
    return this.get(user, id);
  }

  /**
   * The step that ends a transaction confirming a booking: billing's invoice made on confirmation,
   * then the customer's credit limit under its advisory lock (plan 06 ب6, plan 12 section 2.3).
   * Every caller of confirmInTx calls this as its LAST step, after all its own writes, and writes
   * nothing after it. `user` is the person confirming.
   */
  async finalChecksInTx(tx: Tx, user: AuthUser, bookingId: string): Promise<void> {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { id: true, customerId: true },
    });
    await this.confirmChecks.runFinal(tx, { ...booking, user });
  }

  /**
   * Confirms a draft booking of the user's branches (the caller checked that) inside the caller's
   * transaction; the id of the shipment it creates. The caller ends its transaction with
   * finalChecksInTx (plan 06 ب6).
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
    // Other modules' gates (plan 09 section 4: a bot request's items all have their lines).
    await this.confirmChecks.run(tx, id);
    await tx.booking.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
    return this.shipments.createForBooking(tx, user, id);
  }

  /**
   * Annex B: cancellation is allowed before COMPLETED, provided no invoice still bills the
   * booking. Invoices bill its shipment: a confirmed booking is cancelled through the shipment's
   * rules (not once delivery has started, only by a Branch Manager after loading, and not while an
   * invoice still bills it), which cancel the booking in the same transaction. A draft booking has
   * no shipment, so no invoice.
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
  private prepareItem(item: BookingItemInput, path: string) {
    return prepareCargoLine(this.masterData, item, path);
  }
}

export interface PreparedBooking {
  branchId: string;
  customerId: string;
  quotationId: string | null;
  /** As sent from a NOLON screen: the sales outlet to record (insertInTx checks it). */
  salesOutletId?: string | null;
  /** Plan 13 section 1: the window named on a staff booking (insertInTx checks it). */
  dropOffWarehouseId?: string | null;
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

/** A booking's cargo line as the API returns it. */
export function bookingItemDto(i: BookingItem): BookingDto['items'][number] {
  return {
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
    priceCategoryCode: i.priceCategoryCode,
  };
}

/** Plan 13 section 1: the booking's window as it is now; none once it stops taking shipments. */
function bookingDropOff(w: BookingWithDetails['dropOff']): BookingDto['dropOff'] {
  const point = w && dropOffDto(w);
  return w && point ? { ...point, code: w.code } : null;
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
    salesOutlet: toPartnerRef(b.salesOutlet),
    dropOffWarehouseId: b.dropOffWarehouseId,
    dropOff: bookingDropOff(b.dropOff),
    items: b.items.map(bookingItemDto),
  };
}

/** A booking made from a quotation is sold through the quotation's outlet (400 for another). */
function requireQuotedOutlet(requested: string | null | undefined, quoted: string | null): void {
  if (requested !== undefined && requested !== quoted) {
    throw fieldRefusal(
      'QUOTED_OUTLET_FIXED',
      "A booking made from a quotation keeps the quotation's sales outlet",
      ['salesOutletId'],
    );
  }
}

/**
 * The quotation a booking is made from, share-locked and checked again in the booking's
 * transaction (B1-6): it was approved when the booking was prepared, but an expiry, a rejection
 * or a change may have committed since. Status changes update the row, so they wait for this
 * lock and then find the booking.
 */
async function lockApprovedQuotation(
  tx: Tx,
  id: string,
): Promise<{ salesOutletId: string | null }> {
  const rows = await tx.$queryRaw<{ status: string; salesOutletId: string | null }[]>`
    SELECT "status"::text AS "status", "sales_outlet_id" AS "salesOutletId"
    FROM "quotations" WHERE "id" = ${id}::uuid FOR SHARE`;
  const row = rows[0];
  if (!row) throw new NotFoundException('Quotation not found');
  if (row.status !== 'APPROVED') {
    throw new ConflictException('Only an approved quotation can become a booking');
  }
  return { salesOutletId: row.salesOutletId };
}
