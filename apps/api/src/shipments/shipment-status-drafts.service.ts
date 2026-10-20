import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  DraftEvidence,
  DraftPreCheckDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  ShipmentStatusDraftCreateRequest,
  ShipmentStatusDraftDto,
  ShipmentStatusDraftListItemDto,
  ShipmentStatusDraftRequest,
  ShipmentStatusDraftUpdateRequest,
  ShipmentStatus,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';
import {
  changedFields,
  evidenceAfterEdit,
  evidenceHashPart,
  evidenceOf,
  requireConfirmed,
} from '../drafts/draft-evidence.js';
import {
  approvedFields,
  checkDraft,
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
  decideInTx,
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
  requireApprovable,
  shipmentStatusCompleteness,
} from '../drafts/draft-completeness.js';
import { ShipmentsService } from './shipments.service.js';
import { permissionForTransition } from './state-machine.js';

const LABEL = 'shipment status draft';
const ASSISTANT_ONLY = 'Shipment status drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a shipment status draft';

const details = {
  shipment: { select: { number: true, status: true } },
  location: { select: { nameEn: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
} satisfies Prisma.ShipmentStatusDraftInclude;

type DraftRow = Prisma.ShipmentStatusDraftGetPayload<{ include: typeof details }>;

/** A shipment status draft's approval gate (draft-completeness.ts): its shipment and status. */
export function statusDraftCompleteness(d: DraftRow): Completeness {
  return shipmentStatusCompleteness({ shipmentId: d.shipmentId, status: d.status });
}

export function statusRequestOf(d: DraftRow): ShipmentStatusDraftRequest {
  return { status: d.status, locationId: d.locationId, note: d.note };
}

/** What a shipment status draft still misses before it can be approved (the gate's). */
export function statusMissingFields(d: DraftRow): string[] {
  return statusDraftCompleteness(d).missing;
}

/** A status draft's shipment and change, as stored (a missing value is null). */
type StatusValues = ShipmentStatusDraftRequest & { shipmentId: string | null };

/** The value columns of a draft, a missing value as NULL. */
function columnsOf(values: StatusValues) {
  return {
    shipmentId: values.shipmentId ?? null,
    status: values.status ?? null,
    locationId: values.locationId ?? null,
    note: values.note ?? null,
  };
}

/** sha256 of the normalised request and the staff member's words (shipment included): ids lower case. */
export function statusRequestHash(
  shipmentId: string | null | undefined,
  input: ShipmentStatusDraftRequest,
  evidence: readonly DraftEvidence[] = [],
): string {
  return requestHash({
    ...evidenceHashPart(evidence),
    shipmentId: shipmentId?.toLowerCase() ?? null,
    status: input.status ?? null,
    locationId: input.locationId ? input.locationId.toLowerCase() : null,
    note: input.note ?? null,
  });
}

/**
 * Shipment status changes proposed by the staff AI assistant (entry drafts, src/drafts). A person
 * approves a draft on the review screen, which moves the shipment through the state machine in
 * the same transaction, dated at the approval, with their permissions (the move is checked again
 * under the shipment lock); or rejects it. Access follows the shipment as the user may see it
 * (ShipmentsService.visibleWhere): a Driver only reaches the shipments of their own trips. There
 * is no decision from the assistant's chat.
 */
@Injectable()
export class ShipmentStatusDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly drafts: DraftsService,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: ShipmentStatusDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { shipmentId = null, branchId, evidence = [], ...input } = valuesOf(body);
    const hash = withBranch(statusRequestHash(shipmentId, input, evidence), branchId);
    return preCheck(hash, async () => {
      await this.validate(user, { shipmentId, ...input }, branchId);
      const missingFields = shipmentStatusCompleteness({ shipmentId, ...input }).missing;
      return { total: null, currency: null, missingFields };
    });
  }

  /**
   * The checks a draft's values get on create and on a person's edit: with a shipment and a
   * status, the move in full (prepareStatusChange); otherwise those of the values present, and
   * the permission the status needs when it is given. The draft's branch is the shipment's
   * (which a branch given must be); with no shipment yet, the branch given, one of the user's.
   */
  private async validate(
    user: AuthUser,
    values: StatusValues,
    branchId: string | null | undefined,
  ): Promise<{ branchId: string }> {
    const { shipmentId, status } = values;
    if (status && !canMove(user, status)) {
      throw new ForbiddenException('Missing permission for this status change');
    }
    const shipment =
      shipmentId && status
        ? await this.shipments.prepareStatusChange(user, shipmentId, { ...values, status })
        : await this.shipments.checkStatusPresent(user, shipmentId ?? null, values);
    return { branchId: draftBranch(user, branchId, shipment.branchId) };
  }

  /**
   * The drafts a user sees: those of a shipment as the user may see it (ShipmentsService
   * .visibleWhere, as always), and those naming no shipment yet, by the draft's own branch. A
   * user limited to the shipments of their own trips sees only the former.
   */
  private scope(user: AuthUser): Prisma.ShipmentStatusDraftWhereInput {
    const visible = { shipment: this.shipments.visibleWhere(user) };
    if (limitedToOwnTrips(user, 'shipments')) return visible;
    return { OR: [visible, { shipmentId: null, ...branchScope(user) }] };
  }

  async create(
    user: AuthUser,
    body: ShipmentStatusDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, shipmentId = null, branchId, evidence = [], ...input } = body;
    const hash = withReplaced(
      withBranch(statusRequestHash(shipmentId, input, evidence), branchId),
      replacesDraftId,
    );
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'shipment_status_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real status change that need no lock, on the values present.
    const prepared = await this.validate(user, { shipmentId, ...input }, branchId);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // An approval locks the shipment, then the draft: a replacement takes the same order.
        if (replacesDraftId !== null) {
          const ids = await replacementParentIds(
            tx,
            'shipment_status_drafts',
            replacesDraftId,
            shipmentId,
          );
          for (const shipment of ids) {
            await this.shipments.lockForChildWrite(tx, shipment, { exclusive: true });
          }
        }
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'shipment_status_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'shipment_status_drafts', scope);
        const existing = await tx.shipmentStatusDraft.findUnique({
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
        const draft = await tx.shipmentStatusDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId: prepared.branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
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
   * stays: an approval locks it before the draft), and the version moves on. The words of a
   * value the person changed are dropped. The assistant's request (its payload hash) stays the
   * draft's, so a replay of that create still finds this draft.
   */
  async update(
    user: AuthUser,
    id: string,
    input: ShipmentStatusDraftUpdateRequest,
  ): Promise<ShipmentStatusDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    requireSameParent(current.shipmentId, patch.shipmentId, 'shipment');
    const values = patched<StatusValues>(
      { shipmentId: current.shipmentId, ...statusRequestOf(current) },
      patch,
    );
    await this.validate(user, values, current.branchId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'shipment_status_drafts', id);
      if (!locked) throw new NotFoundException('Shipment status draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.shipmentStatusDraft.update({
        where: { id },
        data: {
          ...columnsOf(values),
          evidence: evidenceAfterEdit(current.evidence, changedFields(patch)),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.shipmentStatusDraft.findFirst({
      where: {
        agentClientId,
        createdById: user.id,
        idempotencyKey,
        ...this.scope(user),
      },
      include: details,
    });
    if (!draft) throw new NotFoundException('Shipment status draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
  ): Promise<ShipmentStatusDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.shipmentStatusDraft.findMany({
      where: {
        ...this.scope(user),
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
      targetStatus: d.status,
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('shipments:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'shipment_status',
        d,
        d.status === 'APPROVED' && d.shipmentId !== null
          ? {
              type: 'shipment',
              id: d.shipmentId,
              number: d.shipmentNumber,
              path: `/shipments/${d.shipmentId}`,
            }
          : null,
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<ShipmentStatusDraftDto> {
    return withReplacedBy(this.prisma, 'shipment_status_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<ShipmentStatusDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return {
      ...baseFields(draft, user, now),
      request: statusRequestOf(draft),
      evidence: evidenceOf(draft.evidence),
      check,
    };
  }

  /**
   * A person approves the version they reviewed: the shipment moves in the same transaction as
   * the approval, dated now. Locks the shipment first, then the draft row, as every shipment child
   * write does. Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    confirmed: readonly string[] = [],
  ): Promise<ShipmentStatusDraftDto> {
    this.drafts.requireDecider(user, 'SESSION', HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is checked or applied while the draft misses or holds an invalid value (422).
    requireApprovable(statusDraftCompleteness(current));
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const shipmentId = storedValue(current.shipmentId, 'shipment');
    const request = { ...statusRequestOf(current), status: storedValue(current.status, 'status') };
    await this.shipments.prepareStatusChange(user, shipmentId, request);
    await this.prisma.$transaction(async (tx) => {
      const decided = await decideInTx(tx, {
        table: 'shipment_status_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        lockParents: async () => {
          await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
        },
        gate: async () => {
          const row = await tx.shipmentStatusDraft.findUniqueOrThrow({
            where: { id },
            include: details,
          });
          requireApprovable(statusDraftCompleteness(row));
        },
        record: async () => {
          await this.shipments.changeStatusInTx(tx, user, shipmentId, request);
        },
      });
      if (decided) {
        await tx.shipmentStatusDraft.update({
          where: { id },
          data: approvedFields(user, 'SESSION'),
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<ShipmentStatusDraftDto> {
    this.drafts.requireDecider(user, 'SESSION', HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    // Whoever could make the move decides on it (anyone who sees it, while it names no status).
    if (current.status !== null && !canMove(user, current.status)) {
      throw new ForbiddenException('Missing permission for this status change');
    }
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'shipment_status_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.shipmentStatusDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason, 'SESSION'),
      });
    });
    return this.get(user, id);
  }

  /**
   * NOLON's checks of the move against the shipment as it is now (checked again on approval).
   * While the draft misses its shipment or status, those of the values present: null when they
   * pass (it waits for the rest: missingFields).
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const { shipmentId, status } = draft;
    if (shipmentId === null || status === null) {
      const present = await checkDraft(async () => {
        await this.shipments.checkStatusPresent(user, shipmentId, draft);
        return { total: null, currency: null };
      });
      return present.ok ? null : present;
    }
    return checkDraft(async () => {
      await this.shipments.prepareStatusChange(user, shipmentId, { ...draft, status });
      return { total: null, currency: null };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.shipmentStatusDraft.findFirst({
      where: { id, ...this.scope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Shipment status draft not found');
    return draft;
  }
}

/** The permissions a status change to `status` needs: any one of them. */
function canMove(user: AuthUser, status: ShipmentStatus): boolean {
  return permissionForTransition(status).some((p) => user.permissions.has(p));
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: 1,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    missingFields: statusMissingFields(d),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<ShipmentStatusDraftDto, 'request' | 'check' | 'evidence'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const editable = status === 'DRAFT' && !user.agent;
  // Whoever could make the move decides on it; with no status yet, anyone who sees the draft
  // may fill it in, and the approval waits for it (422).
  const open = editable && (d.status === null || canMove(user, d.status));
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
    actions: { canEdit: editable, canDecide: open },
    missingFields: statusMissingFields(d),
    shipmentId: d.shipmentId,
    shipmentNumber: d.shipment?.number ?? null,
    currentStatus: d.shipment?.status ?? null,
    locationName: d.location?.nameEn ?? null,
  };
}
