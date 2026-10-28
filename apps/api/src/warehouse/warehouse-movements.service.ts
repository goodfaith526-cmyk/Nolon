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
  GoodsReceiptRequest,
  GoodsReleaseRequest,
  Permission,
  ShipmentStatus,
  ShipmentWarehouseDto,
  WarehouseBalanceDto,
  WarehouseMovementDto,
  WarehouseMovementKind,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { shipmentScope, holdsOnShipment } from '../shipments/shipment-scope.js';
import { todayIn } from '../common/dates.js';
import { codedRefusal } from '../common/validation.js';
import { dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { DocumentsService } from '../documents/documents.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ShipmentGoodsOnHand,
  ShipmentStockHandler,
} from '../shipments/shipment-stock.registry.js';
import { ShipmentLinksRegistry } from '../shipments/shipment-links.registry.js';
import { ShipmentStockRegistry } from '../shipments/shipment-stock.registry.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive } from '../shipments/state-machine.js';
import {
  canRelease,
  defaultReceiptStatus,
  extraPackagesOnReceipt,
  heldPackages,
  movementCancelBlocker,
  receiptStatusOptions,
  releasableAt,
  remainingWeightKg,
  totalsByWarehouse,
} from './warehouse-rules.js';
import { type MovementWarehouse, WarehousesService } from './warehouses.service.js';

type Tx = Prisma.TransactionClient;

const movementDetails = {
  warehouse: { select: { code: true, nameEn: true, nameAr: true } },
  storageLocation: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  cancellation: { include: { cancelledBy: { select: { fullName: true } } } },
  photos: {
    where: { document: { deletedAt: null } },
    include: { document: { select: { id: true, fileName: true, uploadedAt: true } } },
  },
} satisfies Prisma.WarehouseMovementInclude;

type MovementWithDetails = Prisma.WarehouseMovementGetPayload<{
  include: typeof movementDetails;
}>;

/** A movement may be recorded after the fact, but not ahead of the clock (small skew ok). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Document number prefixes: goods received note, goods release note. */
const NUMBER_PREFIX: Record<WarehouseMovementKind, string> = { RECEIPT: 'GRN', RELEASE: 'GRL' };

/** Shipment documents of this type hold the movement photos (documents master data). */
const PHOTO_DOCUMENT_TYPE = 'PHOTO';

/** A goods release checked by prepareRelease, ready for releaseInTx. */
export interface PreparedRelease {
  shipmentId: string;
  branchId: string;
  occurredAt: Date;
}

/** A goods receipt checked by prepareReceipt, ready for receiveInTx. */
export interface PreparedReceipt {
  shipment: { id: string; branchId: string; status: ShipmentStatus; packages: number };
  occurredAt: Date;
}

export interface PhotoUpload {
  fileName: string;
  note: string | null;
  data: Buffer;
}

/**
 * Goods receipts and releases against a shipment (scope 10), and its movement log. Access follows
 * the shipment (404 when the user cannot see it) and the warehouse (404 when it is not in one of
 * the user's branches). Every write locks the shipment row exclusively
 * (ShipmentsService.lockForChildWrite), so receipts and releases of one shipment run one after
 * another and a release always sees every movement before it. The warehouse row is share-locked
 * in the same transaction (WarehousesService.requireForMovement).
 */
