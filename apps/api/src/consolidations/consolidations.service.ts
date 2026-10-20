import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  BillableConsolidationDto,
  BookingService,
  ConsolidationBookingDto,
  ConsolidationBookingRequest,
  ConsolidationDto,
  ConsolidationInput,
  ConsolidationMoveRequest,
  ConsolidationShipmentDto,
  ConsolidationStatus,
  ConsolidationSummaryDto,
  ConsolidationUpdateRequest,
  DraftContainer,
  Page,
  Permission,
  ShipmentConsolidationDto,
  ShipmentStatus,
} from '@nolon/shared';
import { hasSeaLeg } from '@nolon/shared';
import { seesConsolidationCosts } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import {
  assertBranchAccess,
  branchScope,
  canAccessBranch,
  listBranchScope,
} from '../auth/branch-scope.js';
import { fromDbDateOrNull, toDbDate, todayIn } from '../common/dates.js';
import {
  dateRange,
  matchedLocations,
  type RouteFilters,
  routeWhere,
} from '../common/list-filters.js';
import { type Decimal, ZERO, toDecimalString } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { codedRefusal, type PageQuery } from '../common/validation.js';
import type { Consolidation, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { shipmentBranches, shipmentScope } from '../shipments/shipment-scope.js';
import { BookingsService, type PreparedBooking } from '../bookings/bookings.service.js';
import {
  type ContainerBookingHandler,
  type ContainerBookingShape,
  ContainerBookingsRegistry,
} from '../bookings/container-bookings.registry.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive, stageApplies } from '../shipments/state-machine.js';
import {
  atOrPastOnSeaLeg,
  canBookInto,
  basisValueOf,
  consolidationMoves,
  isClosed,
  isEditable,
  isOpen,
  shipmentStatusFor,
  takesCosts,
} from './consolidation-rules.js';
import { type ClosedContainer, ContainerCostsRegistry } from './container-costs.registry.js';

type Tx = Prisma.TransactionClient;

/** A container a bill charges, as locked by the bill's approval or cancellation. */
export interface ContainerForCosts {
  id: string;
  number: string;
  branchId: string;
  /** Set once the container is closed: its costs are shared out as they are approved. */
  closed: ClosedContainer | null;
}

export interface ConsolidationFilters extends PageQuery, RouteFilters {
  status?: ConsolidationStatus;
  /** One of the user's branches (403 otherwise); else all of them. */
  branchId?: string;
  /** ETD from / to, both included. */
  from?: string;
  to?: string;
  /** Open containers of every branch, to book into (canBookInto); the branch filter is ignored. */
  bookable?: boolean;
}

/** At most this many shipments in one container. */
export const MAX_CONTAINER_SHIPMENTS = 100;

/** A container change may be recorded after the fact, but not ahead of the clock. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Statuses a shipment can be in when it is put in a container: before the sea leg. */
const BEFORE_CONSOLIDATION: readonly ShipmentStatus[] = [
  'CREATED',
  'PICKUP_SCHEDULED',
  'RECEIVED_ORIGIN_WAREHOUSE',
  'CONSOLIDATED',
];

const summaryInclude = {
  _count: { select: { shipments: true } },
} satisfies Prisma.ConsolidationInclude;

type ContainerWithSummary = Prisma.ConsolidationGetPayload<{ include: typeof summaryInclude }>;

const detailInclude = {
  ...summaryInclude,
  createdBy: { select: { fullName: true } },
  shipments: { orderBy: { addedAt: 'asc' } },
} satisfies Prisma.ConsolidationInclude;

type ContainerWithDetails = Prisma.ConsolidationGetPayload<{ include: typeof detailInclude }>;

/**
 * Consolidated (LCL) containers (annex B, consolidation): shipments of different customers in one
 * sea container. The container's status drives its shipments through the shipment state machine,
 * in the same transaction:
 * - closing it (stuffed and sealed) moves every shipment to CONSOLIDATED and freezes each
 *   shipment's CBM or weight, the basis of its share of the container's costs;
 * - loading, departing and arriving move them to LOADED, DEPARTED and ARRIVED_PORT;
 * - unpacking it (deconsolidation) at the destination leaves each shipment to go on by itself.
 * A shipment already at the target or beyond it (moved by hand) is left as it is; when any
 * shipment cannot take the move (on hold, cancelled, a stage missing), the change is refused with
 * 409 naming them and nothing is applied. The container's voyage (carrier, vessel, voyage, ETD,
 * ETA) is copied to its shipments whenever it is set.
 *
 * Costs (annex C rules 7a and 13): supplier bills charge the container to the consolidation
 * clearing account; closing it shares every approved cost between its shipments, and a cost
 * approved after the close is shared as it is approved, with the same frozen basis. Payables does
 * the posting (ContainerCostsRegistry).
 *
 * Locks: the container row first, then each shipment exclusively in id order, then (closing) the
 * approved bills. A shipment is in one container at a time (cancelled ones aside), checked under
 * its lock.
 */
@Injectable()
export class ConsolidationsService implements ContainerBookingHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly masterData: MasterDataService,
    private readonly costs: ContainerCostsRegistry,
    private readonly bookings: BookingsService,
    private readonly containerBookings: ContainerBookingsRegistry,
  ) {}

  onModuleInit(): void {
    // Booking drafts that name a container are checked and approved by the rules below.
    this.containerBookings.register(this);
  }

  async list(
    user: AuthUser,
    filters: ConsolidationFilters,
  ): Promise<Page<ConsolidationSummaryDto>> {
    const route = await this.masterData.matchRoute(filters);
    if (filters.bookable && !canBookInto(user)) {
      throw new ForbiddenException('Missing permission to book into a container');
    }
    const where: Prisma.ConsolidationWhereInput = {
      ...(filters.bookable ? { status: 'OPEN' } : listBranchScope(user, filters.branchId)),
      etd: dateRange(filters.from, filters.to),
      ...(filters.status && !filters.bookable ? { status: filters.status } : {}),
      ...routeWhere(route),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { containerNumber: { contains: filters.q.toUpperCase() } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.consolidation.findMany({
        where,
        include: summaryInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.consolidation.count({ where }),
    ]);
    return {
      items: items.map(toSummary),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      ...matchedLocations(route),
    };
  }

  async get(user: AuthUser, id: string): Promise<ConsolidationDto> {
    const { container, own } = await this.findViewable(user, id);
    return this.toDto(user, container, own);
  }

  /**
   * The containers of a shipment the user can see (404 unless they can see the shipment). Each
   * can be opened: a container of another branch shows the user's own shipments only.
   */
  async forShipment(user: AuthUser, shipmentId: string): Promise<ShipmentConsolidationDto[]> {
    await this.shipments.requireAccessible(user, shipmentId);
    const containers = await this.prisma.consolidation.findMany({
      where: { shipments: { some: { shipmentId } } },
      orderBy: { createdAt: 'asc' },
    });
    return containers.map((c) => ({
      id: c.id,
      number: c.number,
      status: c.status,
      containerNumber: c.containerNumber,
      canOpen: true,
    }));
  }

  /** Containers of the user's branches a supplier bill may charge (rule 7a), for the bill form. */
  async billable(user: AuthUser, branchId?: string): Promise<BillableConsolidationDto[]> {
    if (branchId) assertBranchAccess(user, branchId);
    const containers = await this.prisma.consolidation.findMany({
      where: { ...(branchId ? { branchId } : branchScope(user)), status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return containers.map((c) => ({
      id: c.id,
      number: c.number,
      branchId: c.branchId,
      status: c.status,
      containerNumber: c.containerNumber,
    }));
  }

  async create(user: AuthUser, input: ConsolidationInput): Promise<ConsolidationDto> {
    assertBranchAccess(user, input.branchId);
    await this.requirePorts(input.originLocationId, input.destinationLocationId);
    await this.masterData.requireContainerType(input.containerTypeCode);
    checkDates(input.etd ?? null, input.eta ?? null);
    const shipmentIds = [...new Set(input.shipmentIds)];
    if (shipmentIds.length !== input.shipmentIds.length) {
      throw new BadRequestException('Each shipment appears once');
    }
    const numbers = await this.requireVisibleShipments(user, shipmentIds);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: input.branchId },
      select: { timezone: true },
    });
    const id = await this.prisma.$transaction(async (tx) => {
      const year = todayIn(branch.timezone).slice(0, 4);
      const number = formatDocumentNumber(
        'CON',
        await nextSequenceValue(tx, 'CONSOLIDATION', year),
        year,
      );
      const container = await tx.consolidation.create({
        data: {
          number,
          branchId: input.branchId,
          originLocationId: input.originLocationId,
          destinationLocationId: input.destinationLocationId,
          containerTypeCode: input.containerTypeCode,
          containerNumber: input.containerNumber ?? null,
          sealNumber: input.sealNumber ?? null,
          carrierName: input.carrierName ?? null,
          vesselName: input.vesselName ?? null,
          voyageNumber: input.voyageNumber ?? null,
          masterBlNumber: input.masterBlNumber ?? null,
          etd: input.etd ? toDbDate(input.etd) : null,
          eta: input.eta ? toDbDate(input.eta) : null,
          basis: input.basis ?? 'CBM',
          notes: input.notes ?? null,
          createdById: user.id,
        },
      });
      await this.addShipments(tx, user, container, shipmentIds, numbers);
      return container.id;
    });
    return this.get(user, id);
  }

  /**
   * Corrects the container's details until it is unpacked (the basis only while it is open); the
   * voyage is copied to its shipments.
   */
  async update(
    user: AuthUser,
    id: string,
    input: ConsolidationUpdateRequest,
  ): Promise<ConsolidationDto> {
    await this.findOwn(user, id);
    if (input.containerTypeCode)
      await this.masterData.requireContainerType(input.containerTypeCode);
    await this.prisma.$transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      if (!isEditable(container.status)) {
        throw new ConflictException(`A ${container.status} container cannot be edited`);
      }
      if (input.basis && input.basis !== container.basis && !isOpen(container.status)) {
        throw new ConflictException('The cost basis is fixed once the container is closed');
      }
      if (
        input.containerNumber === null &&
        container.containerNumber !== null &&
        isClosed(container.status)
      ) {
        throw new BadRequestException('A closed container keeps its number');
      }
      const pick = <T>(sent: T | undefined, current: T): T => (sent === undefined ? current : sent);
      const etd = pick(input.etd, fromDbDateOrNull(container.etd));
      const eta = pick(input.eta, fromDbDateOrNull(container.eta));
      checkDates(etd, eta);
      const updated = await tx.consolidation.update({
        where: { id },
        data: {
          containerTypeCode: pick(input.containerTypeCode, container.containerTypeCode),
          containerNumber: pick(input.containerNumber, container.containerNumber),
          sealNumber: pick(input.sealNumber, container.sealNumber),
          carrierName: pick(input.carrierName, container.carrierName),
          vesselName: pick(input.vesselName, container.vesselName),
          voyageNumber: pick(input.voyageNumber, container.voyageNumber),
          masterBlNumber: pick(input.masterBlNumber, container.masterBlNumber),
          etd: etd ? toDbDate(etd) : null,
          eta: eta ? toDbDate(eta) : null,
          basis: pick(input.basis, container.basis),
          notes: pick(input.notes, container.notes),
        },
      });
      const ids = await this.lockShipments(tx, id);
      // Only the voyage fields sent are copied, a clear (null) included: an edit of the notes
      // leaves the shipments' own voyage alone.
      await this.shipments.setVoyageInTx(tx, ids, sentVoyage(input, updated));
    });
    return this.get(user, id);
  }

  /**
   * Puts another shipment in an open container: the container's branch, or another branch adding
   * a shipment of its own (see addShipments).
   */
  async addShipment(user: AuthUser, id: string, shipmentId: string): Promise<ConsolidationDto> {
    await this.findViewable(user, id);
    const numbers = await this.requireVisibleShipments(user, [shipmentId]);
    await this.prisma.$transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      requireOpen(container);
      await requireRoom(tx, container);
      await this.addShipments(tx, user, container, [shipmentId], numbers);
    });
    return this.get(user, id);
  }

  /**
   * An LCL sea booking made from the container's page: it leaves from the container's port of
   * loading and carries NOLON's main freight. In one transaction the booking is recorded, confirmed
   * (creating its shipment) and its shipment put in the container, so a container that closed or
   * filled up meanwhile leaves no booking behind.
   *
   * Any branch may book its customers into an open container (canBookInto): the booking and its
   * shipment are the customer's branch's, and the shipment is shared with the container's branch,
   * which loads it and alone takes it out or moves it (findOwn).
   */
  async createBooking(
    user: AuthUser,
    id: string,
    input: ConsolidationBookingRequest,
  ): Promise<ConsolidationBookingDto> {
    const { container: existing } = await this.findViewable(user, id);
    requireOpen(existing);
    const services: BookingService[] = input.services.includes('MAIN_FREIGHT')
      ? input.services
      : ['MAIN_FREIGHT', ...input.services];
    const prepared = await this.bookings.prepareCreate(user, {
      ...input,
      services,
      mode: 'SEA',
      loadType: 'LCL',
      originLocationId: existing.originLocationId,
    });
    return this.prisma.$transaction(async (tx) => {
      const bookingId = await this.bookInTx(tx, user, id, prepared);
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { number: true, shipment: { select: { id: true, number: true } } },
      });
      if (!booking.shipment) throw new Error(`Booking ${bookingId} was confirmed with no shipment`);
      return {
        bookingId,
        bookingNumber: booking.number,
        shipmentId: booking.shipment.id,
        shipmentNumber: booking.shipment.number,
      };
    });
  }

  /**
   * The container if this user could read it directly: an open one when they may book into
   * containers (GET /consolidations/bookable), else with consolidation:view as GET
   * /consolidations/:id does (findViewable). Null otherwise, or when it does not exist.
   */
  private async readableByDraft(user: AuthUser, id: string): Promise<Consolidation | null> {
    const container = await this.prisma.consolidation.findUnique({ where: { id } });
    if (!container) return null;
    if (isOpen(container.status) && canBookInto(user)) return container;
    if (!user.permissions.has('consolidation:view')) return null;
    try {
      await this.findViewable(user, id);
      return container;
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  /** The container as a reference of a draft (ContainerBookingHandler.requireReference). */
  async requireReference(user: AuthUser, id: string): Promise<void> {
    await this.bookableReference(user, id);
  }

  /**
   * A container a booking may name: the user may book into containers and read it directly
   * (findViewable: not found otherwise, naming nothing of it), and it is open with room.
   */
  private async bookableReference(user: AuthUser, id: string) {
    if (!canBookInto(user)) {
      throw new ForbiddenException(
        'Booking into a container needs permission to change containers and to create and confirm bookings',
      );
    }
    if (!(await this.readableByDraft(user, id))) throw new NotFoundException('Container not found');
    const container = await this.prisma.consolidation.findUnique({
      where: { id },
      include: summaryInclude,
    });
    if (!container) throw new NotFoundException('Container not found');
    requireOpen(container);
    if (container._count.shipments >= MAX_CONTAINER_SHIPMENTS) throw full(container);
    return container;
  }

  /**
   * A booking draft that names this container (ContainerBookingHandler): the same rules as a
   * booking from the container's page, except that the draft's values are never changed to fit
   * (the person approves what they read), so a booking that does not fit is refused, naming why.
   */
  async requireBookable(user: AuthUser, id: string, booking: ContainerBookingShape): Promise<void> {
    const container = await this.bookableReference(user, id);
    const params = { container: container.number };
    if (!hasSeaLeg(booking.mode) || booking.loadType !== 'LCL') {
      throw codedRefusal(
        HttpStatus.BAD_REQUEST,
        'CONTAINER_BOOKING_NOT_LCL_SEA',
        `Container ${container.number} takes LCL sea bookings only`,
        params,
      );
    }
    if (booking.originLocationId.toLowerCase() !== container.originLocationId) {
      throw codedRefusal(
        HttpStatus.BAD_REQUEST,
        'CONTAINER_BOOKING_OTHER_PORT',
        `Container ${container.number} loads at another port than the booking leaves from`,
        params,
      );
    }
    // The main freight is not checked: every booking carries it (BookingsService.prepare adds it).
  }

  /**
   * In the caller's transaction (ContainerBookingHandler): under the container's lock, still open
   * and with room, the prepared booking is recorded, confirmed (its shipment is created) and the
   * shipment put in the container. A container that closed or filled up meanwhile refuses, and
   * the caller's transaction leaves nothing behind.
   */
  async bookInTx(tx: Tx, user: AuthUser, id: string, prepared: PreparedBooking): Promise<string> {
    const container = await lockContainer(tx, id);
    requireOpen(container);
    await requireRoom(tx, container);
    const bookingId = await this.bookings.insertInTx(tx, user, prepared);
    const shipment = await this.bookings.confirmInTx(tx, user, bookingId);
    const shipmentRow = await tx.shipment.findUniqueOrThrow({
      where: { id: shipment.id },
      select: { number: true },
    });
    await this.addShipments(
      tx,
      user,
      container,
      [shipment.id],
      new Map([[shipment.id, shipmentRow.number]]),
    );
    return bookingId;
  }

  /**
   * The container a booking draft names, for the draft's review screen: the caller has already
   * found the draft in the user's branches. Shown only as this user could read it directly
   * (findViewable); null otherwise or when it no longer exists, so a draft never shows more of a
   * container than its direct read does (Codex on 98f9727).
   */
  async describe(user: AuthUser, id: string): Promise<DraftContainer | null> {
    const container = await this.readableByDraft(user, id);
    if (!container) return null;
    return {
      id: container.id,
      number: container.number,
      status: container.status,
      containerTypeCode: container.containerTypeCode,
      containerNumber: container.containerNumber,
      etd: fromDbDateOrNull(container.etd),
    };
  }

  /**
   * Takes a shipment out of an open container (the container's branch only); it can go in another
   * one. A shipment shared with the container's branch for it stays shared.
   */
  async removeShipment(user: AuthUser, id: string, shipmentId: string): Promise<ConsolidationDto> {
    await this.findOwn(user, id);
    await this.prisma.$transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      requireOpen(container);
      await takeOut(tx, id, shipmentId);
    });
    return this.get(user, id);
  }

  /**
   * Moves a shipment from one open container to another, both of the user's branches (the branch
   * that loads it decides), in one transaction: locks the two containers in id order, then the
   * shipment. Returns the container it left.
   */
  async moveShipment(
    user: AuthUser,
    id: string,
    shipmentId: string,
    targetId: string,
  ): Promise<ConsolidationDto> {
    if (targetId === id) {
      throw codedRefusal(
        HttpStatus.BAD_REQUEST,
        'SAME_CONTAINER',
        'The shipment is already in this container',
      );
    }
    await this.findOwn(user, id);
    await this.findOwn(user, targetId);
    const numbers = await this.requireVisibleShipments(user, [shipmentId]);
    await this.prisma.$transaction(async (tx) => {
      const locked = new Map<string, Consolidation>();
      for (const containerId of [id, targetId].sort()) {
        locked.set(containerId, await lockContainer(tx, containerId));
      }
      const source = locked.get(id);
      const target = locked.get(targetId);
      if (!source || !target) throw new Error('Both containers are locked');
      requireOpen(source);
      requireOpen(target);
      await requireRoom(tx, target);
      await takeOut(tx, id, shipmentId);
      await this.addShipments(tx, user, target, [shipmentId], numbers, { moving: true });
    });
    return this.get(user, id);
  }

  /** Closes, loads, departs, arrives or unpacks the container (see the class comment). */
  async move(
    user: AuthUser,
    id: string,
    input: ConsolidationMoveRequest,
  ): Promise<ConsolidationDto> {
    const existing = await this.findOwn(user, id);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException('The time of a container change cannot be in the future');
    }
    const numbers = await this.shipmentNumbers(user, existing);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: existing.branchId },
      select: { timezone: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      if (!consolidationMoves(container.status).includes(input.status)) {
        throw new ConflictException(
          `A ${container.status} container cannot be marked ${input.status}`,
        );
      }
      const previous = lastChange(container);
      if (previous && occurredAt < previous) {
        throw new BadRequestException('A container change cannot be dated before the one before');
      }
      const links = await tx.consolidationShipment.findMany({
        where: { consolidationId: id },
        select: { shipmentId: true },
      });
      const shipmentIds = links.map((l) => l.shipmentId).sort();
      const data: Prisma.ConsolidationUncheckedUpdateManyInput = { status: input.status };
      if (input.status === 'CLOSED') {
        if (shipmentIds.length === 0) {
          throw new ConflictException('An empty container cannot be closed');
        }
        if (!container.containerNumber) {
          throw new BadRequestException('Enter the container number before closing it');
        }
        await this.freezeBasis(tx, container, shipmentIds, numbers);
        data.closedAt = occurredAt;
      }
      const target = shipmentStatusFor(input.status);
      if (target) {
        // Closing, loading and departing happen at the port of loading; arriving at discharge.
        const at =
          input.status === 'ARRIVED' ? container.destinationLocationId : container.originLocationId;
        await this.moveShipments(tx, user, container, shipmentIds, target, occurredAt, at, numbers);
      }
      if (input.status === 'LOADED') data.loadedAt = occurredAt;
      if (input.status === 'DEPARTED') data.departedAt = occurredAt;
      if (input.status === 'ARRIVED') data.arrivedAt = occurredAt;
      if (input.status === 'DECONSOLIDATED') data.deconsolidatedAt = occurredAt;
      // Compare-and-set on top of the row lock: the update applies only from the status read.
      const { count } = await tx.consolidation.updateMany({
        where: { id, status: container.status },
        data,
      });
      if (count !== 1) throw new ConflictException('The container changed meanwhile');
      if (input.status === 'CLOSED') {
        await this.costs.get().allocatePendingInTx(tx, user, {
          id,
          number: container.number,
          branchId: container.branchId,
          closedOn: todayIn(branch.timezone, occurredAt),
          shipments: await sharesBasisInTx(tx, id),
        });
      }
    });
    return this.get(user, id);
  }

  /** Cancels an open container nothing has been billed to. Its shipments are left as they are. */
  async cancel(user: AuthUser, id: string, reason: string): Promise<ConsolidationDto> {
    await this.findOwn(user, id);
    await this.prisma.$transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      if (!isOpen(container.status)) {
        throw new ConflictException('Only an open container can be cancelled');
      }
      if ((await this.costs.get().approvedCostCountInTx(tx, id)) > 0) {
        throw new ConflictException('Cancel the supplier bills charging this container first');
      }
      const { count } = await tx.consolidation.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
      });
      if (count !== 1) throw new ConflictException('The container changed meanwhile');
    });
    return this.get(user, id);
  }

  // -------------------------------------------------------------------------------------------
  // For supplier bills (payables)

  /**
   * A container a bill line may charge: visible to the user and not cancelled. 404 / 400.
   */
  async requireBillable(
    user: AuthUser,
    id: string,
  ): Promise<{ id: string; number: string; branchId: string }> {
    const container = await this.prisma.consolidation.findFirst({
      where: { id, ...branchScope(user) },
      select: { id: true, number: true, branchId: true, status: true },
    });
    if (!container) throw new NotFoundException('Container not found');
    if (!takesCosts(container.status)) {
      throw new BadRequestException(`Container ${container.number} is cancelled`);
    }
    return container;
  }

  /**
   * Inside a bill's approval or cancellation: share-locks the containers (in id order, before any
   * shipment lock) and returns them, with `closed` set for those already closed (their frozen
   * shares). 400 when one was cancelled meanwhile and `forApproval` is set.
   */
  async lockForCostsInTx(
    tx: Tx,
    ids: readonly string[],
    options: { forApproval: boolean },
  ): Promise<Map<string, ContainerForCosts>> {
    const result = new Map<string, ContainerForCosts>();
    for (const id of [...new Set(ids)].sort()) {
      await tx.$queryRaw`SELECT 1 FROM "consolidations" WHERE "id" = ${id}::uuid FOR SHARE`;
      const container = await tx.consolidation.findUniqueOrThrow({
        where: { id },
        include: { branch: { select: { timezone: true } } },
      });
      if (options.forApproval && !takesCosts(container.status)) {
        throw new BadRequestException(`Container ${container.number} is cancelled`);
      }
      const base = { id, number: container.number, branchId: container.branchId };
      result.set(id, {
        ...base,
        closed:
          isClosed(container.status) && container.closedAt
            ? {
                ...base,
                closedOn: todayIn(container.branch.timezone, container.closedAt),
                shipments: await sharesBasisInTx(tx, id),
              }
            : null,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------

  /**
   * The container as the user may see it: whole (`own`) when it is of one of their branches; else,
   * with their own shipments only, while it is open and they may book into it, or once it holds a
   * shipment they can see. 404 otherwise.
   */
  private async findViewable(
    user: AuthUser,
    id: string,
  ): Promise<{ container: ContainerWithDetails; own: boolean }> {
    const container = await this.prisma.consolidation.findUnique({
      where: { id },
      include: detailInclude,
    });
    if (!container) throw new NotFoundException('Container not found');
    if (canAccessBranch(user, container.branchId)) return { container, own: true };
    if (isOpen(container.status) && canBookInto(user)) return { container, own: false };
    const theirs = await this.prisma.consolidationShipment.count({
      where: { consolidationId: id, shipment: shipmentScope(user) },
    });
    if (theirs > 0) return { container, own: false };
    throw new NotFoundException('Container not found');
  }

  /** For what only the container's branch does (edit, move, cancel, take out): 403 for others. */
  private async findOwn(user: AuthUser, id: string): Promise<ContainerWithDetails> {
    const { container, own } = await this.findViewable(user, id);
    if (!own) {
      throw codedRefusal(
        HttpStatus.FORBIDDEN,
        'CONTAINER_BRANCH_ONLY',
        `Only the branch of container ${container.number} changes it or takes shipments out`,
        { container: container.number },
      );
    }
    return container;
  }

  /** A sea container sails between active ports. */
  private async requirePorts(originId: string, destinationId: string): Promise<void> {
    await this.masterData.requireRoute(originId, destinationId);
    const [origin, destination] = await Promise.all([
      this.masterData.requireLocation(originId),
      this.masterData.requireLocation(destinationId),
    ]);
    if (origin.kind !== 'PORT' || destination.kind !== 'PORT') {
      throw new BadRequestException('A container goes from a port to a port');
    }
  }

  /** Shipment numbers by id; 404 when the user cannot see one of them. */
  private async requireVisibleShipments(
    user: AuthUser,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const found = await this.shipments.tripSummaries(user, ids);
    if (found.length !== ids.length) throw new NotFoundException('Shipment not found');
    return new Map(found.map((s) => [s.id, s.number]));
  }

  private async shipmentNumbers(
    user: AuthUser,
    container: ContainerWithDetails,
  ): Promise<Map<string, string>> {
    const found = await this.shipments.tripSummaries(
      user,
      container.shipments.map((l) => l.shipmentId),
    );
    return new Map(found.map((s) => [s.id, s.number]));
  }

  /** Exclusive locks on the container's shipments, in id order; returns their ids. */
  private async lockShipments(tx: Tx, id: string): Promise<string[]> {
    const links = await tx.consolidationShipment.findMany({
      where: { consolidationId: id },
      select: { shipmentId: true },
    });
    const ids = links.map((l) => l.shipmentId).sort();
    for (const shipmentId of ids) {
      await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
    }
    return ids;
  }

  /**
   * Links shipments to the open container, each under its lock in id order: an active LCL sea
   * shipment NOLON carries, not yet on the sea leg, and in no other container. The container's
   * voyage is copied to them.
   *
   * Branches: a user of another branch than the container's adds only shipments of their own
   * branches. A shipment the container's branch does not see yet is shared with it, as it loads
   * the shipment, when the user works in the shipment's own branch or moves it from another
   * container of theirs (`moving`); the shipment stays its branch's.
   */
  private async addShipments(
    tx: Tx,
    user: AuthUser,
    container: Consolidation,
    shipmentIds: readonly string[],
    numbers: ReadonlyMap<string, string>,
    options: { moving?: boolean } = {},
  ): Promise<void> {
    for (const shipmentId of [...shipmentIds].sort()) {
      const label = numbers.get(shipmentId) ?? shipmentId;
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (!isActive(status) || !BEFORE_CONSOLIDATION.includes(status)) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'SHIPMENT_PAST_LOADING',
          `Shipment ${label} is ${status} and cannot be consolidated`,
          { shipment: label },
        );
      }
      const shape = await this.shipments.shapeInTx(tx, shipmentId);
      if (!stageApplies('CONSOLIDATED', shape)) {
        throw codedRefusal(
          HttpStatus.BAD_REQUEST,
          'SHIPMENT_NOT_LCL_SEA',
          `Shipment ${label} is not an LCL sea shipment NOLON carries`,
          { shipment: label },
        );
      }
      // The same port rule as a booking made for the container (requireBookable).
      if (shape.originLocationId !== container.originLocationId) {
        throw codedRefusal(
          HttpStatus.BAD_REQUEST,
          'SHIPMENT_OTHER_PORT',
          `Container ${container.number} loads at another port than shipment ${label} leaves from`,
          { shipment: label, container: container.number },
        );
      }
      const shipment = await this.shipments.branchAndLastEventInTx(tx, shipmentId);
      const ownsShipment = canAccessBranch(user, shipment.branchId);
      const ownsContainer = canAccessBranch(user, container.branchId);
      const shared = shipmentBranches(shipment).includes(container.branchId);
      if ((!ownsContainer && !ownsShipment) || (!shared && !ownsShipment && !options.moving)) {
        throw codedRefusal(
          HttpStatus.BAD_REQUEST,
          'SHIPMENT_OTHER_BRANCH',
          `Shipment ${label} belongs to another branch than the container`,
          { shipment: label },
        );
      }
      const other = await tx.consolidationShipment.findFirst({
        where: { shipmentId, consolidation: { status: { not: 'CANCELLED' } } },
        select: { consolidation: { select: { number: true } } },
      });
      if (other) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'SHIPMENT_IN_OTHER_CONTAINER',
          `Shipment ${label} is already in container ${other.consolidation.number}`,
          { shipment: label, container: other.consolidation.number },
        );
      }
      if (!shared) await this.shipments.shareWithBranchInTx(tx, shipmentId, container.branchId);
      await tx.consolidationShipment.create({
        data: { consolidationId: container.id, shipmentId, branchId: container.branchId },
      });
    }
    await this.shipments.setVoyageInTx(tx, shipmentIds, knownVoyage(container));
  }

  /**
   * Closing: each shipment's CBM or weight (the container's basis) is frozen as its share of the
   * container's costs. 400 naming the shipments that have none.
   */
  private async freezeBasis(
    tx: Tx,
    container: Consolidation,
    shipmentIds: readonly string[],
    numbers: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const id of shipmentIds) {
      await this.shipments.lockForChildWrite(tx, id, { exclusive: true });
    }
    const measures = await this.shipments.cargoMeasuresInTx(tx, shipmentIds);
    const missing: string[] = [];
    for (const shipment of measures) {
      const value = basisValueOf(container.basis, shipment.items);
      if (!value) {
        missing.push(numbers.get(shipment.id) ?? shipment.id);
        continue;
      }
      await tx.consolidationShipment.update({
        where: {
          consolidationId_shipmentId: { consolidationId: container.id, shipmentId: shipment.id },
        },
        data: { basisValue: value },
      });
    }
    if (missing.length > 0) {
      const what = container.basis === 'CBM' ? 'volume (CBM)' : 'weight';
      throw new BadRequestException(
        `Enter the ${what} of the cargo of: ${missing.join(', ')}. The container's cost is ` +
          'shared by it',
      );
    }
  }

  /**
   * Moves every shipment in the container to `target` through the state machine, in id order
   * under each shipment's lock (see the class comment). 400 when the move is dated before a moved
   * shipment's latest event; 409 naming every shipment that cannot take it.
   */
  private async moveShipments(
    tx: Tx,
    user: AuthUser,
    container: Consolidation,
    shipmentIds: readonly string[],
    target: ShipmentStatus,
    occurredAt: Date,
    locationId: string,
    numbers: ReadonlyMap<string, string>,
  ): Promise<void> {
    const blocked: string[] = [];
    for (const shipmentId of shipmentIds) {
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (atOrPastOnSeaLeg(status, target)) continue;
      const { lastEventAt } = await this.shipments.branchAndLastEventInTx(tx, shipmentId);
      if (lastEventAt && occurredAt < lastEventAt) {
        throw new BadRequestException(
          `Shipment ${numbers.get(shipmentId) ?? shipmentId} has events after that time: ` +
            `the container change cannot be dated before ${lastEventAt.toISOString()}`,
        );
      }
      const moved = await this.shipments.advanceInTx(tx, user, shipmentId, target, {
        occurredAt,
        note: container.number,
        locationId,
      });
      if (!moved) blocked.push(`${numbers.get(shipmentId) ?? shipmentId} (${status})`);
    }
    if (blocked.length > 0) {
      throw new ConflictException(
        `These shipments cannot move to ${target}: ${blocked.join(', ')}. Resolve them first`,
      );
    }
  }

  private async toDto(
    user: AuthUser,
    c: ContainerWithDetails,
    own: boolean,
  ): Promise<ConsolidationDto> {
    const has = (permission: Permission) => user.permissions.has(permission);
    // Another branch sees its own shipments (tripSummaries is scoped) and no costs.
    const showsCost = own && seesConsolidationCosts(has);
    const shipmentIds = c.shipments.map((l) => l.shipmentId);
    const [summaries, view] = await Promise.all([
      this.shipments.tripSummaries(user, shipmentIds),
      showsCost ? this.costs.get().view(c.id) : Promise.resolve(null),
    ]);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    const shipments: ConsolidationShipmentDto[] = [];
    for (const link of c.shipments) {
      const s = byId.get(link.shipmentId);
      if (!s) continue;
      const total = (values: (Decimal | null)[]) => {
        const present = values.filter((v): v is Decimal => v !== null);
        return present.length === 0
          ? null
          : toDecimalString(present.reduce((acc, v) => acc.plus(v), ZERO));
      };
      shipments.push({
        shipmentId: link.shipmentId,
        shipmentNumber: s.number,
        customerName: s.customerName,
        status: s.status,
        destinationLocationId: s.destinationLocationId,
        packages: s.items.reduce((sum, i) => sum + i.quantity, 0),
        weightKg: total(s.items.map((i) => i.weightKg)),
        volumeCbm: total(s.items.map((i) => i.volumeCbm)),
        basisValue: link.basisValue ? toDecimalString(link.basisValue) : null,
        allocatedUsd: view ? toDecimalString(view.allocatedUsd.get(link.shipmentId) ?? ZERO) : null,
      });
    }
    return {
      ...toSummary(c),
      sealNumber: c.sealNumber,
      carrierName: c.carrierName,
      voyageNumber: c.voyageNumber,
      masterBlNumber: c.masterBlNumber,
      basis: c.basis,
      notes: c.notes,
      closedAt: c.closedAt?.toISOString() ?? null,
      loadedAt: c.loadedAt?.toISOString() ?? null,
      departedAt: c.departedAt?.toISOString() ?? null,
      arrivedAt: c.arrivedAt?.toISOString() ?? null,
      deconsolidatedAt: c.deconsolidatedAt?.toISOString() ?? null,
      cancelledAt: c.cancelledAt?.toISOString() ?? null,
      cancelReason: c.cancelReason,
      createdByName: c.createdBy.fullName,
      shipments,
      showsCost,
      costs: view?.costs ?? [],
      clearingBalanceUsd: view ? toDecimalString(view.clearingBalanceUsd) : null,
      ownBranch: own,
      actions: {
        canEdit: own && has('consolidation:update') && isEditable(c.status),
        canAddShipments: has('consolidation:update') && isOpen(c.status),
        canEditShipments: own && has('consolidation:update') && isOpen(c.status),
        canAddBooking: canBookInto(user) && isOpen(c.status),
        moves: own && has('consolidation:update') ? [...consolidationMoves(c.status)] : [],
        canCancel: own && has('consolidation:cancel') && isOpen(c.status),
      },
    };
  }
}

