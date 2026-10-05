import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  GoodsReceiptRequest,
  GoodsReleaseRequest,
  Permission,
  ShipmentWarehouseDto,
  WarehouseBalanceDto,
  WarehouseMovementDto,
  WarehouseMovementKind,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { shipmentScope } from '../shipments/shipment-scope.js';
import { todayIn } from '../common/dates.js';
import { dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { DocumentsService } from '../documents/documents.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive } from '../shipments/state-machine.js';
import {
  canRelease,
  defaultReceiptStatus,
  extraPackagesOnReceipt,
  heldPackages,
  receiptStatusOptions,
  releasableAt,
  totalsByWarehouse,
} from './warehouse-rules.js';
import { type MovementWarehouse, WarehousesService } from './warehouses.service.js';

type Tx = Prisma.TransactionClient;

const movementDetails = {
  warehouse: { select: { code: true, nameEn: true, nameAr: true } },
  storageLocation: { select: { code: true } },
  createdBy: { select: { fullName: true } },
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
export class WarehouseMovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly warehouses: WarehousesService,
    private readonly documents: DocumentsService,
  ) {}

  async view(user: AuthUser, shipmentId: string): Promise<ShipmentWarehouseDto> {
    const shipment = await this.shipments.childContext(user, shipmentId);
    const movements = await this.prisma.warehouseMovement.findMany({
      where: { shipmentId, shipment: shipmentScope(user) },
      include: movementDetails,
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });
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
      });
    }
    const has = (permission: Permission) => user.permissions.has(permission);
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
      movements: movements.map(toDto),
      actions: {
        canReceive: has('warehouse:create') && active,
        canRelease:
          has('warehouse:create') &&
          shipment.status !== 'CLOSED' &&
          balances.some((b) => b.onHandPackages > 0),
        canAddPhotos:
          has('warehouse:create') && has('documents:create') && shipment.status !== 'CANCELLED',
        receiptStatuses,
        defaultReceiptStatus: defaultReceiptStatus(receiptStatuses),
      },
    };
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
    const shipment = await this.shipments.childContext(user, shipmentId);
    if (!isActive(shipment.status)) {
      throw new ConflictException('A closed or cancelled shipment cannot receive goods');
    }
    if (input.extraPackagesConfirmed && !input.note) {
      throw new BadRequestException('Say in the note why there are extra packages');
    }
    const occurredAt = occurredAtOf(input.occurredAt);
    const id = await this.prisma.$transaction(async (tx) => {
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
        where: { shipmentId, shipment: shipmentScope(user) },
        select: { kind: true, warehouseId: true, packages: true, weightKg: true },
      });
      const extra = extraPackagesOnReceipt(shipment.packages, heldPackages(logged), input.packages);
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
    });
    return this.getMovement(user, shipmentId, id);
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
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    if (shipment.status === 'CLOSED') {
      throw new ConflictException('A closed shipment cannot release goods');
    }
    const occurredAt = occurredAtOf(input.occurredAt);
    const id = await this.prisma.$transaction(async (tx) => {
      // Exclusive: a concurrent release of the same shipment waits here, then sees this one.
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (status === 'CLOSED')
        throw new ConflictException('A closed shipment cannot release goods');
      const warehouse = await this.warehouses.requireForMovement(
        tx,
        user,
        input.warehouseId,
        null,
        'release',
      );
      const held = await tx.warehouseMovement.findMany({
        where: { shipmentId, warehouseId: warehouse.id, shipment: shipmentScope(user) },
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
          branchId: shipment.branchId,
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
    });
    return this.getMovement(user, shipmentId, id);
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
  };
}
