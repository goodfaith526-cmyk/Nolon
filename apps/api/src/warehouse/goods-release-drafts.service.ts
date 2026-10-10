import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  GoodsReleaseDraftCreateRequest,
  GoodsReleaseDraftDto,
  GoodsReleaseDraftListItemDto,
  GoodsReleaseDraftRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import {
  approvedFields,
  checkDraft,
  decimalKey,
  draftExpiry,
  draftStatus,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import { DraftsService, decideInTx, keyReused } from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { shipmentScope } from '../shipments/shipment-scope.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { WarehouseMovementsService } from './warehouse-movements.service.js';

const LABEL = 'goods release draft';
const ASSISTANT_ONLY = 'Goods release drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a goods release draft';

const details = {
  shipment: { select: { number: true } },
  warehouse: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  movement: { select: { number: true } },
} satisfies Prisma.GoodsReleaseDraftInclude;

type DraftRow = Prisma.GoodsReleaseDraftGetPayload<{ include: typeof details }>;

/** The release a stored draft proposes, in the shape WarehouseMovementsService takes. */
export function releaseRequestOf(d: DraftRow): GoodsReleaseDraftRequest {
  return {
    warehouseId: d.warehouseId,
    packages: d.packages,
    weightKg: toDecimalStringOrNull(d.weightKg),
    partyName: d.partyName,
    note: d.note,
  };
}

/** sha256 of the normalised request (shipment included): ids lower case, decimals canonical. */
export function releaseRequestHash(shipmentId: string, input: GoodsReleaseDraftRequest): string {
  return requestHash({
    shipmentId: shipmentId.toLowerCase(),
    warehouseId: input.warehouseId.toLowerCase(),
    packages: input.packages,
    weightKg: input.weightKg ? decimalKey(dec(input.weightKg)) : null,
    partyName: input.partyName ?? null,
    note: input.note ?? null,
  });
}

/**
 * Goods release drafts proposed by the staff AI assistant (entry drafts, src/drafts). A person
 * approves a draft, which issues an ordinary goods release note dated at the approval through
 * WarehouseMovementsService in the same transaction, with their permissions and branches (the
 * releasable packages are checked under the shipment lock); or rejects it. Access follows the
 * shipment, as for the shipment's own warehouse movements.
 */
@Injectable()
export class GoodsReleaseDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly movements: WarehouseMovementsService,
    private readonly shipments: ShipmentsService,
    private readonly drafts: DraftsService,
  ) {}

  async create(
    user: AuthUser,
    body: GoodsReleaseDraftCreateRequest,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, shipmentId, ...input } = body;
    // The checks of a real release that need no lock; nothing is written.
    const prepared = await this.movements.prepareRelease(user, shipmentId, input);
    await this.requireWarehouse(user, input.warehouseId);
    const hash = releaseRequestHash(shipmentId, input);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.goodsReleaseDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        const draft = await tx.goodsReleaseDraft.create({
          data: {
            ...scope,
            branchId: prepared.branchId,
            shipmentId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            warehouseId: input.warehouseId,
            packages: input.packages,
            weightKg: input.weightKg ? dec(input.weightKg) : null,
            partyName: input.partyName ?? null,
            note: input.note ?? null,
          },
          select: { id: true },
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.goodsReleaseDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, shipment: shipmentScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Goods release draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<GoodsReleaseDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.goodsReleaseDraft.findMany({
      where: { shipment: shipmentScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return drafts.map((d) => ({
      ...baseFields(d, user, now),
      lineCount: 1,
      packages: d.packages,
      weightKg: toDecimalStringOrNull(d.weightKg),
    }));
  }

  async get(user: AuthUser, id: string): Promise<GoodsReleaseDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return { ...baseFields(draft, user, now), request: releaseRequestOf(draft), check };
  }

  /**
   * A person approves the version they reviewed: the release note is issued in the same
   * transaction as the approval, dated now. Locks the shipment first, then the draft row, as every
   * shipment child write does. Approving an approved draft returns it as it is.
   */
  async approve(user: AuthUser, id: string, version: number): Promise<GoodsReleaseDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    const request = releaseRequestOf(current);
    const prepared = await this.movements.prepareRelease(user, current.shipmentId, request);
    await this.prisma.$transaction(async (tx) => {
      let movementId = '';
      const decided = await decideInTx(tx, {
        table: 'goods_release_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        lockParents: async () => {
          await this.shipments.lockForChildWrite(tx, current.shipmentId, { exclusive: true });
        },
        record: async () => {
          movementId = await this.movements.releaseInTx(tx, user, prepared, request);
        },
      });
      if (decided) {
        await tx.goodsReleaseDraft.update({
          where: { id },
          data: { ...approvedFields(user), movementId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<GoodsReleaseDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'goods_release_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.goodsReleaseDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason),
      });
    });
    return this.get(user, id);
  }

  /** NOLON's checks of a release that need no lock (the releasable packages are checked on approval). */
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      await this.movements.prepareRelease(user, draft.shipmentId, releaseRequestOf(draft));
      await this.requireWarehouse(user, draft.warehouseId);
      return { total: null, currency: null };
    });
  }

  /** The warehouse must be one of the user's branches, as a release requires. */
  private async requireWarehouse(user: AuthUser, warehouseId: string): Promise<void> {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, ...branchScope(user) },
      select: { id: true },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.goodsReleaseDraft.findFirst({
      where: { id, shipment: shipmentScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Goods release draft not found');
    return draft;
  }
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: 1,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<GoodsReleaseDraftDto, 'request' | 'check'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('warehouse:create');
  return {
    id: d.id,
    branchId: d.branchId,
    subject: d.shipment.number,
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: false, canDecide: open },
    shipmentId: d.shipmentId,
    shipmentNumber: d.shipment.number,
    warehouseCode: d.warehouse.code,
    movementId: d.movementId,
    movementNumber: d.movement?.number ?? null,
  };
}
