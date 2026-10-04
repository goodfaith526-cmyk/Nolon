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
} from '@nolon/shared';
import QRCode from 'qrcode';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';
import { BookingLifecycleService } from '../bookings/booking-lifecycle.service.js';
import { fromDbDateOrNull, toDbDate, todayIn } from '../common/dates.js';
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
  status?: ShipmentStatus;
  customerId?: string;
}

type Tx = Prisma.TransactionClient;

const details = {
  customer: { select: { name: true } },
  booking: { select: { number: true } },
  items: { orderBy: { lineNo: 'asc' } },
  containers: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: { id: 'asc' }, include: { user: { select: { fullName: true } } } },
} satisfies Prisma.ShipmentInclude;

type ShipmentWithDetails = Prisma.ShipmentGetPayload<{ include: typeof details }>;

const summary = {
  customer: { select: { name: true } },
  booking: { select: { number: true } },
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
    const where: Prisma.ShipmentWhereInput = {
      ...this.scope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
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
    return this.toDto(user, await this.findScoped(user, id));
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

  /** For other modules (documents): 404 unless the user may see the shipment. */
  async requireAccessible(
    user: AuthUser,
    id: string,
  ): Promise<{ id: string; branchId: string; status: ShipmentStatus }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, ...this.scope(user) },
      select: { id: true, branchId: true, status: true },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    return shipment;
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
   * change is not allowed), then updates the shipment and records the event. Concurrent changes
   * to the same shipment queue on the lock and each sees the result of the one before.
   */
  private async applyEventInTx(tx: Tx, user: AuthUser, id: string, plan: Planner): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id },
      include: { events: { orderBy: { id: 'asc' } } },
    });
    const path = replayHistory(shipment.events);
    const event = plan(shipment, path);
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
  }

  /**
   * For other modules writing under a shipment (documents): takes a share lock on the shipment
   * row inside the caller's transaction and returns its status. Status changes take the row lock
   * exclusively, so a cancel either commits first and is seen here, or waits for this write.
   */
  async lockForChildWrite(tx: Tx, id: string): Promise<ShipmentStatus> {
    const rows = await tx.$queryRaw<{ status: ShipmentStatus }[]>`
      SELECT "status"::text AS "status" FROM "shipments" WHERE "id" = ${id}::uuid FOR SHARE`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Shipment not found');
    return row.status;
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

  private scope(user: AuthUser): Prisma.ShipmentWhereInput {
    // A Driver sees only shipments on their own trips; trips arrive with inland transport
    // (group 5), so until then a Driver-only user sees none.
    if (limitedToOwnTrips(user, 'shipments')) return { id: { in: [] } };
    return branchScope(user);
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
