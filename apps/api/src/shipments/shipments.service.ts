import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BookingService,
  FormRefusal,
  CargoType,
  LoadType,
  Page,
  Permission,
  ShipmentActionsDto,
  ShipmentContainerInput,
  ShipmentCloseCheckDto,
  ShipmentDto,
  ShipmentEventKind,
  ShipmentStatus,
  ShipmentStatusRequest,
  ShipmentPickPage,
  ShipmentSummaryDto,
  ShipmentUpdateRequest,
  ShippingMode,
} from '@nolon/shared';
import QRCode from 'qrcode';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope, canAccessBranch } from '../auth/branch-scope.js';
import { lockActiveBranches } from '../common/branch-locks.js';
import { ShipmentInvoicesRegistry } from './shipment-invoices.registry.js';
import { ShipmentLinksRegistry, type ShipmentLinkBlocker } from './shipment-links.registry.js';
import { ShipmentStockRegistry } from './shipment-stock.registry.js';
import { shipmentScope, holdsOnShipment } from './shipment-scope.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';
import { BookingLifecycleService } from '../bookings/booking-lifecycle.service.js';
import { fromDbDateOrNull, toDbDate } from '../common/dates.js';
import {
  dateRange,
  localDayFilter,
  matchedLocations,
  type RouteFilters,
  routeWhere,
} from '../common/list-filters.js';
import { toDecimalStringOrNull } from '../common/money.js';
import { oldNumberTerm } from '../common/old-numbers.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { codedRefusal, fieldRefusal, type PageQuery } from '../common/validation.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { CustomersService } from '../customers/customers.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  FINISHED,
  type HistoryEntry,
  canCancelStatus,
  canHold,
  hasPassedLoading,
  isActive,
  nextStatuses,
  permissionForTransition,
  replayHistory,
  revertTarget,
  revertUndoes,
  earliestEntryTime,
  usualPlace,
  visitedStatuses,
} from './state-machine.js';

export interface ShipmentFilters extends PageQuery, RouteFilters {
  /** Any of these statuses. */
  status?: readonly ShipmentStatus[];
  customerId?: string;
  /** Only shipments that are neither closed nor cancelled. */
  activeOnly?: boolean;
  mode?: ShippingMode;
  /** Visible in this branch (its own or sharing it); 403 unless it is one of the user's. */
  branchId?: string;
  /** Created from / to (local day of the owning branch, both included). */
  from?: string;
  to?: string;
  /** ETA from / to (both included). */
  etaFrom?: string;
  etaTo?: string;
}

type Tx = Prisma.TransactionClient;

const sharedBranchesSelect = {
  select: { branchId: true },
  orderBy: { branchId: 'asc' },
} satisfies Prisma.Shipment$sharedBranchesArgs;

/**
 * The closed container a shipment is in (stuffed and sealed, not cancelled): closing is final, so
 * its consolidation is not undone from the shipment page (docs/reviews/shipment-status-history).
 */
const closedContainerLinks = {
  where: { consolidation: { status: { notIn: ['OPEN', 'CANCELLED'] } } },
  select: { consolidation: { select: { number: true } } },
  take: 1,
} satisfies Prisma.Shipment$consolidationLinksArgs;

/**
 * The containers a shipment is or was in, for its page (not cancelled). The closed one (any status
 * but OPEN, unpacked included) blocks undoing its consolidation exactly as the locked check
 * (closedContainerLinks) does; the one not yet unpacked is the one it travels in (after unpacking
 * the shipment goes on by itself).
 */
const containerLinks = {
  where: { consolidation: { status: { not: 'CANCELLED' } } },
  select: { consolidation: { select: { number: true, status: true } } },
} satisfies Prisma.Shipment$consolidationLinksArgs;

/**
 * The statuses a container's moves give its shipments (consolidation-rules shipmentStatusFor):
 * recorded by hand on the page of a shipment in a container, they come with a warning (owner
 * choice Q3, docs/reviews/shipment-status-history-2026-10-27.md).
 */
const CONTAINER_MOVED: readonly ShipmentStatus[] = [
  'CONSOLIDATED',
  'LOADED',
  'DEPARTED',
  'ARRIVED_PORT',
];

const branchRef = { select: { id: true, code: true, nameEn: true, nameAr: true } };

const details = {
  customer: { select: { name: true } },
  booking: { select: { number: true } },
  sharedBranches: { ...sharedBranchesSelect, select: { branchId: true, branch: branchRef } },
  items: { orderBy: { lineNo: 'asc' } },
  containers: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: { id: 'asc' }, include: { user: { select: { fullName: true } } } },
  consolidationLinks: containerLinks,
} satisfies Prisma.ShipmentInclude;

type ShipmentWithDetails = Prisma.ShipmentGetPayload<{ include: typeof details }>;

const summary = {
  customer: { select: { name: true } },
  booking: { select: { number: true } },
  sharedBranches: sharedBranchesSelect,
} satisfies Prisma.ShipmentInclude;

type ShipmentWithSummary = Prisma.ShipmentGetPayload<{ include: typeof summary }>;

/** A status change may be recorded after the fact, but not ahead of the clock (small skew ok). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Roles that may cancel a shipment after loading (annex B: Branch Manager). */
const LATE_CANCEL_ROLES = ['ADMINISTRATOR', 'BRANCH_MANAGER'] as const;

/**
 * Shipments (scope 8, annex B section 4). One per confirmed booking, created by the booking's
 * confirmation. Every status change goes through `applyEvent`, which locks the shipment row,
 * checks the state machine and the user's permissions, updates the shipment and records the
 * event, all in one transaction.
 */