/** 409 unless the container (locked or as read) is still open. */
function requireOpen(c: Consolidation): void {
  if (!isOpen(c.status)) {
    throw codedRefusal(
      HttpStatus.CONFLICT,
      'CONTAINER_NOT_OPEN',
      `Container ${c.number} is no longer open: its shipments are fixed`,
      { container: c.number },
    );
  }
}

/** 409 when the locked container already holds MAX_CONTAINER_SHIPMENTS. */
async function requireRoom(tx: Tx, c: Consolidation): Promise<void> {
  const count = await tx.consolidationShipment.count({ where: { consolidationId: c.id } });
  if (count >= MAX_CONTAINER_SHIPMENTS) throw full(c);
}

function full(c: Pick<Consolidation, 'number'>): Error {
  return codedRefusal(
    HttpStatus.CONFLICT,
    'CONTAINER_FULL',
    `A container holds at most ${MAX_CONTAINER_SHIPMENTS} shipments`,
    { container: c.number },
  );
}

/** Unlinks the shipment from the locked container; 404 when it is not in it. */
async function takeOut(tx: Tx, id: string, shipmentId: string): Promise<void> {
  const { count } = await tx.consolidationShipment.deleteMany({
    where: { consolidationId: id, shipmentId },
  });
  if (count === 0) throw new NotFoundException('The shipment is not in this container');
}

