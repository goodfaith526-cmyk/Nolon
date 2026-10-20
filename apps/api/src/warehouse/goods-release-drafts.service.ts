import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssistantDraftApproveRequest,
  AssistantDraftDto,
  DraftPreCheckDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  GoodsReleaseDraftCreateRequest,
  GoodsReleaseDraftDto,
  GoodsReleaseDraftListItemDto,
  GoodsReleaseDraftRequest,
  GoodsReleaseDraftUpdateRequest,
  ReleaseDraftWarehouseOptionsDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import {
  approvedFields,
  checkDraft,
  decimalKey,
  draftBranch,
  draftExpiry,
  draftStatus,
  patched,
  preCheck,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
  storedValue,
  withBranch,
} from '../drafts/draft-rules.js';
import {
  decidedVia,
  decideInTx,
  type DecisionVia,
  DraftsService,
  keyReused,
  lockDraftRow,
  requireSameParent,
  lockReplacedInTx,
  listScope,
  type ReviewPage,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  replacementParentIds,
  storedDraftUnderKey,
  valuesOf,
  withReplaced,
  withReplacedBy,
  MY_DRAFTS_ORDER,
  lockKeyInTx,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type Completeness,
  goodsReleaseCompleteness,
  requireApprovable,
} from '../drafts/draft-completeness.js';
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

/** A release draft's shipment and release, as stored (a missing value is null). */
type ReleaseValues = GoodsReleaseDraftRequest & { shipmentId: string | null };

/**
 * The drafts a user sees: those of a shipment in their branches (access follows the shipment, as
 * for its own warehouse movements), and those naming no shipment yet, by the draft's own branch.
 */
function draftScope(user: AuthUser): Prisma.GoodsReleaseDraftWhereInput {
  return { OR: [{ shipment: shipmentScope(user) }, { shipmentId: null, ...branchScope(user) }] };
}

/** The value columns of a draft, a missing value as NULL. */
function columnsOf(values: ReleaseValues) {
  return {
    shipmentId: values.shipmentId ?? null,
    warehouseId: values.warehouseId ?? null,
    packages: values.packages ?? null,
    weightKg: values.weightKg ? dec(values.weightKg) : null,
    partyName: values.partyName ?? null,
    note: values.note ?? null,
  };
}

/** What a release draft still misses before it can be approved (the gate's missing values). */
export function releaseMissingFields(d: DraftRow): string[] {
  return releaseDraftCompleteness(d).missing;
}

