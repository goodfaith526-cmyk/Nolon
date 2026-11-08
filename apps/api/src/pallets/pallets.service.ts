import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  MAX_PALLET_SHIPMENTS,
  type Page,
  type PalletDto,
  type PalletInput,
  type PalletStatus,
  type PalletSummaryDto,
  type ShipmentStatus,
} from '@nolon/shared';
import QRCode from 'qrcode';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope, canAccessBranch, listBranchScope } from '../auth/branch-scope.js';
import { nextSequenceValue } from '../common/numbering.js';
import { codedRefusal, type PageQuery } from '../common/validation.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { ConsolidationsService } from '../consolidations/consolidations.service.js';
import type { Pallet, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { shipmentBranches } from '../shipments/shipment-scope.js';
import { ShipmentLinksRegistry } from '../shipments/shipment-links.registry.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { TripsService } from '../transport/trips.service.js';
import { WarehousesService } from '../warehouse/warehouses.service.js';
import {
  type CarrierState,
  canLeave,
  carries,
  isLive,
  palletActions,
  palletNumber,
} from './pallet-rules.js';

type Tx = Prisma.TransactionClient;

export interface PalletFilters extends PageQuery {
  status?: PalletStatus;
  /** One of the user's branches (403 otherwise); else all of them. */
  branchId?: string;
  warehouseId?: string;
}

/** Shipments that cannot go on a pallet: finished, or already handed over. */
const NOT_PALLETISED: readonly ShipmentStatus[] = ['DELIVERED', 'CLOSED', 'CANCELLED'];

const palletInclude = {
  warehouse: { select: { nameAr: true, nameEn: true } },
  createdBy: { select: { fullName: true } },
  shipments: { orderBy: { addedAt: 'asc' } },
} satisfies Prisma.PalletInclude;

type PalletWithDetails = Prisma.PalletGetPayload<{ include: typeof palletInclude }>;

/**
 * Plan 15-3 (docs/plans/15-customer-notices-every-stage.md, section 3): pallets, whole shipments
 * wrapped together in a warehouse and handled as one piece.
 *
 * - Filled while OPEN, fixed once CLOSED; UNPACKED or CANCELLED ends it. A shipment is on one live
 *   pallet at a time (`active_shipment_id`, unique), and only while no container or trip holds it.
 * - Put in a container or on a trip, a closed pallet adds all its shipments at once, and that
 *   carrier moves them, each through the state machine. Only the whole pallet
 *   comes out (the container's and trip's single remove refuse its shipments, SHIPMENT_ON_PALLET).
 * - A pallet records no status step of its own: in NOLON a sea leg is an LCL container (its
 *   shipments must be consolidated before loading) and a road leg is a trip, so the carrier moves
 *   them, each shipment through the state machine. Receiving stays the GRN per shipment.
 * - A shipment on a live pallet is not cancelled (ShipmentLinksRegistry).
 *
 * Locks: the pallet row first, then the container or trip, then each shipment exclusively in id
 * order. Every route is 404 while PALLETS_ENABLED is off.
 */
@Injectable()
export class PalletsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly consolidations: ConsolidationsService,
    private readonly trips: TripsService,
    private readonly warehouses: WarehousesService,
    private readonly shipmentLinks: ShipmentLinksRegistry,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    this.shipmentLinks.register({
      livePalletInTx: (tx, shipmentId) => livePalletOf(tx, shipmentId),
      cancelBlockerInTx: async (tx, shipmentId) => {
        const pallet = await livePalletOf(tx, shipmentId);
        return pallet ? { record: 'PALLET', number: pallet.number } : null;
      },
    });
  }

  async list(user: AuthUser, filters: PalletFilters): Promise<Page<PalletSummaryDto>> {
    this.requireOn();
    const where: Prisma.PalletWhereInput = {
      ...listBranchScope(user, filters.branchId),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.pallet.findMany({
        where,
        include: palletInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.pallet.count({ where }),
    ]);
    const items = await this.prisma.$transaction(async (tx) => {
      const out: PalletSummaryDto[] = [];
      for (const row of rows) out.push(summaryOf(row, await this.carrierOf(tx, row)));
      return out;
    });
    return { items, total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<PalletDto> {
    this.requireOn();
    const pallet = await this.findScoped(user, id);
    return this.toDto(user, pallet);
  }

  /**
   * The pallet label's QR code: a link to the pallet's page, which only signed-in staff of its
   * branch open (the link holds the pallet's id, nothing about its shipments).
   */
  async qrSvg(user: AuthUser, id: string): Promise<string> {
    this.requireOn();
    const pallet = await this.findScoped(user, id);
    const base = this.env.PUBLIC_WEB_URL ?? this.env.CORS_ORIGINS[0];
    if (!base) throw new ConflictException('PUBLIC_WEB_URL is not configured');
    return QRCode.toString(`${base.replace(/\/+$/, '')}/pallets/${pallet.id}`, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
    });
  }

  async create(user: AuthUser, input: PalletInput): Promise<PalletDto> {
    this.requireOn();
    const id = await this.prisma.$transaction(async (tx) => {
      const warehouse = await this.warehouses.requireForMovement(
        tx,
        user,
        input.warehouseId,
        null,
        'receipt',
      );
      const branch = await tx.branch.findUniqueOrThrow({
        where: { id: warehouse.branchId },
        select: { code: true },
      });
      const value = await nextSequenceValue(tx, 'PALLET', branch.code);
      const pallet = await tx.pallet.create({
        data: {
          number: palletNumber(branch.code, value),
          branchId: warehouse.branchId,
          warehouseId: warehouse.id,
          notes: input.notes ?? null,
          createdById: user.id,
        },
      });
      return pallet.id;
    });
    return this.get(user, id);
  }

  /** Puts a shipment on an open pallet (see the class comment). */
  async addShipment(user: AuthUser, id: string, shipmentId: string): Promise<PalletDto> {
    this.requireOn();
    await this.findScoped(user, id);
    const [summary] = await this.shipments.tripSummaries(user, [shipmentId]);
    if (!summary) throw new NotFoundException('Shipment not found');
    const label = summary.number;
    await this.prisma.$transaction(async (tx) => {
      const pallet = await lockPallet(tx, id);
      requireOpen(pallet);
      const count = await tx.palletShipment.count({ where: { palletId: id } });
      if (count >= MAX_PALLET_SHIPMENTS) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'PALLET_FULL',
          `A pallet holds at most ${MAX_PALLET_SHIPMENTS} shipments`,
          { pallet: pallet.number },
        );
      }
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (NOT_PALLETISED.includes(status)) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'PALLET_SHIPMENT_FINISHED',
          `Shipment ${label} is ${status} and cannot go on a pallet`,
          { shipment: label },
        );
      }
      const shipment = await this.shipments.branchAndLastEventInTx(tx, shipmentId);
      if (!shipmentBranches(shipment).includes(pallet.branchId)) {
        throw codedRefusal(
          HttpStatus.BAD_REQUEST,
          'PALLET_SHIPMENT_OTHER_BRANCH',
          `Shipment ${label} belongs to another branch than the pallet`,
          { shipment: label },
        );
      }
      const other = await livePalletOf(tx, shipmentId);
      if (other) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'PALLET_SHIPMENT_TAKEN',
          `Shipment ${label} is already on pallet ${other.number}`,
          { shipment: label, pallet: other.number },
        );
      }
      const carrier =
        (await this.consolidations.liveContainerOfInTx(tx, shipmentId)) ??
        (await this.trips.liveTripOfInTx(tx, shipmentId));
      if (carrier) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'PALLET_SHIPMENT_CARRIED',
          `Shipment ${label} is in ${carrier.number}: take it out before putting it on a pallet`,
          { shipment: label, carrier: carrier.number },
        );
      }
      await tx.palletShipment.create({
        data: {
          palletId: id,
          shipmentId,
          branchId: pallet.branchId,
          activeShipmentId: shipmentId,
          addedById: user.id,
        },
      });
    });
    return this.get(user, id);
  }

  /** Takes a shipment off an open pallet. */
  async removeShipment(user: AuthUser, id: string, shipmentId: string): Promise<PalletDto> {
    this.requireOn();
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const pallet = await lockPallet(tx, id);
      requireOpen(pallet);
      const { count } = await tx.palletShipment.deleteMany({ where: { palletId: id, shipmentId } });
      if (count === 0) throw new NotFoundException('The shipment is not on this pallet');
    });
    return this.get(user, id);
  }

  /** Wraps an open pallet: its shipments are fixed from now on. */
  async close(user: AuthUser, id: string): Promise<PalletDto> {
    this.requireOn();
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const pallet = await lockPallet(tx, id);
      requireOpen(pallet);
      const count = await tx.palletShipment.count({ where: { palletId: id } });
      if (count === 0) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'PALLET_EMPTY',
          `Pallet ${pallet.number} has no shipments`,
          { pallet: pallet.number },
        );
      }
      await tx.pallet.update({
        where: { id },
        data: { status: 'CLOSED', closedById: user.id, closedAt: new Date() },
      });
    });
    return this.get(user, id);
  }

  /** Puts a closed pallet in an open container: all its shipments at once. */
  async putInContainer(user: AuthUser, id: string, consolidationId: string): Promise<PalletDto> {
    return this.putIn(user, id, (tx, pallet, ids) =>
      this.consolidations
        .putPalletInTx(tx, user, consolidationId, pallet.id, ids)
        .then(() => ({ consolidationId, tripId: null })),
    );
  }

  /** Puts a closed pallet on a planned trip: all its shipments at once. */
  async putOnTrip(user: AuthUser, id: string, tripId: string): Promise<PalletDto> {
    return this.putIn(user, id, (tx, pallet, ids) =>
      this.trips
        .putPalletInTx(tx, user, tripId, pallet.id, ids)
        .then(() => ({ consolidationId: null, tripId })),
    );
  }

  /** Takes the whole pallet out of its open container or off its planned trip. */
  async takeOut(user: AuthUser, id: string): Promise<PalletDto> {
    this.requireOn();
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const pallet = await lockPallet(tx, id);
      requireClosed(pallet);
      const carrier = await this.carrierOf(tx, pallet);
      if (!carrier || !carries(carrier.state)) {
        throw new NotFoundException('No container or trip carries this pallet');
      }
      // F231-1: taking the pallet out changes the container or trip, so it needs that carrier's
      // own permission in the carrier's branch, as putting it in does.
      if (!user.access.has(carrierPermission(carrier), carrier.branchId)) {
        throw new ForbiddenException(`You cannot change ${carrier.number}`);
      }
      if (!canLeave(carrier.state)) throw carriedRefusal(pallet, carrier.number);
      const ids = await activeShipmentIds(tx, id);
      if (pallet.consolidationId) {
        await this.consolidations.takePalletOutInTx(tx, user, pallet.consolidationId, ids);
      } else if (pallet.tripId) {
        await this.trips.takePalletOutInTx(tx, user, pallet.tripId, ids);
      }
      await tx.pallet.update({ where: { id }, data: { consolidationId: null, tripId: null } });
    });
    return this.get(user, id);
  }

  /** Opens a closed pallet that nothing carries: each shipment goes on by itself. */
  async unpack(user: AuthUser, id: string): Promise<PalletDto> {
    this.requireOn();
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const pallet = await lockPallet(tx, id);
      requireClosed(pallet);
      await this.requireNotCarried(tx, pallet);
      await tx.palletShipment.updateMany({
        where: { palletId: id },
        data: { activeShipmentId: null },
      });
      await tx.pallet.update({
        where: { id },
        data: { status: 'UNPACKED', unpackedById: user.id, unpackedAt: new Date() },
      });
    });
    return this.get(user, id);
  }

  /** Cancels a live pallet that was never carried. */
  async cancel(user: AuthUser, id: string, reason: string): Promise<PalletDto> {
    this.requireOn();
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const pallet = await lockPallet(tx, id);
      if (!isLive(pallet.status) || pallet.carriedAt) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'PALLET_NOT_CANCELLABLE',
          `Pallet ${pallet.number} was carried or is no longer live: unpack it instead`,
          { pallet: pallet.number },
        );
      }
      await tx.palletShipment.updateMany({
        where: { palletId: id },
        data: { activeShipmentId: null },
      });
      await tx.pallet.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledById: user.id,
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      });
    });
    return this.get(user, id);
  }

  private async putIn(
    user: AuthUser,
    id: string,
    load: (
      tx: Tx,
      pallet: Pallet,
      shipmentIds: string[],
    ) => Promise<{ consolidationId: string | null; tripId: string | null }>,
  ): Promise<PalletDto> {
    this.requireOn();
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const pallet = await lockPallet(tx, id);
      requireClosed(pallet);
      await this.requireNotCarried(tx, pallet);
      const ids = await activeShipmentIds(tx, id);
      const carrier = await load(tx, pallet, ids);
      await tx.pallet.update({ where: { id }, data: { ...carrier, carriedAt: new Date() } });
    });
    return this.get(user, id);
  }

  private requireOn(): void {
    if (!this.env.PALLETS_ENABLED) throw new NotFoundException();
  }

  private async findScoped(user: AuthUser, id: string): Promise<PalletWithDetails> {
    const pallet = await this.prisma.pallet.findFirst({
      where: { id, ...branchScope(user) },
      include: palletInclude,
    });
    if (!pallet) throw new NotFoundException('Pallet not found');
    return pallet;
  }

  /** The container or trip the pallet records, with its state now; null when none. */
  private async carrierOf(
    tx: Tx,
    pallet: Pick<Pallet, 'consolidationId' | 'tripId'>,
  ): Promise<Carrier | null> {
    if (pallet.consolidationId) {
      const c = await this.consolidations.carrierInTx(tx, pallet.consolidationId);
      return {
        id: pallet.consolidationId,
        number: c.number,
        branchId: c.branchId,
        state: { kind: 'CONTAINER', status: c.status },
      };
    }
    if (pallet.tripId) {
      const t = await this.trips.carrierInTx(tx, pallet.tripId);
      return {
        id: pallet.tripId,
        number: t.number,
        branchId: t.branchId,
        state: { kind: 'TRIP', status: t.status },
      };
    }
    return null;
  }

  private async requireNotCarried(tx: Tx, pallet: Pallet): Promise<void> {
    const carrier = await this.carrierOf(tx, pallet);
    if (carrier && carries(carrier.state)) throw carriedRefusal(pallet, carrier.number);
  }

  private async toDto(user: AuthUser, p: PalletWithDetails): Promise<PalletDto> {
    const carrier = await this.prisma.$transaction((tx) => this.carrierOf(tx, p));
    const summaries = await this.shipments.tripSummaries(
      user,
      p.shipments.map((l) => l.shipmentId),
    );
    const byId = new Map(summaries.map((s) => [s.id, s]));
    const holds = (permission: Parameters<AuthUser['access']['branchesWith']>[0][number]) =>
      user.access.branchesWith([permission]).length > 0;
    const inBranch = canAccessBranch(user, p.branchId);
    return {
      ...summaryOf(p, carrier),
      notes: p.notes,
      createdByName: p.createdBy.fullName,
      closedAt: p.closedAt?.toISOString() ?? null,
      unpackedAt: p.unpackedAt?.toISOString() ?? null,
      cancelledAt: p.cancelledAt?.toISOString() ?? null,
      cancelReason: p.cancelReason,
      shipments: p.shipments.flatMap((l) => {
        const s = byId.get(l.shipmentId);
        return s
          ? [
              {
                shipmentId: s.id,
                number: s.number,
                status: s.status,
                customerName: s.customerName,
                addedAt: l.addedAt.toISOString(),
              },
            ]
          : [];
      }),
      actions: palletActions({
        status: p.status,
        shipmentCount: p.shipments.length,
        carrier: carrier?.state ?? null,
        used: p.carriedAt !== null,
        can: {
          update: inBranch && user.access.has('warehouse:update', p.branchId),
          cancel: inBranch && user.access.has('warehouse:cancel', p.branchId),
          container: carrier
            ? user.access.has('consolidation:update', carrier.branchId)
            : holds('consolidation:update'),
          trip: carrier
            ? user.access.has('transport_trips:update', carrier.branchId)
            : holds('transport_trips:update'),
        },
      }),
    };
  }
}