@Injectable()
export class WarehouseMovementsService implements OnModuleInit, ShipmentStockHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly warehouses: WarehousesService,
    private readonly documents: DocumentsService,
    private readonly shipmentStock: ShipmentStockRegistry,
    private readonly shipmentLinks: ShipmentLinksRegistry,
  ) {}

  onModuleInit(): void {
    this.shipmentStock.register(this);
    // B2: the status a receipt or release applied is not undone from the shipment.
    this.shipmentLinks.register({
      revertBlockerInTx: async (tx, shipmentId, step) => {
        if (step.note === null) return null;
        const movement = await tx.warehouseMovement.findFirst({
          where: { shipmentId, number: step.note, statusApplied: step.status, cancellation: null },
          select: { number: true },
        });
        return movement ? { record: 'WAREHOUSE', number: movement.number } : null;
      },
    });
  }

  /** For a shipment's close (B1-5): the warehouses still holding its goods, in code order. */
  async goodsOnHandInTx(tx: Tx, shipmentId: string): Promise<ShipmentGoodsOnHand[]> {
    const movements = await tx.warehouseMovement.findMany({
      where: { shipmentId, cancellation: null },
      select: {
        kind: true,
        warehouseId: true,
        packages: true,
        weightKg: true,
        warehouse: { select: { code: true } },
      },
    });
    const totals = totalsByWarehouse(movements);
    return [...totals]
      .filter(([, t]) => t.onHandPackages > 0)
      .map(([warehouseId, t]) => ({
        warehouseCode: movements.find((m) => m.warehouseId === warehouseId)?.warehouse.code ?? '',
        packages: t.onHandPackages,
      }))
      .sort((a, b) => a.warehouseCode.localeCompare(b.warehouseCode));
  }

  async view(user: AuthUser, shipmentId: string): Promise<ShipmentWarehouseDto> {
    const shipment = await this.shipments.childContext(user, shipmentId);
    const logged = await this.prisma.warehouseMovement.findMany({
      where: {
        shipmentId,
        shipment: shipmentScope(user),
        // The assistant's field list knows no cancelled movement: it sees the live ones only.
        ...(user.agent ? { cancellation: null } : {}),
      },
      include: movementDetails,
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });
    // A cancelled movement stays in the log, marked, and counts in no balance (B3-1).
    const movements = logged.filter((m) => m.cancellation === null);
    const totals = totalsByWarehouse(movements);
    const balances: WarehouseBalanceDto[] = [];
    for (const [warehouseId, t] of totals) {
      const warehouse = movements.find((m) => m.warehouseId === warehouseId)?.warehouse;
      if (!warehouse) continue;
      balances.push({
        warehouseId,
        warehouseCode: warehouse.code,
        nameEn: warehouse.nameEn,
        nameAr: warehouse.nameAr,
        receivedPackages: t.receivedPackages,
        releasedPackages: t.releasedPackages,
        onHandPackages: t.onHandPackages,
        receivedWeightKg: toDecimalString(t.receivedWeightKg),
        releasedWeightKg: toDecimalString(t.releasedWeightKg),
        remainingWeightKg: toDecimalStringOrNull(remainingWeightKg(movements, warehouseId)),
      });
    }
    const has = (permission: Permission) => holdsOnShipment(user, permission, shipment);
    const active = isActive(shipment.status);
    const receiptStatuses = has('warehouse:create')
      ? receiptStatusOptions(shipment.transitions)
      : [];
    const held = heldPackages(movements);
    return {
      expectedPackages: shipment.packages,
      heldPackages: held,
      remainingPackages: Math.max(0, shipment.packages - held),
      balances,
      movements: logged.map(toDto),
      actions: {
        canReceive: has('warehouse:create') && active,
        canRelease:
          has('warehouse:create') &&
          shipment.status !== 'CLOSED' &&
          balances.some((b) => b.onHandPackages > 0),
        canAddPhotos:
          has('warehouse:create') && has('documents:create') && shipment.status !== 'CANCELLED',
        // The cancel's own rule (F133-1): a branch sharing the shipment sees the button only
        // when it holds the permission in the owning branch too.
        canCancelMovements:
          !user.agent &&
          mayCancelMovements(user, shipment.branchId) &&
          shipment.status !== 'CLOSED',
        receiptStatuses,
        defaultReceiptStatus: defaultReceiptStatus(receiptStatuses),
      },
    };
  }

  /**
   * The warehouses a release of the shipment could leave from now, for this user: those holding
   * its goods (received there minus released from there, more than none) that are in one of the
   * user's branches (a release from a warehouse elsewhere is refused, requireForMovement), active
   * or not (a release may empty an inactive one). Code order. Nothing is written.
   */
  async releasableBalances(
    user: AuthUser,
    shipmentId: string,
  ): Promise<
    {
      warehouseId: string;
      code: string;
      nameEn: string;
      nameAr: string;
      branchId: string;
      onHandPackages: number;
      remainingWeightKg: string | null;
    }[]
  > {
    await this.shipments.requireAccessible(user, shipmentId);
    const movements = await this.prisma.warehouseMovement.findMany({
      where: { shipmentId, shipment: shipmentScope(user), cancellation: null },
      select: { kind: true, warehouseId: true, packages: true, weightKg: true },
    });
    const totals = totalsByWarehouse(movements);
    const held = [...totals].filter(([, t]) => t.onHandPackages > 0).map(([id]) => id);
    const warehouses = await this.prisma.warehouse.findMany({
      where: { id: { in: held }, ...branchScope(user) },
      select: { id: true, code: true, nameEn: true, nameAr: true, branchId: true },
      orderBy: { code: 'asc' },
    });
    return warehouses.map((w) => ({
      warehouseId: w.id,
      code: w.code,
      nameEn: w.nameEn,
      nameAr: w.nameAr,
      branchId: w.branchId,
      onHandPackages: totals.get(w.id)?.onHandPackages ?? 0,
      remainingWeightKg: toDecimalStringOrNull(remainingWeightKg(movements, w.id)),
    }));
  }

  /**
   * Goods receipt (full or partial): issues a GRN. When `shipmentStatus` is given and the state
   * machine allows that move now, the shipment moves to it in the same transaction; otherwise the
   * receipt only records the goods (statusApplied stays null). 409 on a closed or cancelled
   * shipment, and when the warehouses would hold more packages than the cargo lines have, unless
   * the user confirms the extra packages and says why in the note.
   */
  async receive(
    user: AuthUser,
    shipmentId: string,
    input: GoodsReceiptRequest,
  ): Promise<WarehouseMovementDto> {
    const prepared = await this.prepareReceipt(user, shipmentId, input);
    const id = await this.prisma.$transaction((tx) => this.receiveInTx(tx, user, prepared, input));
    return this.getMovement(user, shipmentId, id);
  }

  /**
   * The checks of a goods receipt that need no lock: the shipment is visible to the user and
   * active, and the request is complete. Then receiveInTx records it.
   */
  async prepareReceipt(
    user: AuthUser,
    shipmentId: string,
    input: GoodsReceiptRequest,
  ): Promise<PreparedReceipt> {
    const shipment = await this.shipments.childContext(user, shipmentId);
    if (!isActive(shipment.status)) {
      throw new ConflictException('A closed or cancelled shipment cannot receive goods');
    }
    if (input.extraPackagesConfirmed && !input.note) {
      throw new BadRequestException('Say in the note why there are extra packages');
    }
    return { shipment, occurredAt: occurredAtOf(input.occurredAt) };
  }

  /**
   * Records a prepared goods receipt inside the caller's transaction and returns the movement id,
   * so another write (a GRN draft approval) commits or rolls back together with it. Takes the
   * shipment row lock first (exclusive); a caller that locks other rows must take this lock
   * before them (ShipmentsService.lockForChildWrite), so every path locks in the same order.
   */
  async receiveInTx(
    tx: Tx,
    user: AuthUser,
    prepared: PreparedReceipt,
    input: GoodsReceiptRequest,
  ): Promise<string> {
    const { shipment, occurredAt } = prepared;
    const shipmentId = shipment.id;
    const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
    if (!isActive(status)) {
      throw new ConflictException('A closed or cancelled shipment cannot receive goods');
    }
    const warehouse = await this.warehouses.requireForMovement(
      tx,
      user,
      input.warehouseId,
      input.storageLocationId ?? null,
      'receipt',
    );
    // Under the exclusive shipment lock: every earlier receipt and release is counted.
    const logged = await tx.warehouseMovement.findMany({
      where: { shipmentId, shipment: shipmentScope(user), cancellation: null },
      select: {
        kind: true,
        warehouseId: true,
        packages: true,
        weightKg: true,
        occurredAt: true,
        createdAt: true,
      },
    });
    const extra = extraPackagesOnReceipt(shipment.packages, logged, occurredAt, input.packages);
    if (extra > 0 && !input.extraPackagesConfirmed) {
      throw new ConflictException(
        `This receipt would hold ${extra} more packages than the ${shipment.packages} on the ` +
          'cargo lines: confirm the extra packages and say why in the note',
      );
    }
    const number = await this.nextNumber(tx, 'RECEIPT', warehouse);
    const applied = input.shipmentStatus
      ? await this.shipments.advanceInTx(tx, user, shipmentId, input.shipmentStatus, {
          occurredAt,
          note: number,
          // The tracking page shows where the goods are: at the warehouse's place, when set (D9).
          locationId: warehouse.locationId,
        })
      : false;
    const movement = await tx.warehouseMovement.create({
      data: {
        number,
        kind: 'RECEIPT',
        branchId: shipment.branchId,
        shipmentId,
        warehouseId: warehouse.id,
        storageLocationId: warehouse.storageLocationId,
        packages: input.packages,
        weightKg: input.weightKg ? dec(input.weightKg) : null,
        condition: input.condition,
        partyName: input.partyName ?? null,
        note: input.note ?? null,
        occurredAt,
        statusApplied: applied ? (input.shipmentStatus ?? null) : null,
        createdById: user.id,
      },
      select: { id: true },
    });
    return movement.id;
  }

  /**
   * Goods release (full or partial): issues a goods release note. At most what the warehouse holds
   * for the shipment (received there minus released from there): 409 otherwise. Allowed on a
   * cancelled shipment, so goods still held can be returned; 409 once the shipment is closed.
   */
  async release(
    user: AuthUser,
    shipmentId: string,
    input: GoodsReleaseRequest,
  ): Promise<WarehouseMovementDto> {
    const prepared = await this.prepareRelease(user, shipmentId, input);
    const id = await this.prisma.$transaction((tx) => this.releaseInTx(tx, user, prepared, input));
    return this.getMovement(user, shipmentId, id);
  }

  /** The checks of a goods release that need no lock; releaseInTx then records it. */
  async prepareRelease(
    user: AuthUser,
    shipmentId: string,
    input: Pick<GoodsReleaseRequest, 'occurredAt'>,
  ): Promise<PreparedRelease> {
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    if (shipment.status === 'CLOSED') {
      throw new ConflictException('A closed shipment cannot release goods');
    }
    return { shipmentId, branchId: shipment.branchId, occurredAt: occurredAtOf(input.occurredAt) };
  }

  /**
   * Records a prepared goods release inside the caller's transaction and returns the movement id.
   * Takes the shipment row lock first (exclusive): a concurrent release of the same shipment waits
   * here, then sees this one. A caller that locks other rows takes this lock before them.
   */
  async releaseInTx(
    tx: Tx,
    user: AuthUser,
    prepared: PreparedRelease,
    input: GoodsReleaseRequest,
  ): Promise<string> {
    const { shipmentId, occurredAt } = prepared;
    const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
    if (status === 'CLOSED') throw new ConflictException('A closed shipment cannot release goods');
    const warehouse = await this.warehouses.requireForMovement(
      tx,
      user,
      input.warehouseId,
      null,
      'release',
    );
    const held = await tx.warehouseMovement.findMany({
      where: {
        shipmentId,
        warehouseId: warehouse.id,
        shipment: shipmentScope(user),
        cancellation: null,
      },
      select: {
        kind: true,
        warehouseId: true,
        packages: true,
        weightKg: true,
        occurredAt: true,
        createdAt: true,
      },
    });
    const releasable = releasableAt(held, warehouse.id, occurredAt);
    if (!canRelease(releasable, input.packages)) {
      throw new ConflictException(
        `Cannot release ${input.packages} packages: at most ${releasable} can leave this warehouse at that time`,
      );
    }
    const number = await this.nextNumber(tx, 'RELEASE', warehouse);
    const movement = await tx.warehouseMovement.create({
      data: {
        number,
        kind: 'RELEASE',
        branchId: prepared.branchId,
        shipmentId,
        warehouseId: warehouse.id,
        packages: input.packages,
        weightKg: input.weightKg ? dec(input.weightKg) : null,
        partyName: input.partyName ?? null,
        note: input.note ?? null,
        occurredAt,
        createdById: user.id,
      },
      select: { id: true },
    });
    return movement.id;
  }

  /**
   * Cancels a goods receipt or release (B3-1, docs/plans/05-correction-contracts.md, section 1).
   * The movement stays as recorded; a cancellation row is linked to it, and from then on it counts
   * in no balance, report or check. warehouse:cancel in the movement's branch. Refused (409) on a
   * closed shipment; when, without it, a warehouse would hold less than nothing at some time
   * (cancel the release that took the goods first) or the warehouses together would hold more than
   * the cargo lines and more than they ever did; and when the shipment moved on from the status the
   * movement applied. That status is undone when it is the current step. Cancelling again for the
   * same reason returns the cancelled movement; for another reason it is refused.
   */
  async cancel(
    user: AuthUser,
    shipmentId: string,
    movementId: string,
    reason: string,
  ): Promise<WarehouseMovementDto> {
    const found = await this.findMovement(user, shipmentId, movementId);
    if (!mayCancelMovements(user, found.branchId)) {
      throw new ForbiddenException('You may not cancel warehouse movements of this branch');
    }
    const label = { movement: found.number };
    await this.prisma.$transaction(async (tx) => {
      // The receipt's and release's order: the shipment exclusively, then the warehouse shared.
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      const done = await tx.warehouseMovementCancellation.findUnique({
        where: { movementId },
        select: { reason: true },
      });
      if (done) {
        if (done.reason === reason) return;
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'CORRECTION_ALREADY_DONE',
          `Movement ${found.number} was already cancelled for another reason`,
          { record: found.number },
        );
      }
      if (status === 'CLOSED') {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'MOVEMENT_CANCEL_CLOSED',
          `Shipment is closed: movement ${found.number} cannot be cancelled`,
          label,
        );
      }
      await tx.$queryRaw`SELECT 1 FROM "warehouses" WHERE "id" = ${found.warehouseId}::uuid FOR SHARE`;
      const [live, expected] = await Promise.all([
        tx.warehouseMovement.findMany({
          where: { shipmentId, cancellation: null },
          select: {
            id: true,
            kind: true,
            warehouseId: true,
            packages: true,
            weightKg: true,
            occurredAt: true,
            createdAt: true,
            warehouse: { select: { code: true } },
          },
        }),
        this.shipments.packagesInTx(tx, shipmentId),
      ]);
      const blocker = movementCancelBlocker(live, movementId, expected);
      if (blocker?.kind === 'NEGATIVE') {
        const warehouse = live.find((m) => m.warehouseId === blocker.warehouseId)?.warehouse.code;
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'MOVEMENT_CANCEL_NEGATIVE',
          `Without movement ${found.number}, warehouse ${warehouse} would release goods it does not hold: cancel the later release first`,
          { ...label, warehouse: warehouse ?? '' },
        );
      }
      if (blocker?.kind === 'OVER_PACKAGES') {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'MOVEMENT_CANCEL_OVER_PACKAGES',
          `Without movement ${found.number}, the warehouses would hold ${blocker.peak} packages of ${expected}: cancel the later receipt first`,
          { ...label, peak: String(blocker.peak), packages: String(expected) },
        );
      }
      if (found.statusApplied) {
        await this.shipments.undoRecordStepInTx(
          tx,
          user,
          shipmentId,
          { status: found.statusApplied, numbers: [found.number], reason },
          () =>
            codedRefusal(
              HttpStatus.CONFLICT,
              'MOVEMENT_CANCEL_STATUS_MOVED',
              `The shipment moved on from ${found.statusApplied}, which movement ${found.number} recorded: undo the later steps first`,
              { ...label, status: found.statusApplied ?? '' },
            ),
        );
      }
      await tx.warehouseMovementCancellation.create({
        data: { movementId, branchId: found.branchId, reason, cancelledById: user.id },
      });
    });
    return this.getMovement(user, shipmentId, movementId);
  }

  /** Adds a photo to a movement. The photo is a shipment document of type PHOTO. */
  async addPhoto(
    user: AuthUser,
    shipmentId: string,
    movementId: string,
    upload: PhotoUpload,
  ): Promise<WarehouseMovementDto> {
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    if (shipment.status === 'CANCELLED') {
      throw new ConflictException('A cancelled shipment does not take new documents');
    }
    await this.findMovement(user, shipmentId, movementId);
    const file = await this.documents.prepare({ typeCode: PHOTO_DOCUMENT_TYPE, ...upload });
    if (!file.contentType.startsWith('image/')) {
      throw new BadRequestException('Only JPEG, PNG and WebP photos are accepted');
    }
    await this.prisma.$transaction(async (tx) => {
      if ((await this.shipments.lockForChildWrite(tx, shipmentId)) === 'CANCELLED') {
        throw new ConflictException('A cancelled shipment does not take new documents');
      }
      const document = await this.documents.insert(tx, user, shipment.branchId, shipmentId, file);
      await tx.warehouseMovementPhoto.create({
        data: { movementId, documentId: document.id, branchId: shipment.branchId },
      });
    });
    return this.getMovement(user, shipmentId, movementId);
  }

  private async getMovement(
    user: AuthUser,
    shipmentId: string,
    id: string,
  ): Promise<WarehouseMovementDto> {
    return toDto(await this.findMovement(user, shipmentId, id));
  }

  private async findMovement(
    user: AuthUser,
    shipmentId: string,
    id: string,
  ): Promise<MovementWithDetails> {
    const movement = await this.prisma.warehouseMovement.findFirst({
      where: { id, shipmentId, shipment: shipmentScope(user) },
      include: movementDetails,
    });
    if (!movement) throw new NotFoundException('Movement not found');
    return movement;
  }

  /** NOL-GRN-2026-000001 / NOL-GRL-2026-000001, the year in the warehouse branch's time zone. */
  private async nextNumber(
    tx: Tx,
    kind: WarehouseMovementKind,
    warehouse: MovementWarehouse,
  ): Promise<string> {
    const prefix = NUMBER_PREFIX[kind];
    const year = todayIn(warehouse.timezone).slice(0, 4);
    return formatDocumentNumber(prefix, await nextSequenceValue(tx, prefix, year), year);
  }
}

