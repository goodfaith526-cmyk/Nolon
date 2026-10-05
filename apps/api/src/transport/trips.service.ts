import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Page,
  Permission,
  ShipmentStatus,
  ShipmentTripDto,
  TripDto,
  TripInput,
  TripMoveRequest,
  TripShipmentDto,
  TripStatus,
  TripSummaryDto,
} from '@nolon/shared';
import { seesTransportCosts } from '@nolon/shared';
import { AccountsService } from '../accounting/accounts.service.js';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, canAccessBranch } from '../auth/branch-scope.js';
import { fromDbDate, todayIn } from '../common/dates.js';
import {
  type Decimal,
  ZERO,
  dec,
  toDecimalString,
  toDecimalStringOrNull,
} from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive } from '../shipments/state-machine.js';
import { FleetService } from './fleet.service.js';
import { TripCostsService } from './trip-costs.service.js';
import { forbidDriverOnly, isDriverOnly, lockTrip, tripScope } from './trip-scope.js';
import { shipmentBranches } from '../shipments/shipment-scope.js';
import {
  OPEN_TRIP_STATUSES,
  SCHEDULED_STATUS,
  atOrPastOnLeg,
  isPlanned,
  shipmentStatusFor,
  takesExpenses,
  tripMoves,
  tripTakesPod,
} from './transport-rules.js';

type Tx = Prisma.TransactionClient;

/** The fields that differ between an own and an external trip. */
interface KindFields {
  vehicleId?: string;
  driverId?: string;
  carrierId?: string;
  agreedCost?: Decimal;
  currency?: string;
  externalVehicle?: string | null;
  externalDriver?: string | null;
}

export interface TripFilters extends PageQuery {
  status?: TripStatus;
}

const summaryInclude = {
  vehicle: { select: { plateNumber: true } },
  driver: { select: { name: true } },
  carrier: { select: { name: true } },
  _count: { select: { shipments: true } },
} satisfies Prisma.TripInclude;

type TripWithSummary = Prisma.TripGetPayload<{ include: typeof summaryInclude }>;