interface Carrier {
  id: string;
  number: string;
  branchId: string;
  state: CarrierState;
}

function carrierPermission(carrier: Carrier): 'consolidation:update' | 'transport_trips:update' {
  return carrier.state.kind === 'CONTAINER' ? 'consolidation:update' : 'transport_trips:update';
}

function summaryOf(p: PalletWithDetails, carrier: Carrier | null): PalletSummaryDto {
  return {
    id: p.id,
    number: p.number,
    branchId: p.branchId,
    warehouseId: p.warehouseId,
    warehouseName: { ar: p.warehouse.nameAr, en: p.warehouse.nameEn },
    status: p.status,
    shipmentCount: p.shipments.length,
    carrier:
      carrier && carries(carrier.state)
        ? {
            kind: carrier.state.kind,
            id: carrier.id,
            number: carrier.number,
            status: carrier.state.status,
          }
        : null,
    createdAt: p.createdAt.toISOString(),
  };
}

/** The live pallet a shipment is on, or null. */
async function livePalletOf(
  tx: Tx,
  shipmentId: string,
): Promise<{ id: string; number: string } | null> {
  const link = await tx.palletShipment.findUnique({
    where: { activeShipmentId: shipmentId },
    select: { pallet: { select: { id: true, number: true } } },
  });
  return link?.pallet ?? null;
}