function occurredAtOf(value: string | undefined): Date {
  const occurredAt = value ? new Date(value) : new Date();
  if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    throw new BadRequestException('The time of a movement cannot be in the future');
  }
  return occurredAt;
}

function toDto(m: MovementWithDetails): WarehouseMovementDto {
  return {
    id: m.id,
    number: m.number,
    kind: m.kind,
    warehouseId: m.warehouseId,
    warehouseCode: m.warehouse.code,
    storageLocationId: m.storageLocationId,
    storageLocationCode: m.storageLocation?.code ?? null,
    packages: m.packages,
    weightKg: toDecimalStringOrNull(m.weightKg),
    condition: m.condition,
    partyName: m.partyName,
    note: m.note,
    occurredAt: m.occurredAt.toISOString(),
    statusApplied: m.statusApplied,
    createdByName: m.createdBy.fullName,
    photos: [...m.photos]
      .sort((a, b) => a.document.uploadedAt.getTime() - b.document.uploadedAt.getTime())
      .map((p) => ({ documentId: p.document.id, fileName: p.document.fileName })),
    cancellation: m.cancellation
      ? {
          reason: m.cancellation.reason,
          cancelledAt: m.cancellation.cancelledAt.toISOString(),
          cancelledByName: m.cancellation.cancelledBy.fullName,
        }
      : null,
  };
}

/**
 * warehouse:cancel in the branch that owns the movements (the shipment's own branch, where every
 * movement is recorded): the cancel and the button that offers it (F133-1).
 */
function mayCancelMovements(user: AuthUser, branchId: string): boolean {
  return user.access.has('warehouse:cancel', branchId);
}