@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly masterData: MasterDataService,
    private readonly bookingLifecycle: BookingLifecycleService,
    private readonly invoices: ShipmentInvoicesRegistry,
    private readonly stock: ShipmentStockRegistry,
    private readonly links: ShipmentLinksRegistry,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async list(user: AuthUser, filters: ShipmentFilters): Promise<Page<ShipmentSummaryDto>> {
    const route = await this.masterData.matchRoute(filters);
    const { branchId, from, to } = filters;
    if (branchId) assertBranchAccess(user, branchId);
    const created = await localDayFilter(this.prisma, 'createdAt', from, to);
    const oldNumbers = filters.q ? await oldNumberTerm(this.prisma, 'SHIPMENT', filters.q) : [];
    const where: Prisma.ShipmentWhereInput = {
      AND: [
        this.scope(user),
        ...(branchId ? [{ OR: [{ branchId }, { sharedBranches: { some: { branchId } } }] }] : []),
        ...(created ? [created] : []),
      ],
      ...(filters.status || filters.activeOnly
        ? {
            status: {
              ...(filters.status ? { in: [...filters.status] } : {}),
              ...(filters.activeOnly ? { notIn: [...FINISHED] } : {}),
            },
          }
        : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.mode ? { mode: filters.mode } : {}),
      ...routeWhere(route),
      eta: dateRange(filters.etaFrom, filters.etaTo),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              ...oldNumbers,
              { blNumber: { contains: filters.q, mode: 'insensitive' } },
              { customer: { name: { contains: filters.q, mode: 'insensitive' } } },
              { containers: { some: { containerNumber: { contains: filters.q.toUpperCase() } } } },
              // An LCL shipment's container is its consolidation's (functional review D4); a
              // cancelled consolidation no longer holds it. Inside the scope above, as every term.
              {
                consolidationLinks: {
                  some: {
                    consolidation: {
                      status: { not: 'CANCELLED' },
                      containerNumber: { contains: filters.q.toUpperCase() },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include: summary,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return {
      items: items.map(toSummary),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      ...matchedLocations(route),
    };
  }

  /**
   * Shipments to pick for a document of `branchId` (functional review C10): visible to the user
   * and in that branch (its own or sharing it), not cancelled, whose number or customer name
   * contains `q`. The shipment numbered exactly `q` (any case) comes apart as `exact`, so a typed
   * number is found however many shipments contain it; the others page by number.
   */
  async pick(
    user: AuthUser,
    branchId: string,
    filters: { q?: string; page: number; pageSize: number },
  ): Promise<ShipmentPickPage> {
    assertBranchAccess(user, branchId);
    const q = filters.q ?? '';
    const base: Prisma.ShipmentWhereInput[] = [
      this.scope(user),
      { OR: [{ branchId }, { sharedBranches: { some: { branchId } } }] },
      { status: { not: 'CANCELLED' } },
    ];
    const exact = q
      ? await this.prisma.shipment.findFirst({
          where: { AND: [...base, { number: { equals: q, mode: 'insensitive' } }] },
          include: summary,
        })
      : null;
    const where: Prisma.ShipmentWhereInput = {
      AND: [
        ...base,
        ...(exact ? [{ id: { not: exact.id } }] : []),
        ...(q
          ? [
              {
                OR: [
                  { number: { contains: q, mode: 'insensitive' as const } },
                  { customer: { name: { contains: q, mode: 'insensitive' as const } } },
                ],
              },
            ]
          : []),
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include: summary,
        orderBy: { number: 'asc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return {
      exact: exact ? toSummary(exact) : null,
      items: items.map(toSummary),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async get(user: AuthUser, id: string): Promise<ShipmentDto> {
    const shipment = await this.findScoped(user, id);
    const dto = this.toDto(user, shipment);
    if (dto.actions.transitions.includes('CLOSED')) {
      dto.actions.closeCheck = await this.closeCheck(this.prisma, shipment.id);
    }
    if (dto.actions.canShareBranches) {
      dto.shareableBranches = await this.prisma.branch.findMany({
        where: { isActive: true, id: { not: shipment.branchId } },
        ...branchRef,
        orderBy: { code: 'asc' },
      });
    }
    return dto;
  }

  /** The shipment a tracking link points to, if the signed-in user may open it. */
  async findIdByToken(user: AuthUser, token: string): Promise<{ id: string }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { trackingToken: token, ...this.scope(user) },
      select: { id: true },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    return shipment;
  }

  /**
   * For billing: what an invoice for this shipment starts from. 404 unless the user may see the
   * shipment in its own branch (not only as a branch sharing it).
   */
  async billingSource(
    user: AuthUser,
    id: string,
  ): Promise<{
    id: string;
    number: string;
    branchId: string;
    customerId: string;
    status: ShipmentStatus;
    quotationId: string | null;
    originLocationId: string;
    destinationLocationId: string;
    mode: ShippingMode;
    loadType: LoadType | null;
    cargoType: CargoType;
    services: BookingService[];
    items: {
      cargoType: CargoType;
      containerTypeCode: string | null;
      quantity: number;
      weightKg: Prisma.Decimal | null;
      volumeCbm: Prisma.Decimal | null;
    }[];
  }> {
    // Invoices belong to the owning branch: a sharing branch sees the shipment, not its billing.
    const shipment = await this.prisma.shipment.findFirst({
      where: { AND: [{ id }, this.scope(user), branchScope(user)] },
      select: {
        id: true,
        number: true,
        branchId: true,
        customerId: true,
        status: true,
        originLocationId: true,
        destinationLocationId: true,
        mode: true,
        loadType: true,
        cargoType: true,
        services: true,
        items: {
          select: {
            cargoType: true,
            containerTypeCode: true,
            quantity: true,
            weightKg: true,
            volumeCbm: true,
          },
          orderBy: { lineNo: 'asc' },
        },
        booking: { select: { quotationId: true } },
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    const { booking, ...rest } = shipment;
    return { ...rest, quotationId: booking.quotationId };
  }

  /** For other modules (documents): 404 unless the user may see the shipment. */
  async requireAccessible(
    user: AuthUser,
    id: string,
  ): Promise<{
    id: string;
    branchId: string;
    sharedBranchIds: string[];
    status: ShipmentStatus;
    salesOutletId: string | null;
  }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, ...this.scope(user) },
      select: {
        id: true,
        branchId: true,
        status: true,
        salesOutletId: true,
        sharedBranches: sharedBranchesSelect,
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    const { sharedBranches, ...rest } = shipment;
    return { ...rest, sharedBranchIds: sharedBranches.map((b) => b.branchId) };
  }

  /**
   * For a cost booked on the shipment inside another module's transaction (a supplier bill's
   * approval): the shipment's branches and status under a share lock, so it cannot be cancelled or
   * change branches until that transaction ends. The caller has checked access to the shipment.
   */
  async lockForCostInTx(
    tx: Tx,
    id: string,
  ): Promise<{ branchId: string; sharedBranchIds: string[]; status: ShipmentStatus }> {
    const rows = await tx.$queryRaw<{ branchId: string; status: ShipmentStatus }[]>`
      SELECT "branch_id"::text AS "branchId", "status"::text AS "status"
      FROM "shipments" WHERE "id" = ${id}::uuid FOR SHARE`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Shipment not found');
    // The shared branches change only under the shipment's row lock (update), so this share lock
    // holds them too.
    return { ...row, sharedBranchIds: await this.sharedBranchIdsInTx(tx, id) };
  }

  /**
   * For modules working under a shipment (warehouse): the shipment's branch and status, the
   * packages on its cargo lines, and the statuses this user may move it to now. 404 unless the
   * user may see the shipment.
   */
  async childContext(
    user: AuthUser,
    id: string,
  ): Promise<{
    id: string;
    branchId: string;
    sharedBranchIds: string[];
    status: ShipmentStatus;
    packages: number;
    transitions: ShipmentStatus[];
  }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, ...this.scope(user) },
      include: {
        items: { select: { quantity: true } },
        events: { orderBy: { id: 'asc' } },
        sharedBranches: sharedBranchesSelect,
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    const on = { branchId: shipment.branchId, sharedBranchIds: sharedIds(shipment) };
    const has = (permission: Permission) => holdsOnShipment(user, permission, on);
    return {
      id: shipment.id,
      branchId: shipment.branchId,
      sharedBranchIds: on.sharedBranchIds,
      status: shipment.status,
      packages: shipment.items.reduce((sum, item) => sum + item.quantity, 0),
      transitions: nextStatuses(
        shipment.status,
        shipment,
        visitedStatuses(replayHistory(shipment.events)),
      ).filter((next) => permissionForTransition(next).some(has)),
    };
  }

  /**
   * Creates the shipment of a booking being confirmed, inside the confirmation's transaction:
   * customer, parties, route, services, cargo lines and sales outlet are copied from the booking,
   * and so is its number (BK00001 or DXB-KRT-0001; one shipment per booking, so it is unique among
   * shipments).
   */
  async createForBooking(tx: Tx, user: AuthUser, bookingId: string): Promise<{ id: string }> {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { items: { orderBy: { lineNo: 'asc' } } },
    });
    const now = new Date();
    return tx.shipment.create({
      data: {
        number: booking.number,
        branchId: booking.branchId,
        customerId: booking.customerId,
        bookingId: booking.id,
        originLocationId: booking.originLocationId,
        destinationLocationId: booking.destinationLocationId,
        mode: booking.mode,
        loadType: booking.loadType,
        cargoType: booking.cargoType,
        cargoDescription: booking.cargoDescription,
        services: booking.services,
        shipperId: booking.shipperId,
        consigneeId: booking.consigneeId,
        notifyPartyId: booking.notifyPartyId,
        salesOutletId: booking.salesOutletId,
        trackingToken: newTrackingToken(),
        createdById: user.id,
        items: {
          create: booking.items.map((item) => ({
            lineNo: item.lineNo,
            cargoType: item.cargoType,
            containerTypeCode: item.containerTypeCode,
            description: item.description,
            quantity: item.quantity,
            lengthCm: item.lengthCm,
            widthCm: item.widthCm,
            heightCm: item.heightCm,
            weightKg: item.weightKg,
            volumeCbm: item.volumeCbm,
          })),
        },
        events: {
          create: {
            kind: 'CREATED',
            status: 'CREATED',
            occurredAt: now,
            branchId: booking.branchId,
            locationId: null,
            userId: user.id,
            source: 'USER',
            // No note: notes are shown as written, and the shipment links to its booking already.
            note: null,
          },
        },
      },
      select: { id: true },
    });
  }

  async update(user: AuthUser, id: string, input: ShipmentUpdateRequest): Promise<ShipmentDto> {
    const existing = await this.findScoped(user, id);
    if (!isActive(existing.status)) {
      throw new ConflictException('A closed or cancelled shipment cannot be edited');
    }
    await this.customers.requireOwnParties(existing.customerId, [
      input.shipperId,
      input.consigneeId,
      input.notifyPartyId,
    ]);
    const services: BookingService[] | undefined = input.services && [...new Set(input.services)];
    if (services?.length === 0) throw new BadRequestException('Choose at least one service');
    const sharedBranchIds = input.sharedBranchIds && [...new Set(input.sharedBranchIds)].sort();
    if (sharedBranchIds) {
      // Only the owning branch decides which other branches work on its shipment.
      if (!canAccessBranch(user, existing.branchId)) {
        throw new ForbiddenException(
          "Only the shipment's own branch can choose the branches sharing it",
        );
      }
      if (sharedBranchIds.includes(existing.branchId)) {
        throw new BadRequestException("The shipment's own branch is not a shared branch");
      }
    }
    const data: Prisma.ShipmentUncheckedUpdateInput = {
      cargoDescription: input.cargoDescription,
      services,
      shipperId: input.shipperId,
      consigneeId: input.consigneeId,
      notifyPartyId: input.notifyPartyId,
      carrierName: input.carrierName,
      vesselName: input.vesselName,
      voyageNumber: input.voyageNumber,
      blNumber: input.blNumber,
      etd: input.etd === undefined ? undefined : input.etd && toDbDate(input.etd),
      eta: input.eta === undefined ? undefined : input.eta && toDbDate(input.eta),
    };
    await this.prisma.$transaction(async (tx) => {
      // Under the row lock, so a concurrent status change, close or cancel is seen.
      const status = await this.lockStatus(tx, id);
      if (!isActive(status)) {
        throw new ConflictException('A closed or cancelled shipment cannot be edited');
      }
      // Compared with the row as it is under the lock, not as read before it: another edit may
      // have committed in between.
      const current = await tx.shipment.findUniqueOrThrow({
        where: { id },
        select: { services: true, etd: true, eta: true },
      });
      const etd = input.etd === undefined ? fromDbDateOrNull(current.etd) : input.etd;
      const eta = input.eta === undefined ? fromDbDateOrNull(current.eta) : input.eta;
      if (etd && eta && eta < etd) throw new BadRequestException('ETA cannot be before ETD');
      // The services decide which stages the shipment must pass. Once it has left CREATED they
      // are fixed, so no booked or in-progress stage can be removed to skip it.
      const changed =
        services !== undefined &&
        (services.length !== current.services.length ||
          services.some((service) => !current.services.includes(service)));
      if (changed && status !== 'CREATED') {
        throw new ConflictException('Services can change only before the shipment moves');
      }
      await tx.shipment.update({ where: { id }, data });
      if (sharedBranchIds) await this.replaceSharedBranchesInTx(tx, id, sharedBranchIds);
    });
    return this.get(user, id);
  }

  /** Moves the shipment forward (or to CLOSED) along the state machine. */
  async changeStatus(
    user: AuthUser,
    id: string,
    input: ShipmentStatusRequest,
  ): Promise<ShipmentDto> {
    await this.findScoped(user, id);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException('The time of a status change cannot be in the future');
    }
    if (input.locationId) await this.masterData.requireLocation(input.locationId);
    await this.applyEvent(
      user,
      id,
      this.statusPlan(user, { ...input, occurredAt, entered: input.occurredAt !== undefined }),
    );
    return this.get(user, id);
  }

  /**
   * The checks of a status change that need no lock, against the shipment as it is now (entry
   * drafts): access, the location, the move and the permission it needs. Nothing is written; the
   * same checks run again under the shipment lock when the change is applied.
   */
  async prepareStatusChange(
    user: AuthUser,
    id: string,
    input: { status: ShipmentStatus; locationId?: string | null },
  ): Promise<{ branchId: string }> {
    const shipment = await this.findScoped(user, id);
    if (input.locationId) await this.masterData.requireLocation(input.locationId);
    this.statusPlan(user, { ...input, occurredAt: new Date() })(
      shipment,
      replayHistory(shipment.events),
    );
    return { branchId: shipment.branchId };
  }

  /**
   * The checks of prepareStatusChange on what a status draft holds so far (a draft is saved with
   * missing values): the shipment as the user sees it, when named, and the location, when given;
   * the move itself waits for both the shipment and the status (prepareStatusChange). The
   * shipment's branch, or null with no shipment. Nothing is written.
   */
  async checkStatusPresent(
    user: AuthUser,
    id: string | null,
    input: { locationId?: string | null },
  ): Promise<{ branchId: string | null }> {
    const shipment = id === null ? null : await this.findScoped(user, id);
    if (input.locationId) await this.masterData.requireLocation(input.locationId);
    return { branchId: shipment?.branchId ?? null };
  }

  /**
   * A status change dated now, in the caller's transaction (an approved entry draft). The caller
   * checked access; the move and its permission are checked here under the shipment lock.
   */
  async changeStatusInTx(
    tx: Tx,
    user: AuthUser,
    id: string,
    input: { status: ShipmentStatus; locationId?: string | null; note?: string | null },
  ): Promise<void> {
    if (input.locationId) await this.masterData.requireLocation(input.locationId);
    await this.applyEventInTx(
      tx,
      user,
      id,
      this.statusPlan(user, { ...input, occurredAt: new Date() }),
    );
  }

  private statusPlan(
    user: AuthUser,
    input: {
      status: ShipmentStatus;
      occurredAt: Date;
      /**
       * The time was entered by the user: it may not be before the shipment's creation or a step
       * it still stands on. A move recorded at "now" (an approved draft, an empty time) is never
       * refused for its time, even after a step entered a few minutes ahead (FUTURE_TOLERANCE_MS).
       */
      entered?: boolean;
      locationId?: string | null;
      note?: string | null;
      noChargeReason?: string | null;
    },
  ): Planner {
    return (shipment, path) => {
      if (!nextStatuses(shipment.status, shipment, visitedStatuses(path)).includes(input.status)) {
        throw new ConflictException(`Cannot move from ${shipment.status} to ${input.status}`);
      }
      requireAny(user, permissionForTransition(input.status), shipment);
      if (input.entered) {
        const earliest = earliestEntryTime(shipment.createdAt, path);
        if (input.occurredAt < earliest) {
          throw fieldRefusal(
            'STATUS_TIME_TOO_EARLY',
            'The time of a status change cannot be before the shipment was created or its last status',
            ['occurredAt'],
            { earliest: earliest.toISOString() },
          );
        }
      }
      return {
        kind: 'STATUS',
        status: input.status,
        occurredAt: input.occurredAt,
        locationId: input.locationId ?? null,
        note: input.note ?? null,
        reason: input.status === 'CLOSED' ? (input.noChargeReason ?? null) : null,
        update: {
          status: input.status,
          ...(input.status === 'CLOSED' ? { closedAt: new Date() } : {}),
        },
        after:
          input.status === 'CLOSED'
            ? async (tx) => {
                await this.requireCloseConditions(tx, shipment, input.noChargeReason ?? null);
                await this.bookingLifecycle.completeForShipment(tx, shipment.bookingId);
              }
            : undefined,
      };
    };
  }

  async hold(
    user: AuthUser,
    id: string,
    reason: string,
    note: string | null,
  ): Promise<ShipmentDto> {
    await this.findScoped(user, id);
    await this.applyEvent(user, id, (shipment) => {
      requireAny(user, ['shipments:update'], shipment);
      if (!canHold(shipment.status)) {
        throw new ConflictException(`A ${shipment.status} shipment cannot be put on hold`);
      }
      return {
        kind: 'HOLD',
        status: 'ON_HOLD',
        reason,
        note,
        update: { status: 'ON_HOLD', statusBeforeHold: shipment.status, holdReason: reason },
      };
    });
    return this.get(user, id);
  }

  async resume(user: AuthUser, id: string, note: string | null): Promise<ShipmentDto> {
    await this.findScoped(user, id);
    await this.applyEvent(user, id, (shipment) => {
      requireAny(user, ['shipments:update'], shipment);
      if (shipment.status !== 'ON_HOLD' || !shipment.statusBeforeHold) {
        throw new ConflictException('The shipment is not on hold');
      }
      return {
        kind: 'RESUME',
        status: shipment.statusBeforeHold,
        note,
        update: { status: shipment.statusBeforeHold, statusBeforeHold: null, holdReason: null },
      };
    });
    return this.get(user, id);
  }

  /** Annex B: going back a status needs a permission and a reason, and is recorded. */
  async revert(
    user: AuthUser,
    id: string,
    input: { reason: string; undoEventId: string },
  ): Promise<ShipmentDto> {
    const { reason, undoEventId } = input;
    await this.findScoped(user, id);
    await this.applyEvent(user, id, (shipment, path) => {
      requireAny(user, ['shipments:approve'], shipment);
      const target = revertTarget(path);
      if (!target) throw new ConflictException('There is no earlier status to go back to');
      // The step the user saw and confirmed: if anything changed since, nothing is undone.
      if (path.at(-1)?.eventId !== undoEventId) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'REVERT_STALE',
          'The shipment changed since the revert was shown; check it again',
        );
      }
      // Container closes lock their shipments, so the link read with the lock is current.
      const link = shipment.consolidationLinks[0];
      if (path.at(-1)?.status === 'CONSOLIDATED' && link) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'REVERT_CLOSED_CONTAINER',
          `The shipment is in closed container ${link.consolidation.number}; its consolidation is final`,
          { container: link.consolidation.number },
        );
      }
      const remaining = path.slice(0, -1);
      const undone = path.at(-1);
      const note = shipment.events.find((e) => e.id.toString() === undone?.eventId)?.note ?? null;
      return {
        kind: 'REVERT',
        status: target,
        reason,
        update: {
          status: target,
          currentLocationId: remaining.findLast((entry) => entry.locationId)?.locationId ?? null,
        },
        // B2: a step that a trip, container, warehouse movement, proof of delivery or customs
        // file made stays; undoing it here would leave the record and the status disagreeing.
        after: async (tx) => {
          if (!undone) return;
          const blocker = await this.links.revertBlockerInTx(tx, shipment.id, {
            status: undone.status,
            note,
          });
          if (blocker) throw revertRefusal(blocker);
        },
      };
    });
    return this.get(user, id);
  }

  /** Cancels the shipment and its booking. */
  async cancel(user: AuthUser, id: string, reason: string): Promise<ShipmentDto> {
    await this.findScoped(user, id);
    await this.applyEvent(user, id, (shipment, path) =>
      this.cancelEvent(user, shipment, path, reason, 'shipments:cancel'),
    );
    return this.get(user, id);
  }

  /**
   * Cancelling a confirmed booking (bookings:cancel) cancels its shipment under the shipment's
   * rules (not after delivery started; after loading only a Branch Manager), inside the
   * booking's transaction; the shipment's cancellation then cancels the booking. Returns false
   * when the booking has no shipment (confirmed before shipments existed).
   */
  /**
   * For other modules (a warehouse receipt), inside their transaction: moves the shipment to
   * `status` through the state machine when that move is allowed now, and records the event like
   * any status change. Returns false, changing nothing, when the state machine does not allow it.
   * 403 when it is allowed but the user lacks the permission for it. `locationId`, when given, is
   * where the shipment now is (a trip's destination on arrival): it becomes the current location
   * the tracking page shows.
   */
  async advanceInTx(
    tx: Tx,
    user: AuthUser,
    id: string,
    status: ShipmentStatus,
    options: {
      occurredAt: Date;
      note: string | null;
      locationId?: string | null;
      /**
       * When set, a move dated before the shipment's latest event is refused (409) with this
       * message instead of rewriting its timeline. Only checked when the move happens.
       */
      beforeLatestEvent?: string;
    },
  ): Promise<boolean> {
    return this.applyEventInTx(tx, user, id, (shipment, path) => {
      if (!nextStatuses(shipment.status, shipment, visitedStatuses(path)).includes(status)) {
        return null;
      }
      requireAny(user, permissionForTransition(status), shipment);
      if (options.beforeLatestEvent) {
        const latest = shipment.events.reduce<Date | null>(
          (max, e) => (max && max >= e.occurredAt ? max : e.occurredAt),
          null,
        );
        if (latest && options.occurredAt < latest) {
          throw new ConflictException(options.beforeLatestEvent);
        }
      }
      return {
        kind: 'STATUS',
        status,
        occurredAt: options.occurredAt,
        note: options.note,
        locationId: options.locationId ?? null,
        update: { status },
      };
    });
  }

  /**
   * For a proof of delivery that keeps the shipment's status, inside its transaction (the caller
   * holds the shipment lock): where the shipment now is, for the tracking page. No status event.
   */
  async relocateInTx(tx: Tx, id: string, locationId: string): Promise<void> {
    await tx.shipment.update({ where: { id }, data: { currentLocationId: locationId } });
  }

  /**
   * For consolidation, inside its transaction (the caller holds the shipment lock): what decides
   * whether the shipment can go in a consolidated container (an LCL sea shipment NOLON carries).
   */
  async shapeInTx(
    tx: Tx,
    id: string,
  ): Promise<{
    mode: ShippingMode;
    loadType: LoadType | null;
    services: BookingService[];
    originLocationId: string;
  }> {
    return tx.shipment.findUniqueOrThrow({
      where: { id },
      select: { mode: true, loadType: true, services: true, originLocationId: true },
    });
  }

  /**
   * For consolidation, inside its transaction (the caller holds the shipment locks): the voyage of
   * the container the shipments are in (annex B: the container's updates apply to its shipments).
   * A field left out (undefined) is not touched; null clears it.
   */
  async setVoyageInTx(
    tx: Tx,
    ids: readonly string[],
    voyage: {
      carrierName?: string | null;
      vesselName?: string | null;
      voyageNumber?: string | null;
      etd?: Date | null;
      eta?: Date | null;
    },
  ): Promise<void> {
    const data = Object.fromEntries(Object.entries(voyage).filter(([, v]) => v !== undefined));
    if (ids.length === 0 || Object.keys(data).length === 0) return;
    await tx.shipment.updateMany({ where: { id: { in: [...ids] } }, data });
  }

  /** For a proof of delivery without a trip, inside its transaction: the shipment's destination. */
  async destinationInTx(tx: Tx, id: string): Promise<string> {
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id },
      select: { destinationLocationId: true },
    });
    return shipment.destinationLocationId;
  }

  /**
   * For inland transport and containers: the shipments among `ids` the user may see, with what a
   * trip shows of them (number, customer, status, destination, packages, weight and volume of the
   * cargo lines).
   */
  async tripSummaries(
    user: AuthUser,
    ids: readonly string[],
  ): Promise<
    {
      id: string;
      number: string;
      customerId: string;
      customerName: string;
      status: ShipmentStatus;
      destinationLocationId: string;
      items: {
        quantity: number;
        weightKg: Prisma.Decimal | null;
        volumeCbm: Prisma.Decimal | null;
      }[];
    }[]
  > {
    if (ids.length === 0) return [];
    const shipments = await this.prisma.shipment.findMany({
      where: { id: { in: [...ids] }, ...this.scope(user) },
      select: {
        id: true,
        number: true,
        customerId: true,
        status: true,
        destinationLocationId: true,
        customer: { select: { name: true } },
        items: { select: { quantity: true, weightKg: true, volumeCbm: true } },
      },
    });
    return shipments.map(({ customer, ...rest }) => ({ ...rest, customerName: customer.name }));
  }

  /**
   * For the profitability report: the shipments among `ids` the user may see (optionally of one
   * customer), with their branch, customer and route.
   */
  async reportSummaries(
    user: AuthUser,
    ids: readonly string[],
    customerId?: string,
  ): Promise<
    {
      id: string;
      number: string;
      branchCode: string;
      customerId: string;
      customerName: string;
      origin: { id: string; code: string; nameEn: string; nameAr: string };
      destination: { id: string; code: string; nameEn: string; nameAr: string };
    }[]
  > {
    if (ids.length === 0) return [];
    const location = { select: { id: true, code: true, nameEn: true, nameAr: true } };
    const shipments = await this.prisma.shipment.findMany({
      where: { id: { in: [...ids] }, ...(customerId ? { customerId } : {}), ...this.scope(user) },
      select: {
        id: true,
        number: true,
        customerId: true,
        branch: { select: { code: true } },
        customer: { select: { name: true } },
        origin: location,
        destination: location,
      },
      orderBy: { number: 'asc' },
    });
    return shipments.map(({ branch, customer, ...rest }) => ({
      ...rest,
      branchCode: branch.code,
      customerName: customer.name,
    }));
  }

  /**
   * For trip costs, inside the posting transaction: the cargo lines' weight and volume of the
   * trip's shipments (the caller holds the trip lock and has checked access to the trip).
   */
  async cargoMeasuresInTx(
    tx: Tx,
    ids: readonly string[],
  ): Promise<
    { id: string; items: { weightKg: Prisma.Decimal | null; volumeCbm: Prisma.Decimal | null }[] }[]
  > {
    return tx.shipment.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, items: { select: { weightKg: true, volumeCbm: true } } },
      orderBy: { id: 'asc' },
    });
  }

  async cancelForBooking(
    tx: Tx,
    user: AuthUser,
    bookingId: string,
    reason: string,
  ): Promise<boolean> {
    const shipment = await tx.shipment.findUnique({ where: { bookingId }, select: { id: true } });
    if (!shipment) return false;
    await this.applyEventInTx(tx, user, shipment.id, (locked, path) =>
      this.cancelEvent(user, locked, path, reason, 'bookings:cancel'),
    );
    return true;
  }

  async addContainer(
    user: AuthUser,
    id: string,
    input: ShipmentContainerInput,
  ): Promise<ShipmentDto> {
    await this.findEditable(user, id);
    await this.masterData.requireContainerType(input.containerTypeCode);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockActive(tx, id);
        await tx.shipmentContainer.create({
          data: {
            shipmentId: id,
            containerNumber: input.containerNumber,
            sealNumber: input.sealNumber ?? null,
            containerTypeCode: input.containerTypeCode,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This container is already on the shipment');
      }
      throw error;
    }
    return this.get(user, id);
  }

  async updateContainer(
    user: AuthUser,
    id: string,
    containerId: string,
    input: ShipmentContainerInput,
  ): Promise<ShipmentDto> {
    await this.findEditable(user, id);
    await this.masterData.requireContainerType(input.containerTypeCode);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockActive(tx, id);
        const { count } = await tx.shipmentContainer.updateMany({
          where: { id: containerId, shipmentId: id },
          data: {
            containerNumber: input.containerNumber,
            sealNumber: input.sealNumber ?? null,
            containerTypeCode: input.containerTypeCode,
          },
        });
        if (count === 0) throw new NotFoundException('Container not found');
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This container is already on the shipment');
      }
      throw error;
    }
    return this.get(user, id);
  }

  async removeContainer(user: AuthUser, id: string, containerId: string): Promise<ShipmentDto> {
    await this.findEditable(user, id);
    await this.prisma.$transaction(async (tx) => {
      await this.lockActive(tx, id);
      const { count } = await tx.shipmentContainer.deleteMany({
        where: { id: containerId, shipmentId: id },
      });
      if (count === 0) throw new NotFoundException('Container not found');
    });
    return this.get(user, id);
  }

  /** QR code (SVG) of the public tracking link, for labels and documents. */
  async qrSvg(user: AuthUser, id: string): Promise<string> {
    const shipment = await this.findScoped(user, id);
    return QRCode.toString(this.trackingUrl(shipment.trackingToken), {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
    });
  }

  private trackingUrl(token: string): string {
    const base = this.env.PUBLIC_WEB_URL ?? this.env.CORS_ORIGINS[0];
    if (!base) throw new ConflictException('PUBLIC_WEB_URL is not configured');
    return `${base.replace(/\/+$/, '')}/track/${token}`;
  }

  // -------------------------------------------------------------------------------------------

  private cancelEvent(
    user: AuthUser,
    shipment: LockedShipment,
    path: HistoryEntry[],
    reason: string,
    permission: Permission,
  ): PlannedEvent {
    requireAny(user, [permission], shipment);
    if (!canCancelStatus(shipment.status)) {
      throw new ConflictException(`A ${shipment.status} shipment cannot be cancelled`);
    }
    if (hasPassedLoading(path) && !isLateCanceller(user)) {
      throw new ForbiddenException('After loading, only a Branch Manager can cancel a shipment');
    }
    return {
      kind: 'CANCEL',
      status: 'CANCELLED',
      reason,
      update: {
        status: 'CANCELLED',
        cancelReason: reason,
        cancelledAt: new Date(),
        statusBeforeHold: null,
        holdReason: null,
      },
      after: async (tx) => {
        // B2: a trip under way or a container in transit cannot drop the shipment, so cancelling
        // it would strand them.
        const blocker = await this.links.cancelBlockerInTx(tx, shipment.id);
        if (blocker) throw cancelRefusal(shipment.number, blocker);
        await this.requireNoLiveInvoices(tx, shipment);
        await this.bookingLifecycle.cancelForShipment(tx, shipment.bookingId, reason);
      },
    };
  }

  /**
   * Annex B: a shipment that an invoice still bills is not cancelled (owner decision Q2). The
   * caller holds the shipment's row lock exclusively; invoices lock it (share) before they are
   * created or approved, so none appears or gets approved between this check and the commit.
   */
  private async requireNoLiveInvoices(tx: Tx, shipment: LockedShipment): Promise<void> {
    const { approved, drafts } = await this.invoices.get().liveInvoicesInTx(tx, shipment.id);
    if (approved.length === 0 && drafts === 0) return;
    throw codedRefusal(
      HttpStatus.CONFLICT,
      'SHIPMENT_HAS_LIVE_INVOICES',
      `Shipment ${shipment.number} still has invoices: cancel its draft invoices (${drafts}) and fully credit its approved ones (${approved.join(', ') || 'none'}); a paid invoice blocks the cancellation`,
      { shipment: shipment.number, approved: approved.join(', ') || '—', drafts: String(drafts) },
    );
  }

  /** What closing the shipment needs now (B1-5): its goods on hand, and whether it is invoiced. */
  private async closeCheck(tx: Tx, shipmentId: string): Promise<ShipmentCloseCheckDto> {
    const [goodsOnHand, { approved }] = await Promise.all([
      this.stock.get().goodsOnHandInTx(tx, shipmentId),
      this.invoices.get().liveInvoicesInTx(tx, shipmentId),
    ]);
    return { goodsOnHand, invoiced: approved.length > 0 };
  }

  /**
   * Owner decision Q1: a shipment closes with none of its goods in any warehouse, and with an
   * approved invoice billing it or a reason it is closed without charges (recorded on the closing
   * event). The caller holds the shipment's row lock exclusively; warehouse movements and invoice
   * approvals lock it before they write, so neither changes between this check and the commit.
   */
  private async requireCloseConditions(
    tx: Tx,
    shipment: LockedShipment,
    noChargeReason: string | null,
  ): Promise<void> {
    const goods = await this.stock.get().goodsOnHandInTx(tx, shipment.id);
    if (goods.length > 0) {
      const warehouses = goods.map((g) => `${g.warehouseCode} (${g.packages})`).join(', ');
      throw codedRefusal(
        HttpStatus.CONFLICT,
        'SHIPMENT_CLOSE_GOODS_ON_HAND',
        `Shipment ${shipment.number} still has goods in ${warehouses}: release them before closing it`,
        { shipment: shipment.number, warehouses },
      );
    }
    const { approved, drafts } = await this.invoices.get().liveInvoicesInTx(tx, shipment.id);
    if (approved.length > 0) {
      if (noChargeReason) {
        throw new BadRequestException(
          `Shipment ${shipment.number} is invoiced (${approved.join(', ')}): close it without a no-charge reason`,
        );
      }
      return;
    }
    if (noChargeReason) return;
    throw codedRefusal(
      HttpStatus.CONFLICT,
      'SHIPMENT_CLOSE_NOT_INVOICED',
      `No approved invoice bills shipment ${shipment.number} (draft invoices: ${drafts}): approve its invoice, or give the reason it closes without charges`,
      { shipment: shipment.number, drafts: String(drafts) },
    );
  }

  private async applyEvent(user: AuthUser, id: string, plan: Planner): Promise<void> {
    await this.prisma.$transaction((tx) => this.applyEventInTx(tx, user, id, plan));
  }

  /**
   * Locks the shipment row, replays its history, asks `plan` for the event (which throws when the
   * change is not allowed, or returns null to change nothing), then updates the shipment and
   * records the event. Concurrent changes to the same shipment queue on the lock and each sees the
   * result of the one before. Returns whether an event was recorded.
   */
  private async applyEventInTx(
    tx: Tx,
    user: AuthUser,
    id: string,
    plan: NullablePlanner,
  ): Promise<boolean> {
    await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id },
      include: {
        events: { orderBy: { id: 'asc' } },
        consolidationLinks: closedContainerLinks,
        sharedBranches: sharedBranchesSelect,
      },
    });
    const path = replayHistory(shipment.events);
    const event = plan(shipment, path);
    if (!event) return false;
    const occurredAt = event.occurredAt ?? new Date();
    await tx.shipment.update({
      where: { id },
      data: {
        ...event.update,
        ...(event.locationId ? { currentLocationId: event.locationId } : {}),
      },
    });
    await tx.shipmentEvent.create({
      data: {
        shipmentId: id,
        kind: event.kind,
        status: event.status,
        fromStatus: shipment.status,
        occurredAt,
        branchId: shipment.branchId,
        locationId: event.locationId ?? null,
        userId: user.id,
        source: 'USER',
        note: event.note ?? null,
        reason: event.reason ?? null,
      },
    });
    if (event.after) await event.after(tx);
    return true;
  }

  /**
   * For other modules writing under a shipment (documents, warehouse, customs): locks the
   * shipment row inside the caller's transaction and returns its status. Status changes take the
   * row lock exclusively, so a cancel either commits first and is seen here, or waits for this
   * write. The default share lock lets child writes run side by side; `exclusive` also queues
   * them behind each other, for writes that check a running total (warehouse releases) or may
   * change the status in the same transaction (warehouse receipts).
   */
  async lockForChildWrite(
    tx: Tx,
    id: string,
    options: { exclusive?: boolean } = {},
  ): Promise<ShipmentStatus> {
    const rows = options.exclusive
      ? await tx.$queryRaw<{ status: ShipmentStatus }[]>`
          SELECT "status"::text AS "status" FROM "shipments" WHERE "id" = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<{ status: ShipmentStatus }[]>`
          SELECT "status"::text AS "status" FROM "shipments" WHERE "id" = ${id}::uuid FOR SHARE`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Shipment not found');
    return row.status;
  }

  /**
   * For writes under a shipment that the caller has already locked (lockForChildWrite): its
   * branch, the branches sharing it, and when its latest recorded event happened. A change dated
   * before that event would rewrite the shipment's timeline, so callers refuse it.
   */
  async branchAndLastEventInTx(
    tx: Tx,
    id: string,
  ): Promise<{ branchId: string; sharedBranchIds: string[]; lastEventAt: Date | null }> {
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id },
      select: {
        branchId: true,
        sharedBranches: sharedBranchesSelect,
        events: { select: { occurredAt: true }, orderBy: { occurredAt: 'desc' }, take: 1 },
      },
    });
    return {
      branchId: shipment.branchId,
      sharedBranchIds: shipment.sharedBranches.map((b) => b.branchId),
      lastEventAt: shipment.events[0]?.occurredAt ?? null,
    };
  }

  /**
   * Shares the shipment with one more active branch, under its row lock (held by the caller); a
   * branch already sharing it is left as it is.
   */
  async shareWithBranchInTx(tx: Tx, id: string, branchId: string): Promise<void> {
    const current = await this.sharedBranchIdsInTx(tx, id);
    if (current.includes(branchId)) return;
    await this.replaceSharedBranchesInTx(tx, id, [...current, branchId]);
  }

  private async sharedBranchIdsInTx(tx: Tx, id: string): Promise<string[]> {
    const rows = await tx.shipmentBranch.findMany({
      where: { shipmentId: id },
      select: { branchId: true },
      orderBy: { branchId: 'asc' },
    });
    return rows.map((r) => r.branchId);
  }

  /**
   * Replaces the branches sharing the shipment, under its row lock (held by the caller). A branch
   * added must be active, and stays so until the caller commits. A branch removed loses access;
   * what its users recorded (receipts, trips, PODs) stays on the shipment.
   */
  private async replaceSharedBranchesInTx(
    tx: Tx,
    id: string,
    branchIds: readonly string[],
  ): Promise<void> {
    const current = await this.sharedBranchIdsInTx(tx, id);
    const added = branchIds.filter((b) => !current.includes(b));
    const active = await lockActiveBranches(tx, added);
    if (added.some((b) => !active.has(b))) {
      throw new BadRequestException('Unknown or inactive branch');
    }
    await tx.shipmentBranch.deleteMany({
      where: { shipmentId: id, branchId: { notIn: [...branchIds] } },
    });
    if (added.length > 0) {
      await tx.shipmentBranch.createMany({
        data: added.map((branchId) => ({ shipmentId: id, branchId })),
      });
    }
  }

  /** Row lock and current status, inside the caller's transaction. */
  private async lockStatus(tx: Tx, id: string): Promise<ShipmentStatus> {
    const rows = await tx.$queryRaw<{ status: ShipmentStatus }[]>`
      SELECT "status"::text AS "status" FROM "shipments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Shipment not found');
    return row.status;
  }

  /** Locks the shipment for a write to its containers; 409 once it is closed or cancelled. */
  private async lockActive(tx: Tx, id: string): Promise<void> {
    if (!isActive(await this.lockStatus(tx, id))) {
      throw new ConflictException('A closed or cancelled shipment cannot be edited');
    }
  }

  /**
   * Branch scope (AGENTS.md rule 2). A Driver (annex A, own trips) sees only the shipments carried
   * on trips assigned to them (their driver record is linked to their user), cancelled trips
   * excepted; the trip in one of their branches, the shipment visible in one of them.
   */
  /** The shipments this user may see (scope below): for records read through their shipment. */
  visibleWhere(user: AuthUser): Prisma.ShipmentWhereInput {
    return this.scope(user);
  }

  private scope(user: AuthUser): Prisma.ShipmentWhereInput {
    if (limitedToOwnTrips(user, 'shipments')) {
      return {
        ...shipmentScope(user),
        tripLinks: {
          some: {
            trip: {
              ...branchScope(user),
              status: { not: 'CANCELLED' },
              driver: { userId: user.id },
            },
          },
        },
      };
    }
    return shipmentScope(user);
  }

  private async findScoped(user: AuthUser, id: string): Promise<ShipmentWithDetails> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, ...this.scope(user) },
      include: details,
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    return shipment;
  }

  private async findEditable(user: AuthUser, id: string): Promise<ShipmentWithDetails> {
    const shipment = await this.findScoped(user, id);
    if (!isActive(shipment.status)) {
      throw new ConflictException('A closed or cancelled shipment cannot be edited');
    }
    return shipment;
  }

  private toDto(user: AuthUser, s: ShipmentWithDetails): ShipmentDto {
    const path = replayHistory(s.events);
    return {
      ...toSummary(s),
      cargoType: s.cargoType,
      cargoDescription: s.cargoDescription,
      services: s.services,
      shipperId: s.shipperId,
      consigneeId: s.consigneeId,
      notifyPartyId: s.notifyPartyId,
      statusBeforeHold: s.statusBeforeHold,
      holdReason: s.holdReason,
      cancelReason: s.cancelReason,
      currentLocationId: s.currentLocationId,
      carrierName: s.carrierName,
      vesselName: s.vesselName,
      voyageNumber: s.voyageNumber,
      blNumber: s.blNumber,
      etd: fromDbDateOrNull(s.etd),
      trackingToken: s.trackingToken,
      closedAt: s.closedAt?.toISOString() ?? null,
      packages: s.items.reduce((n, i) => n + i.quantity, 0),
      items: s.items.map((i) => ({
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
      containers: s.containers.map((c) => ({
        id: c.id,
        containerNumber: c.containerNumber,
        sealNumber: c.sealNumber,
        containerTypeCode: c.containerTypeCode,
      })),
      events: s.events.map((e) => ({
        id: e.id.toString(),
        kind: e.kind,
        status: e.status,
        fromStatus: e.fromStatus,
        occurredAt: e.occurredAt.toISOString(),
        branchId: e.branchId,
        locationId: e.locationId,
        userName: e.user?.fullName ?? null,
        source: e.source,
        note: e.note,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      })),
      sharedBranches: s.sharedBranches.map((b) => b.branch),
      shareableBranches: [],
      actions: actionsFor(user, s, path),
    };
  }
}

type LockedShipment = Prisma.ShipmentGetPayload<{
  include: {
    events: true;
    consolidationLinks: typeof closedContainerLinks;
    sharedBranches: typeof sharedBranchesSelect;
  };
}>;

interface PlannedEvent {
  kind: ShipmentEventKind;
  status: ShipmentStatus;
  occurredAt?: Date;
  locationId?: string | null;
  note?: string | null;
  reason?: string | null;
  update: Prisma.ShipmentUncheckedUpdateInput;
  /** Runs in the same transaction after the event is recorded (booking side effects). */
  after?: (tx: Tx) => Promise<void>;
}

type Planner = (shipment: LockedShipment, path: HistoryEntry[]) => PlannedEvent;

/** A planner that may decline: null records nothing. */
type NullablePlanner = (shipment: LockedShipment, path: HistoryEntry[]) => PlannedEvent | null;

/** One of `permissions`, held for this shipment (its branch or a branch sharing it). */
function requireAny(
  user: AuthUser,
  permissions: readonly Permission[],
  shipment: LockedShipment,
): void {
  const on = { branchId: shipment.branchId, sharedBranchIds: sharedIds(shipment) };
  if (!permissions.some((p) => holdsOnShipment(user, p, on))) {
    throw new ForbiddenException('Missing permission');
  }
}

function sharedIds(s: { sharedBranches: readonly { branchId: string }[] }): string[] {
  return s.sharedBranches.map((b) => b.branchId);
}

/**
 * B2 (F110-6): no way exists yet to take a shipment off a trip that has left or out of a closed
 * container, so the refusal says what can be done now instead of promising a correction.
 */
function cancelRefusal(shipment: string, blocker: ShipmentLinkBlocker): HttpException {
  return blocker.record === 'TRIP'
    ? codedRefusal(
        HttpStatus.CONFLICT,
        'SHIPMENT_CANCEL_ON_TRIP',
        `Shipment ${shipment} is on trip ${blocker.number}, which has left: it cannot be cancelled from here. Complete the trip, or ask a manager for a correction`,
        { shipment, trip: blocker.number },
      )
    : codedRefusal(
        HttpStatus.CONFLICT,
        'SHIPMENT_CANCEL_IN_CONTAINER',
        `Shipment ${shipment} is in container ${blocker.number}, which is closed: it cannot be cancelled from here. Unpack the container at its destination, or ask a manager for a correction`,
        { shipment, container: blocker.number },
      );
}

const REVERT_REFUSALS = {
  TRIP: 'REVERT_BY_TRIP',
  CONTAINER: 'REVERT_BY_CONTAINER',
  WAREHOUSE: 'REVERT_BY_WAREHOUSE',
  POD: 'REVERT_BY_POD',
  CUSTOMS: 'REVERT_BY_CUSTOMS',
} as const satisfies Record<ShipmentLinkBlocker['record'], FormRefusal>;

function revertRefusal(blocker: ShipmentLinkBlocker): HttpException {
  return codedRefusal(
    HttpStatus.CONFLICT,
    REVERT_REFUSALS[blocker.record],
    `This step was recorded by ${blocker.record.toLowerCase()} ${blocker.number}: it cannot be undone from here. Ask a manager for a correction`,
    { record: blocker.number },
  );
}

function isLateCanceller(user: AuthUser): boolean {
  return user.roles.some((role) => (LATE_CANCEL_ROLES as readonly string[]).includes(role));
}

function actionsFor(
  user: AuthUser,
  s: ShipmentWithDetails,
  path: HistoryEntry[],
): ShipmentActionsDto {
  const on = { branchId: s.branchId, sharedBranchIds: sharedIds(s) };
  const has = (permission: Permission) => holdsOnShipment(user, permission, on);
  const canUpdate = has('shipments:update');
  const undoes = revertUndoes(path);
  const links = s.consolidationLinks.map((link) => link.consolidation);
  const inContainer = links.find((c) => c.status !== 'DECONSOLIDATED') ?? null;
  const closed = links.find((c) => c.status !== 'OPEN') ?? null;
  const container = undoes?.status === 'CONSOLIDATED' && closed ? closed.number : null;
  const canRevert = has('shipments:approve') && undoes !== null && container === null;
  const transitions = nextStatuses(s.status, s, visitedStatuses(path)).filter((next) =>
    permissionForTransition(next).some(has),
  );
  const suggestedLocations: Partial<Record<ShipmentStatus, string>> = {};
  for (const next of transitions) {
    const place = usualPlace(next, s.mode);
    if (place) {
      suggestedLocations[next] = place === 'ORIGIN' ? s.originLocationId : s.destinationLocationId;
    }
  }
  const byContainer = transitions.filter((next) => CONTAINER_MOVED.includes(next));
  return {
    transitions,
    containerMoves:
      inContainer && byContainer.length > 0
        ? { container: inContainer.number, statuses: byContainer }
        : null,
    closeCheck: null,
    canHold: canUpdate && canHold(s.status),
    canResume: canUpdate && s.status === 'ON_HOLD',
    revertTo: canRevert ? revertTarget(path) : null,
    revertUndoes:
      canRevert && undoes?.eventId
        ? {
            eventId: undoes.eventId,
            status: undoes.status,
            occurredAt: undoes.occurredAt.toISOString(),
            userName:
              s.events.find((e) => e.id.toString() === undoes.eventId)?.user?.fullName ?? null,
            byMe: undoes.userId === user.id,
          }
        : null,
    revertBlockedByContainer: has('shipments:approve') ? container : null,
    earliestStatusTime: earliestEntryTime(s.createdAt, path).toISOString(),
    suggestedLocations,
    canCancel:
      has('shipments:cancel') &&
      canCancelStatus(s.status) &&
      (!hasPassedLoading(path) || isLateCanceller(user)),
    canEdit: canUpdate && isActive(s.status),
    canShareBranches: canUpdate && isActive(s.status) && canAccessBranch(user, s.branchId),
  };
}

/** 24 random bytes, base64url: 32 characters, not guessable and not derived from the number. */
function newTrackingToken(): string {
  return randomBytes(24).toString('base64url');
}

function toSummary(s: ShipmentWithSummary): ShipmentSummaryDto {
  return {
    id: s.id,
    number: s.number,
    branchId: s.branchId,
    sharedBranchIds: s.sharedBranches.map((b) => b.branchId),
    customerId: s.customerId,
    customerName: s.customer.name,
    bookingId: s.bookingId,
    bookingNumber: s.booking.number,
    originLocationId: s.originLocationId,
    destinationLocationId: s.destinationLocationId,
    mode: s.mode,
    loadType: s.loadType,
    status: s.status,
    eta: fromDbDateOrNull(s.eta),
    createdAt: s.createdAt.toISOString(),
  };
}