/** Row lock on the container, then the row as it is under the lock. */
async function lockContainer(tx: Tx, id: string): Promise<Consolidation> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "consolidations" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('Container not found');
  return tx.consolidation.findUniqueOrThrow({ where: { id } });
}

/** The shipments of a closed container and the basis values frozen at the close. */
async function sharesBasisInTx(
  tx: Tx,
  id: string,
): Promise<{ shipmentId: string; basisValue: Decimal }[]> {
  const links = await tx.consolidationShipment.findMany({
    where: { consolidationId: id },
    select: { shipmentId: true, basisValue: true },
    orderBy: { shipmentId: 'asc' },
  });
  return links.map((l) => {
    if (!l.basisValue) throw new Error('A closed container has a basis for every shipment');
    return { shipmentId: l.shipmentId, basisValue: l.basisValue };
  });
}

function lastChange(c: Consolidation): Date | null {
  return c.arrivedAt ?? c.departedAt ?? c.loadedAt ?? c.closedAt ?? null;
}

const VOYAGE_FIELDS = ['carrierName', 'vesselName', 'voyageNumber', 'etd', 'eta'] as const;
type Voyage = Partial<Pick<Consolidation, (typeof VOYAGE_FIELDS)[number]>>;

/** The container's voyage fields the edit sent, with their new values (null when cleared). */
function sentVoyage(input: ConsolidationUpdateRequest, c: Consolidation): Voyage {
  const voyage: Voyage = {};
  for (const field of VOYAGE_FIELDS) {
    if (input[field] !== undefined) Object.assign(voyage, { [field]: c[field] });
  }
  return voyage;
}

/** The container's voyage fields that are known: a shipment joining keeps its own for the rest. */
function knownVoyage(c: Consolidation): Voyage {
  const voyage: Voyage = {};
  for (const field of VOYAGE_FIELDS) {
    if (c[field] !== null) Object.assign(voyage, { [field]: c[field] });
  }
  return voyage;
}

function checkDates(etd: string | null, eta: string | null): void {
  if (etd && eta && eta < etd) {
    throw new BadRequestException('The ETA cannot be before the ETD');
  }
}

function toSummary(c: ContainerWithSummary): ConsolidationSummaryDto {
  return {
    id: c.id,
    number: c.number,
    branchId: c.branchId,
    status: c.status,
    originLocationId: c.originLocationId,
    destinationLocationId: c.destinationLocationId,
    containerTypeCode: c.containerTypeCode,
    containerNumber: c.containerNumber,
    vesselName: c.vesselName,
    etd: fromDbDateOrNull(c.etd),
    eta: fromDbDateOrNull(c.eta),
    shipmentCount: c._count.shipments,
  };
}