const detailInclude = {
  ...summaryInclude,
  createdBy: { select: { fullName: true } },
  accrualEntry: { select: { number: true } },
  shipments: { select: { shipmentId: true }, orderBy: { addedAt: 'asc' } },
  expenses: {
    include: {
      cashAccount: { select: { code: true } },
      journalEntry: { select: { number: true } },
      createdBy: { select: { fullName: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.TripInclude;

type TripWithDetails = Prisma.TripGetPayload<{ include: typeof detailInclude }>;

/** A trip change may be recorded after the fact, but not ahead of the clock (small skew ok). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** At most this many shipments on one trip. */
export const MAX_TRIP_SHIPMENTS = 100;

/**
 * Trips (scope 12): a branch's own vehicle and driver, or a hired carrier, carrying one or more
 * shipments on one road leg. The trip status drives its shipments' road statuses (annex B,
 * statuses 9-12) through the shipment state machine, in the same transaction:
 * - putting a shipment on a trip moves it to TRIP_SCHEDULED,
 * - departing moves every shipment to ROAD_DEPARTED, arriving to ROAD_ARRIVED.
 * A shipment already at the target status or beyond it on this leg (moved by hand on the shipment
 * page, or delivered) is left as it is. A trip carries shipments its branch owns or shares, and
 * a move is never dated before the trip was planned or before a moved shipment's latest event.
 * When any shipment cannot take the move now (on hold, cancelled, at another stage), the trip
 * change is refused with 409 naming them, and nothing is applied: the trip waits until those
 * shipments are sorted out or taken off the trip (while it is planned). Completing an external
 * trip accrues its agreed cost (annex C rule 11) in the same transaction.
 *
 * Locks: the trip row first (lockTrip), then each shipment exclusively in id order. Every status
 * change re-reads the trip under its lock, so two concurrent changes run one after the other and
 * the second is refused when the first already made it. A new trip share-locks its vehicle,
 * driver, carrier and currency before it reads them. While the trip has posted expenses (split
 * over its shipments), its shipments are fixed.
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly fleet: FleetService,
    private readonly masterData: MasterDataService,
    private readonly currencies: CurrenciesService,
    private readonly costs: TripCostsService,
    private readonly accounts: AccountsService,
    private readonly autoJournal: AutoJournalService,
  ) {}

  async list(user: AuthUser, filters: TripFilters): Promise<Page<TripSummaryDto>> {
    const where: Prisma.TripWhereInput = {
      ...tripScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.q ? { number: { contains: filters.q, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.trip.findMany({
        where,
        include: summaryInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.trip.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<TripDto> {
    return this.toDto(user, await this.findScoped(user, id));
  }

  /**
   * The trips (road legs) of a shipment the user can see. 404 unless they can see the shipment.
   * Every leg is part of the shipment's record, so the owning branch also sees a trip of a branch
   * sharing the shipment (and the other way round); a trip outside the user's branches is listed
   * without its costs and cannot be opened. A Driver sees only their own trips.
   */
  async forShipment(user: AuthUser, shipmentId: string): Promise<ShipmentTripDto[]> {
    await this.shipments.requireAccessible(user, shipmentId);
    const trips = await this.prisma.trip.findMany({
      where: {
        ...(isDriverOnly(user) ? tripScope(user) : {}),
        shipments: { some: { shipmentId } },
      },
      include: summaryInclude,
      orderBy: { createdAt: 'asc' },
    });
    return trips.map((trip) => {
      const s = toSummary(trip);
      return {
        id: s.id,
        number: s.number,
        kind: s.kind,
        status: s.status,
        originLocationId: s.originLocationId,
        destinationLocationId: s.destinationLocationId,
        actualDeparture: s.actualDeparture,
        actualArrival: s.actualArrival,
        vehicleLabel: s.vehicleLabel,
        driverLabel: s.driverLabel,
        canOpen: canAccessBranch(user, trip.branchId),
      };
    });
  }

  /**
   * For the open accruals report: the trips among `ids` the user may see, with their branch,
   * carrier and the day they were completed (in the trip's branch).
   */
  async accrualSummaries(
    user: AuthUser,
    ids: readonly string[],
  ): Promise<
    {
      id: string;
      number: string;
      branchCode: string;
      carrierName: string | null;
      completedOn: string | null;
    }[]
  > {
    if (ids.length === 0) return [];
    const trips = await this.prisma.trip.findMany({
      where: { id: { in: [...ids] }, ...tripScope(user) },
      select: {
        id: true,
        number: true,
        completedAt: true,
        branch: { select: { code: true, timezone: true } },
        carrier: { select: { name: true } },
      },
      orderBy: { number: 'asc' },
    });
    return trips.map((t) => ({
      id: t.id,
      number: t.number,
      branchCode: t.branch.code,
      carrierName: t.carrier?.name ?? null,
      completedOn: t.completedAt ? todayIn(t.branch.timezone, t.completedAt) : null,
    }));
  }

  async create(user: AuthUser, input: TripInput): Promise<TripDto> {
    forbidDriverOnly(user, 'plan trips');
    assertBranchAccess(user, input.branchId);
    await this.masterData.requireRoute(input.originLocationId, input.destinationLocationId);
    const plannedDeparture = input.plannedDeparture ? new Date(input.plannedDeparture) : null;
    const plannedArrival = input.plannedArrival ? new Date(input.plannedArrival) : null;
    if (plannedDeparture && plannedArrival && plannedArrival < plannedDeparture) {
      throw new BadRequestException('The planned arrival cannot be before the departure');
    }
    checkKindShape(input);
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
      // Fleet and currency are checked here, under their row locks (see kindFields).
      const kindFields = await this.kindFields(tx, user, input);
      const year = todayIn(branch.timezone).slice(0, 4);
      const number = formatDocumentNumber('TRP', await nextSequenceValue(tx, 'TRIP', year), year);
      const trip = await tx.trip.create({
        data: {
          number,
          branchId: input.branchId,
          kind: input.kind,
          originLocationId: input.originLocationId,
          destinationLocationId: input.destinationLocationId,
          plannedDeparture,
          plannedArrival,
          notes: input.notes ?? null,
          createdById: user.id,
          ...kindFields,
        },
        select: { id: true, number: true, branchId: true },
      });
      await this.scheduleShipments(tx, user, trip, shipmentIds, numbers);
      return trip.id;
    });
    return this.get(user, id);
  }

  /** Puts another shipment on a planned trip (it moves to TRIP_SCHEDULED). */
  async addShipment(user: AuthUser, id: string, shipmentId: string): Promise<TripDto> {
    forbidDriverOnly(user, 'change the shipments of a trip');
    await this.findScoped(user, id);
    const numbers = await this.requireVisibleShipments(user, [shipmentId]);
    await this.prisma.$transaction(async (tx) => {
      const trip = await lockTrip(tx, id);
      if (!isPlanned(trip.status)) {
        throw new ConflictException('Shipments are added only while the trip is planned');
      }
      await requireNoPostedExpenses(tx, id);
      const count = await tx.tripShipment.count({ where: { tripId: id } });
      if (count >= MAX_TRIP_SHIPMENTS) {
        throw new ConflictException(`A trip carries at most ${MAX_TRIP_SHIPMENTS} shipments`);
      }
      const already = await tx.tripShipment.findUnique({
        where: { tripId_shipmentId: { tripId: id, shipmentId } },
      });
      if (already) throw new ConflictException('The shipment is already on this trip');
      await this.scheduleShipments(tx, user, trip, [shipmentId], numbers);
    });
    return this.get(user, id);
  }

  /**
   * Takes a shipment off a planned trip. Its status stays TRIP_SCHEDULED, ready for another trip;
   * going back a status is a separate, recorded revert on the shipment page.
   */
  async removeShipment(user: AuthUser, id: string, shipmentId: string): Promise<TripDto> {
    forbidDriverOnly(user, 'change the shipments of a trip');
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const trip = await lockTrip(tx, id);
      if (!isPlanned(trip.status)) {
        throw new ConflictException('Shipments are removed only while the trip is planned');
      }
      await requireNoPostedExpenses(tx, id);
      const links = await tx.tripShipment.findMany({ where: { tripId: id } });
      if (!links.some((l) => l.shipmentId === shipmentId)) {
        throw new NotFoundException('The shipment is not on this trip');
      }
      if (links.length === 1) {
        throw new ConflictException(
          'A trip carries at least one shipment: cancel the trip instead',
        );
      }
      await tx.tripShipment.delete({ where: { tripId_shipmentId: { tripId: id, shipmentId } } });
    });
    return this.get(user, id);
  }

  /** Departs, arrives or completes the trip, moving its shipments (see the class comment). */
  async move(user: AuthUser, id: string, input: TripMoveRequest): Promise<TripDto> {
    const existing = await this.findScoped(user, id);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException('The time of a trip change cannot be in the future');
    }
    const numbers = await this.shipmentNumbers(user, existing);
    await this.prisma.$transaction(async (tx) => {
      const trip = await lockTrip(tx, id);
      if (!tripMoves(trip.status).includes(input.status)) {
        throw new ConflictException(`A ${trip.status} trip cannot be marked ${input.status}`);
      }
      if (input.status === 'DEPARTED' && occurredAt < trip.createdAt) {
        throw new BadRequestException('The departure cannot be before the trip was planned');
      }
      const shipmentIds = (
        await tx.tripShipment.findMany({ where: { tripId: id }, select: { shipmentId: true } })
      ).map((l) => l.shipmentId);
      const target = shipmentStatusFor(input.status);
      if (target) {
        // Departing, the shipments are at the trip's origin; arriving, at its destination.
        const at = input.status === 'DEPARTED' ? trip.originLocationId : trip.destinationLocationId;
        await this.moveShipments(tx, user, trip, shipmentIds, target, occurredAt, at, numbers);
      }
      const data: Prisma.TripUncheckedUpdateManyInput = { status: input.status };
      switch (input.status) {
        case 'DEPARTED':
          data.actualDeparture = occurredAt;
          break;
        case 'ARRIVED':
          if (trip.actualDeparture && occurredAt < trip.actualDeparture) {
            throw new BadRequestException('The arrival cannot be before the departure');
          }
          data.actualArrival = occurredAt;
          break;
        case 'COMPLETED':
          if (trip.actualArrival && occurredAt < trip.actualArrival) {
            throw new BadRequestException('The completion cannot be before the arrival');
          }
          data.completedAt = occurredAt;
          if (trip.kind === 'EXTERNAL') {
            const entry = await this.costs.accrueInTx(tx, user, trip, shipmentIds, occurredAt);
            data.accrualEntryId = entry.id;
          }
          break;
      }
      // Compare-and-set on top of the row lock: the update applies only from the status read.
      const { count } = await tx.trip.updateMany({ where: { id, status: trip.status }, data });
      if (count !== 1) throw new ConflictException('The trip changed meanwhile');
    });
    return this.get(user, id);
  }

  /**
   * Cancels a planned trip. Its shipments keep TRIP_SCHEDULED and can go on another trip. 409
   * once the trip has left, or while it has expenses that are not cancelled.
   */
  async cancel(user: AuthUser, id: string, reason: string): Promise<TripDto> {
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const trip = await lockTrip(tx, id);
      if (!isPlanned(trip.status)) {
        throw new ConflictException('Only a planned trip can be cancelled');
      }
      const expenses = await tx.tripExpense.count({ where: { tripId: id, status: 'POSTED' } });
      if (expenses > 0) throw new ConflictException('Cancel the trip expenses first');
      const { count } = await tx.trip.updateMany({
        where: { id, status: 'PLANNED' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
      });
      if (count !== 1) throw new ConflictException('The trip changed meanwhile');
    });
    return this.get(user, id);
  }

  // -------------------------------------------------------------------------------------------

  /** 404 unless the user can see the trip. */
  async findScoped(user: AuthUser, id: string): Promise<TripWithDetails> {
    const trip = await this.prisma.trip.findFirst({
      where: { id, ...tripScope(user) },
      include: detailInclude,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  /**
   * The own or external fields of a new trip, checked against the fleet master data inside the
   * trip's transaction: each vehicle, driver, carrier and currency row is share-locked, then read
   * and checked, so a concurrent deactivation either commits first and is refused here (400), or
   * waits until the trip is saved. The shape was checked before (checkKindShape).
   */
  private async kindFields(tx: Tx, user: AuthUser, input: TripInput): Promise<KindFields> {
    if (input.kind === 'OWN' && input.vehicleId && input.driverId) {
      await this.fleet.requireVehicleForTrip(tx, user, input.vehicleId, input.branchId);
      await this.fleet.requireDriverForTrip(tx, user, input.driverId, input.branchId);
      return { vehicleId: input.vehicleId, driverId: input.driverId };
    }
    if (input.kind !== 'EXTERNAL' || !input.carrierId || !input.agreedCost || !input.currency) {
      throw new BadRequestException('An external trip needs a carrier, agreed cost and currency');
    }
    await this.fleet.requireCarrierForTrip(tx, input.carrierId);
    const currency = await this.currencies.requireActiveInTx(tx, input.currency);
    const agreedCost = dec(input.agreedCost);
    if (!agreedCost.gt(0) || !agreedCost.eq(agreedCost.toDecimalPlaces(currency.decimalPlaces))) {
      throw new BadRequestException(
        `The agreed cost must be positive with ${currency.decimalPlaces} decimal places`,
      );
    }
    return {
      carrierId: input.carrierId,
      agreedCost,
      currency: currency.code,
      externalVehicle: input.externalVehicle ?? null,
      externalDriver: input.externalDriver ?? null,
    };
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
    trip: TripWithDetails,
  ): Promise<Map<string, string>> {
    const found = await this.shipments.tripSummaries(
      user,
      trip.shipments.map((l) => l.shipmentId),
    );
    return new Map(found.map((s) => [s.id, s.number]));
  }

  /**
   * Links shipments to the trip and moves each to TRIP_SCHEDULED (unless it is there already),
   * under its lock, in id order. 409 when a shipment is closed or cancelled, already on another
   * planned or departed trip, or cannot be scheduled now; the caller's transaction then rolls
   * back everything.
   */
  private async scheduleShipments(
    tx: Tx,
    user: AuthUser,
    trip: { id: string; number: string; branchId: string },
    shipmentIds: readonly string[],
    numbers: ReadonlyMap<string, string>,
  ): Promise<void> {
    const blocked: string[] = [];
    for (const shipmentId of [...shipmentIds].sort()) {
      const label = numbers.get(shipmentId) ?? shipmentId;
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (!isActive(status)) {
        throw new ConflictException(`Shipment ${label} is ${status} and cannot go on a trip`);
      }
      // A trip carries the shipments of its branch only, even for a user of several branches:
      // those it owns and those shared with it (a PTS → KRT leg of a DXB shipment).
      const shipment = await this.shipments.branchAndLastEventInTx(tx, shipmentId);
      if (!shipmentBranches(shipment).includes(trip.branchId)) {
        throw new BadRequestException(`Shipment ${label} belongs to another branch than the trip`);
      }
      const other = await tx.tripShipment.findFirst({
        where: {
          shipmentId,
          tripId: { not: trip.id },
          trip: { status: { in: [...OPEN_TRIP_STATUSES] } },
        },
        select: { trip: { select: { number: true } } },
      });
      if (other) {
        throw new ConflictException(`Shipment ${label} is already on trip ${other.trip.number}`);
      }
      if (status !== SCHEDULED_STATUS) {
        const moved = await this.shipments.advanceInTx(tx, user, shipmentId, SCHEDULED_STATUS, {
          occurredAt: new Date(),
          note: trip.number,
        });
        if (!moved) blocked.push(`${label} (${status})`);
      }
      await tx.tripShipment.create({
        data: { tripId: trip.id, shipmentId, branchId: trip.branchId },
      });
    }
    if (blocked.length > 0) {
      throw new ConflictException(`Cannot schedule a trip for: ${blocked.join(', ')}`);
    }
  }

  /**
   * Moves every shipment of the trip to `target` through the state machine, in id order under
   * each shipment's lock. A shipment already at `target` or beyond it on this leg (atOrPastOnLeg)
   * is left alone. 400 when the move is dated before the latest event of a shipment it moves (the
   * timeline would go backwards); 409 naming every shipment that cannot take the move. Either way
   * the caller's transaction rolls back the ones already moved.
   */
  private async moveShipments(
    tx: Tx,
    user: AuthUser,
    trip: { number: string },
    shipmentIds: readonly string[],
    target: ShipmentStatus,
    occurredAt: Date,
    locationId: string,
    numbers: ReadonlyMap<string, string>,
  ): Promise<void> {
    const blocked: string[] = [];
    for (const shipmentId of [...shipmentIds].sort()) {
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (atOrPastOnLeg(status, target)) continue;
      const { lastEventAt } = await this.shipments.branchAndLastEventInTx(tx, shipmentId);
      if (lastEventAt && occurredAt < lastEventAt) {
        throw new BadRequestException(
          `Shipment ${numbers.get(shipmentId) ?? shipmentId} has events after that time: ` +
            `the trip change cannot be dated before ${lastEventAt.toISOString()}`,
        );
      }
      const moved = await this.shipments.advanceInTx(tx, user, shipmentId, target, {
        occurredAt,
        note: trip.number,
        locationId,
      });
      if (!moved) blocked.push(`${numbers.get(shipmentId) ?? shipmentId} (${status})`);
    }
    if (blocked.length > 0) {
      throw new ConflictException(
        `These shipments cannot move to ${target}: ${blocked.join(', ')}. Resolve them or take ` +
          'them off the trip first',
      );
    }
  }

  private async toDto(user: AuthUser, t: TripWithDetails): Promise<TripDto> {
    const has = (permission: Permission) => user.permissions.has(permission);
    const driverOnly = isDriverOnly(user);
    const showsCost = seesTransportCosts(has);
    const shipmentIds = t.shipments.map((l) => l.shipmentId);
    const [summaries, shares] = await Promise.all([
      this.shipments.tripSummaries(user, shipmentIds),
      this.autoJournal.shipmentShares(
        [
          ...t.expenses.map((e) => e.journalEntryId),
          ...(t.accrualEntryId ? [t.accrualEntryId] : []),
        ],
        t.branchId,
      ),
    ]);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    const canPod = has('pod:create') && has('documents:create') && tripTakesPod(t.status);
    const shipments: TripShipmentDto[] = [];
    for (const shipmentId of shipmentIds) {
      const s = byId.get(shipmentId);
      if (!s) continue;
      const total = (values: (Decimal | null)[]) => {
        const present = values.filter((v): v is Decimal => v !== null);
        return present.length === 0
          ? null
          : toDecimalString(present.reduce((acc, v) => acc.plus(v), ZERO));
      };
      shipments.push({
        shipmentId,
        shipmentNumber: s.number,
        customerName: s.customerName,
        status: s.status,
        destinationLocationId: s.destinationLocationId,
        packages: s.items.reduce((sum, i) => sum + i.quantity, 0),
        weightKg: total(s.items.map((i) => i.weightKg)),
        volumeCbm: total(s.items.map((i) => i.volumeCbm)),
        canRecordPod:
          canPod && isActive(s.status) && s.status !== 'DELIVERED' && s.status !== 'ON_HOLD',
      });
    }
    const canAddExpense =
      !driverOnly && has('expenses:create') && t.kind === 'OWN' && takesExpenses(t.status);
    const cashAccounts = canAddExpense ? await this.accounts.cashAccountsFor(t.branchId) : [];
    const shareDtos = (entryId: string | null) =>
      (entryId && showsCost ? (shares.get(entryId) ?? []) : []).map((s) => ({
        shipmentId: s.shipmentId,
        shipmentNumber: s.shipmentNumber,
        amount: toDecimalString(s.amount),
      }));
    return {
      ...toSummary(t),
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      carrierId: t.carrierId,
      agreedCost: showsCost ? toDecimalStringOrNull(t.agreedCost) : null,
      currency: t.currency,
      externalVehicle: t.externalVehicle,
      externalDriver: t.externalDriver,
      completedAt: t.completedAt?.toISOString() ?? null,
      cancelledAt: t.cancelledAt?.toISOString() ?? null,
      cancelReason: t.cancelReason,
      notes: t.notes,
      createdByName: t.createdBy.fullName,
      accrualJournalEntryId: t.accrualEntryId,
      accrualJournalNumber: t.accrualEntry?.number ?? null,
      accrualShares: shareDtos(t.accrualEntryId),
      showsCost,
      shipments,
      expenses: t.expenses.map((e) => ({
        id: e.id,
        number: e.number,
        expenseDate: fromDbDate(e.expenseDate),
        description: e.description,
        amount: toDecimalString(e.amount),
        currency: e.currency,
        fxRate: e.fxRate.toFixed(),
        cashAccountId: e.cashAccountId,
        cashAccountCode: e.cashAccount.code,
        journalEntryId: e.journalEntryId,
        journalNumber: e.journalEntry.number,
        status: e.status,
        cancelReason: e.cancelReason,
        createdByName: e.createdBy.fullName,
        shares: shareDtos(e.journalEntryId),
      })),
      cashAccounts,
      actions: {
        moves: has('transport_trips:update') ? [...tripMoves(t.status)] : [],
        canCancel: !driverOnly && has('transport_trips:cancel') && isPlanned(t.status),
        canEditShipments: !driverOnly && has('transport_trips:update') && isPlanned(t.status),
        canAddExpense,
        canCancelExpense: !driverOnly && has('expenses:cancel'),
      },
    };
  }
}

function toSummary(t: TripWithSummary): TripSummaryDto {
  return {
    id: t.id,
    number: t.number,
    branchId: t.branchId,
    kind: t.kind,
    status: t.status,
    originLocationId: t.originLocationId,
    destinationLocationId: t.destinationLocationId,
    plannedDeparture: t.plannedDeparture?.toISOString() ?? null,
    plannedArrival: t.plannedArrival?.toISOString() ?? null,
    actualDeparture: t.actualDeparture?.toISOString() ?? null,
    actualArrival: t.actualArrival?.toISOString() ?? null,
    vehicleLabel: t.vehicle?.plateNumber ?? t.externalVehicle,
    driverLabel: t.driver?.name ?? t.externalDriver,
    carrierName: t.carrier?.name ?? null,
    shipmentCount: t._count.shipments,
  };
}

/**
 * The shape of a new trip's own or external fields, before any lookup: an own trip names a fleet
 * vehicle and driver and nothing of a carrier; an external trip a carrier, cost and currency.
 */
function checkKindShape(input: TripInput): void {
  if (input.kind === 'OWN') {
    if (!input.vehicleId || !input.driverId) {
      throw new BadRequestException('An own trip needs a vehicle and a driver');
    }
    if (input.carrierId || input.agreedCost || input.currency) {
      throw new BadRequestException('An own trip has no carrier or agreed cost');
    }
    if (input.externalVehicle || input.externalDriver) {
      throw new BadRequestException('An own trip takes its vehicle and driver from the fleet');
    }
    return;
  }
  if (input.vehicleId || input.driverId) {
    throw new BadRequestException('An external trip has no fleet vehicle or driver');
  }
  if (!input.carrierId || !input.agreedCost || !input.currency) {
    throw new BadRequestException('An external trip needs a carrier, agreed cost and currency');
  }
}

/**
 * Posted expenses were split over the trip's shipments when they were posted: while any stands,
 * the shipments of the trip are fixed (409). Cancel the expense first. The caller holds the trip
 * lock, which expense posting also takes.
 */
async function requireNoPostedExpenses(tx: Tx, tripId: string): Promise<void> {
  const posted = await tx.tripExpense.count({ where: { tripId, status: 'POSTED' } });
  if (posted > 0) {
    throw new ConflictException(
      'The trip has posted expenses shared by its shipments: cancel them before changing the shipments',
    );
  }
}
