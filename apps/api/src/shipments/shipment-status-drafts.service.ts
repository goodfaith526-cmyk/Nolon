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
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { evidenceHashPart, evidenceOf, requireConfirmed } from '../drafts/draft-evidence.js';
import {
  approvedFields,
  checkDraft,
  draftExpiry,
  draftStatus,
  preCheck,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  decideInTx,
  DraftsService,
  keyReused,
  lockReplacedInTx,
  mineWhere,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  replacementParentIds,
  storedDraftUnderKey,
  valuesOf,
  withReplaced,
  withReplacedBy,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
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

export function statusRequestOf(d: DraftRow): ShipmentStatusDraftRequest {
  return { status: d.status, locationId: d.locationId, note: d.note };
}

/** sha256 of the normalised request and the staff member's words (shipment included): ids lower case. */
export function statusRequestHash(
  shipmentId: string,
  input: ShipmentStatusDraftRequest,
  evidence: readonly DraftEvidence[] = [],
): string {
  return requestHash({
    ...evidenceHashPart(evidence),
    shipmentId: shipmentId.toLowerCase(),
    status: input.status,
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
    const { shipmentId, evidence = [], ...input } = valuesOf(body);
    return preCheck(statusRequestHash(shipmentId, input, evidence), async () => {
      await this.shipments.prepareStatusChange(user, shipmentId, input);
    });
  }

  async create(
    user: AuthUser,
    body: ShipmentStatusDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, shipmentId, evidence = [], ...input } = body;
    const hash = withReplaced(statusRequestHash(shipmentId, input, evidence), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'shipment_status_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real status change that need no lock; nothing is written.
    const prepared = await this.shipments.prepareStatusChange(user, shipmentId, input);
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
        const existing = await tx.shipmentStatusDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.shipmentStatusDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId: prepared.branchId,
            shipmentId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
            status: input.status,
            locationId: input.locationId ?? null,
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
    const draft = await this.prisma.shipmentStatusDraft.findFirst({
      where: {
        agentClientId,
        createdById: user.id,
        idempotencyKey,
        shipment: this.shipments.visibleWhere(user),
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
  ): Promise<ShipmentStatusDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.shipmentStatusDraft.findMany({
      where: {
        shipment: this.shipments.visibleWhere(user),
        ...stateFilter(status, now),
        ...(mine ? mineWhere(user, mine) : {}),
      },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: mine?.limit ?? 200,
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
        d.status === 'APPROVED'
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
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const request = statusRequestOf(current);
    await this.shipments.prepareStatusChange(user, current.shipmentId, request);
    await this.prisma.$transaction(async (tx) => {
      const decided = await decideInTx(tx, {
        table: 'shipment_status_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        lockParents: async () => {
          await this.shipments.lockForChildWrite(tx, current.shipmentId, { exclusive: true });
        },
        record: async () => {
          await this.shipments.changeStatusInTx(tx, user, current.shipmentId, request);
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
    // Whoever could make the move decides on it.
    if (!canMove(user, current.status)) {
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

  /** NOLON's checks of the move against the shipment as it is now (checked again on approval). */
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      await this.shipments.prepareStatusChange(user, draft.shipmentId, statusRequestOf(draft));
      return { total: null, currency: null };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.shipmentStatusDraft.findFirst({
      where: { id, shipment: this.shipments.visibleWhere(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Shipment status draft not found');
    return draft;
  }
}

/** The permissions a status change to `status` needs: any one of them. */
function canMove(user: AuthUser, status: ShipmentStatusDraftRequest['status']): boolean {
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
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<ShipmentStatusDraftDto, 'request' | 'check' | 'evidence'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && canMove(user, d.status);
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: d.shipment.number,
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedFromAssistant: d.decidedVia === 'ASSISTANT',
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: false, canDecide: open },
    shipmentId: d.shipmentId,
    shipmentNumber: d.shipment.number,
    currentStatus: d.shipment.status,
    locationName: d.location?.nameEn ?? null,
  };
}
