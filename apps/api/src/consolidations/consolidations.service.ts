import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BillableConsolidationDto,
  ConsolidationDto,
  ConsolidationInput,
  ConsolidationMoveRequest,
  ConsolidationShipmentDto,
  ConsolidationStatus,
  ConsolidationSummaryDto,
  ConsolidationUpdateRequest,
  Page,
  Permission,
  ShipmentConsolidationDto,
  ShipmentStatus,
} from '@nolon/shared';
import { seesConsolidationCosts } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import {
  assertBranchAccess,
  branchScope,
  canAccessBranch,
  listBranchScope,
} from '../auth/branch-scope.js';
import { fromDbDateOrNull, toDbDate, todayIn } from '../common/dates.js';
import { dateRange } from '../common/list-filters.js';
import { type Decimal, ZERO, toDecimalString } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import type { Consolidation, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { shipmentBranches } from '../shipments/shipment-scope.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive, stageApplies } from '../shipments/state-machine.js';
import {
  atOrPastOnSeaLeg,
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

export interface ConsolidationFilters extends PageQuery {
  status?: ConsolidationStatus;
  /** One of the user's branches (403 otherwise); else all of them. */
  branchId?: string;
  /** ETD from / to, both included. */
  from?: string;
  to?: string;
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
export class ConsolidationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly masterData: MasterDataService,
    private readonly costs: ContainerCostsRegistry,
  ) {}

  async list(
    user: AuthUser,
    filters: ConsolidationFilters,
  ): Promise<Page<ConsolidationSummaryDto>> {
    const where: Prisma.ConsolidationWhereInput = {
      ...listBranchScope(user, filters.branchId),
      etd: dateRange(filters.from, filters.to),
      ...(filters.status ? { status: filters.status } : {}),
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
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<ConsolidationDto> {
    return this.toDto(user, await this.findScoped(user, id));
  }

  /**
   * The containers of a shipment the user can see (404 unless they can see the shipment). A
   * container of a branch the user does not work in is listed but cannot be opened.
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
      canOpen: canAccessBranch(user, c.branchId),
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
      await this.addShipments(tx, container, shipmentIds, numbers);
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
    await this.findScoped(user, id);
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

  /** Puts another shipment in an open container. */
  async addShipment(user: AuthUser, id: string, shipmentId: string): Promise<ConsolidationDto> {
    await this.findScoped(user, id);
    const numbers = await this.requireVisibleShipments(user, [shipmentId]);
    await this.prisma.$transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      if (!isOpen(container.status)) {
        throw new ConflictException('Shipments are added only while the container is open');
      }
      const count = await tx.consolidationShipment.count({ where: { consolidationId: id } });
      if (count >= MAX_CONTAINER_SHIPMENTS) {
        throw new ConflictException(
          `A container holds at most ${MAX_CONTAINER_SHIPMENTS} shipments`,
        );
      }
      await this.addShipments(tx, container, [shipmentId], numbers);
    });
    return this.get(user, id);
  }

  /** Takes a shipment out of an open container; it can go in another one. */
  async removeShipment(user: AuthUser, id: string, shipmentId: string): Promise<ConsolidationDto> {
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      if (!isOpen(container.status)) {
        throw new ConflictException('Shipments are removed only while the container is open');
      }
      const { count } = await tx.consolidationShipment.deleteMany({
        where: { consolidationId: id, shipmentId },
      });
      if (count === 0) throw new NotFoundException('The shipment is not in this container');
    });
    return this.get(user, id);
  }

  /** Closes, loads, departs, arrives or unpacks the container (see the class comment). */
  async move(
    user: AuthUser,
    id: string,
    input: ConsolidationMoveRequest,
  ): Promise<ConsolidationDto> {
    const existing = await this.findScoped(user, id);
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
    await this.findScoped(user, id);
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

  /** 404 unless the container is in one of the user's branches. */
  private async findScoped(user: AuthUser, id: string): Promise<ContainerWithDetails> {
    const container = await this.prisma.consolidation.findFirst({
      where: { id, ...branchScope(user) },
      include: detailInclude,
    });
    if (!container) throw new NotFoundException('Container not found');
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
   * shipment NOLON carries, of the container's branch (owned or shared with it), not yet on the
   * sea leg, and in no other container. The container's voyage is copied to them.
   */
  private async addShipments(
    tx: Tx,
    container: Consolidation,
    shipmentIds: readonly string[],
    numbers: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const shipmentId of [...shipmentIds].sort()) {
      const label = numbers.get(shipmentId) ?? shipmentId;
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (!isActive(status) || !BEFORE_CONSOLIDATION.includes(status)) {
        throw new ConflictException(`Shipment ${label} is ${status} and cannot be consolidated`);
      }
      const shape = await this.shipments.shapeInTx(tx, shipmentId);
      if (!stageApplies('CONSOLIDATED', shape)) {
        throw new BadRequestException(`Shipment ${label} is not an LCL sea shipment NOLON carries`);
      }
      const shipment = await this.shipments.branchAndLastEventInTx(tx, shipmentId);
      if (!shipmentBranches(shipment).includes(container.branchId)) {
        throw new BadRequestException(
          `Shipment ${label} belongs to another branch than the container`,
        );
      }
      const other = await tx.consolidationShipment.findFirst({
        where: { shipmentId, consolidation: { status: { not: 'CANCELLED' } } },
        select: { consolidation: { select: { number: true } } },
      });
      if (other) {
        throw new ConflictException(
          `Shipment ${label} is already in container ${other.consolidation.number}`,
        );
      }
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

  private async toDto(user: AuthUser, c: ContainerWithDetails): Promise<ConsolidationDto> {
    const has = (permission: Permission) => user.permissions.has(permission);
    const showsCost = seesConsolidationCosts(has);
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
      actions: {
        canEdit: has('consolidation:update') && isEditable(c.status),
        canEditShipments: has('consolidation:update') && isOpen(c.status),
        moves: has('consolidation:update') ? [...consolidationMoves(c.status)] : [],
        canCancel: has('consolidation:cancel') && isOpen(c.status),
      },
    };
  }
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
