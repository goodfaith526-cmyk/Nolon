import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BookingService,
  LoadType,
  Page,
  Permission,
  ShipmentActionsDto,
  ShipmentContainerInput,
  ShipmentDto,
  ShipmentEventKind,
  ShipmentStatus,
  ShipmentStatusRequest,
  ShipmentSummaryDto,
  ShipmentUpdateRequest,
  ShippingMode,
} from '@nolon/shared';
import QRCode from 'qrcode';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope, canAccessBranch } from '../auth/branch-scope.js';
import { lockActiveBranches } from '../common/branch-locks.js';
import { shipmentScope } from './shipment-scope.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';
import { BookingLifecycleService } from '../bookings/booking-lifecycle.service.js';
import { fromDbDateOrNull, toDbDate, todayIn } from '../common/dates.js';
import { dateRange, localDayFilter } from '../common/list-filters.js';
import { toDecimalStringOrNull } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { PageQuery } from '../common/validation.js';
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
  visitedStatuses,
} from './state-machine.js';

export interface ShipmentFilters extends PageQuery {
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

const branchRef = { select: { id: true, code: true, nameEn: true, nameAr: true } };

const details = {
  customer: { select: { name: true } },
  booking: { select: { number: true } },
  sharedBranches: { ...sharedBranchesSelect, select: { branchId: true, branch: branchRef } },
  items: { orderBy: { lineNo: 'asc' } },
  containers: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: { id: 'asc' }, include: { user: { select: { fullName: true } } } },
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
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async list(user: AuthUser, filters: ShipmentFilters): Promise<Page<ShipmentSummaryDto>> {
    const { branchId, from, to } = filters;
    if (branchId) assertBranchAccess(user, branchId);
    const created = await localDayFilter(this.prisma, 'createdAt', from, to);
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
      eta: dateRange(filters.etaFrom, filters.etaTo),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { blNumber: { contains: filters.q, mode: 'insensitive' } },
              { customer: { name: { contains: filters.q, mode: 'insensitive' } } },
              { containers: { some: { containerNumber: { contains: filters.q.toUpperCase() } } } },
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
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<ShipmentDto> {
    const shipment = await this.findScoped(user, id);
    const dto = this.toDto(user, shipment);
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
  }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, ...this.scope(user) },
      select: { id: true, branchId: true, status: true, sharedBranches: sharedBranchesSelect },
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
    status: ShipmentStatus;
    packages: number;
    transitions: ShipmentStatus[];
  }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, ...this.scope(user) },
      include: {
        items: { select: { quantity: true } },
        events: { orderBy: { id: 'asc' } },
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    const has = (permission: Permission) => user.permissions.has(permission);
    return {
      id: shipment.id,
      branchId: shipment.branchId,
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
   * customer, parties, route, services and cargo lines are copied from the booking.
   */
  async createForBooking(tx: Tx, user: AuthUser, bookingId: string): Promise<{ id: string }> {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { items: { orderBy: { lineNo: 'asc' } }, branch: { select: { timezone: true } } },
    });
    const year = todayIn(booking.branch.timezone).slice(0, 4);
    const number = formatDocumentNumber('SHP', await nextSequenceValue(tx, 'SHIPMENT', year), year);
    const now = new Date();
    return tx.shipment.create({
      data: {
        number,
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
    await this.applyEvent(user, id, (shipment, path) => {
      if (!nextStatuses(shipment.status, shipment, visitedStatuses(path)).includes(input.status)) {
        throw new ConflictException(`Cannot move from ${shipment.status} to ${input.status}`);
      }
      requireAny(user, permissionForTransition(input.status));
      return {
        kind: 'STATUS',
        status: input.status,
        occurredAt,
        locationId: input.locationId ?? null,
        note: input.note ?? null,
        update: {
          status: input.status,
          ...(input.status === 'CLOSED' ? { closedAt: new Date() } : {}),
        },
        after:
          input.status === 'CLOSED'
            ? (tx) => this.bookingLifecycle.completeForShipment(tx, shipment.bookingId)
            : undefined,
      };
    });
    return this.get(user, id);
  }

  async hold(
    user: AuthUser,
    id: string,
    reason: string,
    note: string | null,
  ): Promise<ShipmentDto> {
    await this.findScoped(user, id);
    await this.applyEvent(user, id, (shipment) => {
      requireAny(user, ['shipments:update']);
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
      requireAny(user, ['shipments:update']);
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
  async revert(user: AuthUser, id: string, reason: string): Promise<ShipmentDto> {
    await this.findScoped(user, id);
    await this.applyEvent(user, id, (shipment, path) => {
      requireAny(user, ['shipments:approve']);
      const target = revertTarget(path);
      if (!target) throw new ConflictException('There is no earlier status to go back to');
      const remaining = path.slice(0, -1);
      return {
        kind: 'REVERT',
        status: target,
        reason,
        update: {
          status: target,
          currentLocationId: remaining.findLast((entry) => entry.locationId)?.locationId ?? null,
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
    options: { occurredAt: Date; note: string | null; locationId?: string | null },
  ): Promise<boolean> {
    return this.applyEventInTx(tx, user, id, (shipment, path) => {
      if (!nextStatuses(shipment.status, shipment, visitedStatuses(path)).includes(status)) {
        return null;
      }
      requireAny(user, permissionForTransition(status));
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
  ): Promise<{ mode: ShippingMode; loadType: LoadType | null; services: BookingService[] }> {
    return tx.shipment.findUniqueOrThrow({
      where: { id },
      select: { mode: true, loadType: true, services: true },
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
   * For inland transport: the shipments among `ids` the user may see, with what a trip shows of
   * them (number, customer, status, destination, packages, weight and volume of the cargo lines).
   */
  async tripSummaries(
    user: AuthUser,
    ids: readonly string[],
  ): Promise<
    {
      id: string;
      number: string;
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
    requireAny(user, [permission]);
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
      after: (tx) => this.bookingLifecycle.cancelForShipment(tx, shipment.bookingId, reason),
    };
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
      include: { events: { orderBy: { id: 'asc' } } },
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
      })),
      sharedBranches: s.sharedBranches.map((b) => b.branch),
      shareableBranches: [],
      actions: actionsFor(user, s, path),
    };
  }
}

type LockedShipment = Prisma.ShipmentGetPayload<{ include: { events: true } }>;

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

function requireAny(user: AuthUser, permissions: readonly Permission[]): void {
  if (!permissions.some((p) => user.permissions.has(p))) {
    throw new ForbiddenException('Missing permission');
  }
}

function isLateCanceller(user: AuthUser): boolean {
  return user.roles.some((role) => (LATE_CANCEL_ROLES as readonly string[]).includes(role));
}

function actionsFor(
  user: AuthUser,
  s: ShipmentWithDetails,
  path: HistoryEntry[],
): ShipmentActionsDto {
  const has = (permission: Permission) => user.permissions.has(permission);
  const canUpdate = has('shipments:update');
  return {
    transitions: nextStatuses(s.status, s, visitedStatuses(path)).filter((next) =>
      permissionForTransition(next).some(has),
    ),
    canHold: canUpdate && canHold(s.status),
    canResume: canUpdate && s.status === 'ON_HOLD',
    revertTo: has('shipments:approve') ? revertTarget(path) : null,
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