/** A goods release draft's approval gate (draft-completeness.ts): its shipment and release. */
export function releaseDraftCompleteness(d: DraftRow): Completeness {
  return goodsReleaseCompleteness({ shipmentId: d.shipmentId, ...releaseRequestOf(d) });
}

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
export function releaseRequestHash(
  shipmentId: string | null | undefined,
  input: GoodsReleaseDraftRequest,
): string {
  return requestHash({
    shipmentId: shipmentId?.toLowerCase() ?? null,
    warehouseId: input.warehouseId?.toLowerCase() ?? null,
    packages: input.packages ?? null,
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

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: GoodsReleaseDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { shipmentId = null, branchId, ...input } = valuesOf(body);
    return preCheck(withBranch(releaseRequestHash(shipmentId, input), branchId), async () => {
      await this.validate(user, { shipmentId, ...input }, branchId);
      const missingFields = goodsReleaseCompleteness({ shipmentId, ...input }).missing;
      return { total: null, currency: null, missingFields };
    });
  }

  /**
   * The checks of a real release that need no lock, on the values present: the shipment when
   * named, the warehouse when named. The draft's branch is the shipment's (which a branch given
   * must be); with no shipment yet, the branch given, one of the user's.
   */
  private async validate(
    user: AuthUser,
    values: ReleaseValues,
    branchId: string | null | undefined,
  ): Promise<{ branchId: string }> {
    const prepared = values.shipmentId
      ? await this.movements.prepareRelease(user, values.shipmentId, {})
      : null;
    if (values.warehouseId) await this.requireWarehouse(user, values.warehouseId);
    return { branchId: draftBranch(user, branchId, prepared?.branchId ?? null) };
  }

  async create(
    user: AuthUser,
    body: GoodsReleaseDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, shipmentId = null, branchId, ...input } = body;
    const hash = withReplaced(
      withBranch(releaseRequestHash(shipmentId, input), branchId),
      replacesDraftId,
    );
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'goods_release_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real release that need no lock, on the values present; nothing is written.
    const prepared = await this.validate(user, { shipmentId, ...input }, branchId);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        if (replacesDraftId !== null) {
          const ids = await replacementParentIds(
            tx,
            'goods_release_drafts',
            replacesDraftId,
            shipmentId,
          );
          for (const shipment of ids) {
            await this.shipments.lockForChildWrite(tx, shipment, { exclusive: true });
          }
        }
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'goods_release_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'goods_release_drafts', scope);
        const existing = await tx.goodsReleaseDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The user holds the branch now, as stored (not only as their request loaded it).
        await requireBranchMemberInTx(tx, user, prepared.branchId);
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.goodsReleaseDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId: prepared.branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            ...columnsOf({ shipmentId, ...input }),
          },
          select: { id: true },
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create (a shipment named must be of the draft's branch, and once named it
   * stays: an approval locks it before the draft), and the version moves on. The assistant's
   * request (its payload hash) stays the draft's, so a replay of that create still finds it.
   */
  async update(
    user: AuthUser,
    id: string,
    input: GoodsReleaseDraftUpdateRequest,
  ): Promise<GoodsReleaseDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    requireSameParent(current.shipmentId, patch.shipmentId, 'shipment');
    const values = patched<ReleaseValues>(
      { shipmentId: current.shipmentId, ...releaseRequestOf(current) },
      patch,
    );
    await this.validate(user, values, current.branchId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'goods_release_drafts', id);
      if (!locked) throw new NotFoundException('Goods release draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.goodsReleaseDraft.update({
        where: { id },
        data: { ...columnsOf(values), version: { increment: 1 } },
      });
    });
    return this.get(user, id);
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.goodsReleaseDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...draftScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Goods release draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
  ): Promise<GoodsReleaseDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.goodsReleaseDraft.findMany({
      where: {
        ...draftScope(user),
        ...stateFilter(status, now),
        ...scope.where,
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: scope.take,
    });
    return drafts.map((d) => ({
      ...baseFields(d, user, now),
      lineCount: 1,
      packages: d.packages,
      weightKg: toDecimalStringOrNull(d.weightKg),
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('warehouse:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'goods_release',
        d,
        d.movementId === null || d.shipmentId === null
          ? null
          : {
              type: 'warehouse_movement',
              id: d.movementId,
              number: d.movementNumber,
              path: `/shipments/${d.shipmentId}`,
            },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<GoodsReleaseDraftDto> {
    return withReplacedBy(this.prisma, 'goods_release_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<GoodsReleaseDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return { ...baseFields(draft, user, now), request: releaseRequestOf(draft), check };
  }

  /**
   * The review screen's warehouse choices for an open draft that names its shipment: the
   * warehouses holding the shipment's goods now in the reviewer's branches
   * (WarehouseMovementsService.releasableBalances), and a suggestion for the values it misses.
   * Worked out on each read, from the balances now and the draft as it is at `version`: the one
   * warehouse holding the goods, when the draft names none and exactly one does; the packages
   * that warehouse (the one the draft names, else the suggested one) holds, when the draft has
   * none. A suggestion is never saved here: the person sees it in the form, may change it, and
   * saves it (PATCH, which moves the version on); a value the draft holds is never replaced, and
   * a later change of warehouse in the form drops the packages suggested for the earlier one.
   */
  async warehouseOptions(user: AuthUser, id: string): Promise<ReleaseDraftWarehouseOptionsDto> {
    const draft = await this.findScoped(user, id);
    const open = draftStatus(draft.state, draft.expiresAt, new Date()) === 'DRAFT';
    if (!open || draft.shipmentId === null) {
      return { version: draft.version, options: [], suggested: null };
    }
    const options = await this.movements.releasableBalances(user, draft.shipmentId);
    const only = options.length === 1 ? options[0] : undefined;
    const warehouseId = draft.warehouseId === null ? (only?.warehouseId ?? null) : null;
    const from = options.find((o) => o.warehouseId === (draft.warehouseId ?? warehouseId));
    const packages = draft.packages === null ? (from?.onHandPackages ?? null) : null;
    return {
      version: draft.version,
      options,
      suggested: warehouseId === null && packages === null ? null : { warehouseId, packages },
    };
  }

  /**
   * A person approves the version they reviewed: the release note is issued in the same
   * transaction as the approval, dated now. Locks the shipment first, then the draft row, as every
   * shipment child write does. Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    via: DecisionVia = 'SESSION',
  ): Promise<GoodsReleaseDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is checked or released while the draft misses or holds an invalid value (422).
    requireApprovable(releaseDraftCompleteness(current));
    const shipmentId = storedValue(current.shipmentId, 'shipment');
    const request = {
      ...releaseRequestOf(current),
      warehouseId: storedValue(current.warehouseId, 'warehouse'),
      packages: storedValue(current.packages, 'packages'),
    };
    const prepared = await this.movements.prepareRelease(user, shipmentId, {});
    await this.prisma.$transaction(async (tx) => {
      let movementId = '';
      const decided = await decideInTx(tx, {
        table: 'goods_release_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        lockParents: async () => {
          await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
        },
        gate: async () => {
          const row = await tx.goodsReleaseDraft.findUniqueOrThrow({
            where: { id },
            include: details,
          });
          requireApprovable(releaseDraftCompleteness(row));
        },
        record: async () => {
          movementId = await this.movements.releaseInTx(tx, user, prepared, request);
        },
      });
      if (decided) {
        await tx.goodsReleaseDraft.update({
          where: { id },
          data: { ...approvedFields(user, decidedVia(via)), movementId },
        });
      }
    });
    return this.get(user, id);
  }

  /** The draft as the assistant's chat card shows it (erp-agents docs/chat-draft-approval.md). */
  async forAssistant(user: AuthUser, id: string): Promise<AssistantDraftDto<GoodsReleaseDraftDto>> {
    const draft = await this.get(user, id);
    return this.drafts.assistantView(user, 'goods_release', 'goods_release_drafts', draft, LABEL);
  }

  /** A person approves in the assistant's chat the content the card showed them. */
  async approveFromAssistant(
    user: AuthUser,
    id: string,
    input: AssistantDraftApproveRequest,
  ): Promise<GoodsReleaseDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'goods_release',
      'goods_release_drafts',
      draft,
      LABEL,
      input.contentHash,
    );
    return this.approve(user, id, input.version, decision);
  }

  /** A person rejects in the assistant's chat. */
  async rejectFromAssistant(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<GoodsReleaseDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'goods_release',
      'goods_release_drafts',
      draft,
      LABEL,
      null,
    );
    return this.reject(user, id, input, decision);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
    via: DecisionVia = 'SESSION',
  ): Promise<GoodsReleaseDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
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
        data: rejectedFields(user, input.reason, decidedVia(via)),
      });
    });
    return this.get(user, id);
  }

  /**
   * NOLON's checks of a release that need no lock (the releasable packages are checked on
   * approval), on the values present. Null while the draft misses values and those present pass:
   * it waits for them (missingFields).
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const result = await checkDraft(async () => {
      await this.validate(
        user,
        { shipmentId: draft.shipmentId, ...releaseRequestOf(draft) },
        draft.branchId,
      );
      return { total: null, currency: null };
    });
    return result.ok && releaseMissingFields(draft).length > 0 ? null : result;
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
      where: { id, ...draftScope(user) },
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
    missingFields: releaseMissingFields(d),
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
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: d.shipment?.number ?? '',
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedFromAssistant: d.decidedVia === 'ASSISTANT',
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: open, canDecide: open },
    missingFields: releaseMissingFields(d),
    shipmentId: d.shipmentId,
    shipmentNumber: d.shipment?.number ?? null,
    warehouseCode: d.warehouse?.code ?? null,
    movementId: d.movementId,
    movementNumber: d.movement?.number ?? null,
  };
}