/** The ids of the pallet's live shipments, in id order (the lock order). */
async function activeShipmentIds(tx: Tx, palletId: string): Promise<string[]> {
  const links = await tx.palletShipment.findMany({
    where: { palletId, activeShipmentId: { not: null } },
    select: { shipmentId: true },
    orderBy: { shipmentId: 'asc' },
  });
  return links.map((l) => l.shipmentId);
}

/** Row lock on the pallet, then the row as it is under the lock. */
async function lockPallet(tx: Tx, id: string): Promise<Pallet> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "pallets" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('Pallet not found');
  return tx.pallet.findUniqueOrThrow({ where: { id } });
}

function requireOpen(p: Pallet): void {
  if (p.status !== 'OPEN') {
    throw codedRefusal(
      HttpStatus.CONFLICT,
      'PALLET_NOT_OPEN',
      `Pallet ${p.number} is no longer open: its shipments are fixed`,
      { pallet: p.number },
    );
  }
}

function requireClosed(p: Pallet): void {
  if (p.status !== 'CLOSED') {
    throw codedRefusal(
      HttpStatus.CONFLICT,
      'PALLET_NOT_CLOSED',
      `Pallet ${p.number} must be closed for this`,
      { pallet: p.number },
    );
  }
}

function carriedRefusal(p: Pallet, carrier: string) {
  return codedRefusal(
    HttpStatus.CONFLICT,
    'PALLET_CARRIED',
    `Pallet ${p.number} is carried by ${carrier}, which moves it now`,
    { pallet: p.number, carrier },
  );
}
