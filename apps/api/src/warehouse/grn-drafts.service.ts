import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type GoodsReceiptRequest,
  type GrnDraftDto,
  type GrnDraftLineDto,
  type GrnDraftLineField,
  type GrnDraftLineInput,
  type GrnDraftSummaryDto,
  type GrnDraftTotals,
  type GrnDraftWarning,
  type GrnFieldMatch,
  type DraftPreCheckDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { type Decimal, dec, toDecimalStringOrNull } from '../common/money.js';
import { DocumentsService } from '../documents/documents.service.js';
import {
  draftExpiry,
  metaJson,
  preCheck,
  proposalRetainedUntil,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  DraftsService,
  MY_DRAFTS_ORDER,
  type MyDraftRow,
  type MyDraftsQuery,
  keyReused,
  lockDraftRow,
  lockKeyInTx,
  mineWhere,
  pageWhere,
  type ReviewDraftRow,
  type ReviewPage,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { shipmentScope } from '../shipments/shipment-scope.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive } from '../shipments/state-machine.js';
import {
  type FieldMeta,
  type StoredLineValues,
  type StoredTotals,
  draftStatus,
  draftWarnings,
  lineTotals,
  metaAfterEdit,
  metaForAiLine,
  payloadHash,
  reportedWarnings,
  storedValues,
} from './grn-draft-rules.js';
import { WarehouseMovementsService } from './warehouse-movements.service.js';

type Tx = Prisma.TransactionClient;

const LABEL = 'GRN draft';
const ASSISTANT_ONLY = 'GRN drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can change a GRN draft';

export interface GrnDraftCreateInput {
  idempotencyKey: string;
  documentId: string;
  documentSha256: string;
  statedTotals: {
    packages: number | null;
    grossKg: string | null;
    netKg: string | null;
    cbm: string | null;
  };
  warnings: GrnDraftWarning[];
  lines: (GrnDraftLineInput & { match?: Partial<Record<GrnDraftLineField, GrnFieldMatch>> })[];
}

export interface GrnDraftUpdateInput {
  version: number;
  lines: (GrnDraftLineInput & { lineNo?: number })[];
}

const draftDetails = {
  lines: { orderBy: { lineNo: 'asc' } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  movement: { select: { number: true } },
} satisfies Prisma.GrnDraftInclude;

type DraftWithDetails = Prisma.GrnDraftGetPayload<{ include: typeof draftDetails }>;
type DraftLineRow = DraftWithDetails['lines'][number];

/** A draft row as locked for a change (SELECT ... FOR UPDATE), with its source document. */
interface LockedDraft {
  id: string;
  state: 'DRAFT' | 'APPROVED' | 'REJECTED';
  version: number;
  expiresAt: Date;
  documentId: string;
  documentSha256: string;
}

/**
 * Draft goods received notes proposed by the staff AI assistant from a packing list (Document
 * Pilot, erp-agents docs/packing-list-grn-drafts.md). The assistant may only create a draft
 * (@AgentDraftWritable); reading, editing, approving and rejecting are a person's, with their own
 * session. Access follows the shipment (404 when the user cannot see it).
 *
 * Lock order, the same on every path that changes a draft: the shipment row first
 * (ShipmentsService.lockForChildWrite, as receipts do), then the draft row. An approval records the
 * goods receipt with WarehouseMovementsService.receiveInTx in the same transaction, so the GRN and
 * the approved draft commit or roll back together.
 */
@Injectable()
export class GrnDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly documents: DocumentsService,
    private readonly movements: WarehouseMovementsService,
    private readonly drafts: DraftsService,
  ) {}

  /**
   * The pre-check: what `create` checks for these values, for this user now (the shipment visible
   * and active, the document a packing list of it with those bytes); nothing is written. Like the
   * create, only the assistant asks it.
   */
  async checkValues(
    user: AuthUser,
    shipmentId: string,
    body: GrnDraftCreateInput,
  ): Promise<DraftPreCheckDto> {
    await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    return preCheck(grnRequest(body).hash, async () => {
      const shipment = await this.shipments.childContext(user, shipmentId);
      if (!isActive(shipment.status)) throw shipmentClosed();
      await this.documents.requirePackingList(
        this.prisma,
        shipmentId,
        body.documentId,
        body.documentSha256,
      );
    });
  }

  /**
   * "My drafts": the GRN drafts the assistant made for this user, on shipments the user sees now.
   * Each is reviewed on its shipment's page.
   */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('warehouse:view')) return [];
    const now = new Date();
    const drafts = await this.prisma.grnDraft.findMany({
      where: {
        shipment: shipmentScope(user),
        ...stateFilter(query.status, now),
        ...mineWhere(user, query),
      },
      include: { ...draftDetails, shipment: { select: { number: true } } },
      orderBy: MY_DRAFTS_ORDER,
      take: query.limit,
    });
    return drafts.map((d) => ({
      kind: 'grn',
      id: d.id,
      status: draftStatus(d.state, d.expiresAt, now),
      subject: d.shipment.number,
      branchId: d.branchId,
      createdAt: d.createdAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
      decidedAt: d.decidedAt?.toISOString() ?? null,
      decidedByName: d.decidedBy?.fullName ?? null,
      rejectReason: d.rejectReason,
      reviewPath: `/shipments/${d.shipmentId}`,
      result:
        d.movementId === null
          ? null
          : {
              type: 'warehouse_movement',
              id: d.movementId,
              number: d.movement?.number ?? null,
              path: `/shipments/${d.shipmentId}`,
            },
    }));
  }

  /**
   * The reviewers' list ("everything waiting"): open GRN drafts on shipments this person sees now,
   * whoever they were made for, when they may record a receipt (warehouse:create); each is
   * reviewed on its shipment's page. None for the assistant.
   */
  async reviewList(user: AuthUser, page: ReviewPage): Promise<ReviewDraftRow[]> {
    const p = user.permissions;
    if (user.agent || !p.has('warehouse:view') || !p.has('warehouse:create')) return [];
    const now = new Date();
    const drafts = await this.prisma.grnDraft.findMany({
      where: {
        shipment: shipmentScope(user),
        ...stateFilter('DRAFT', now),
        ...pageWhere(page),
      },
      include: {
        createdBy: { select: { fullName: true } },
        shipment: { select: { number: true } },
      },
      orderBy: MY_DRAFTS_ORDER,
      take: page.limit,
    });
    return drafts.map((d) => ({
      kind: 'grn',
      id: d.id,
      subject: d.shipment.number,
      branchId: d.branchId,
      createdAt: d.createdAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
      createdByName: d.createdBy.fullName,
      missingCount: null,
      reviewPath: `/shipments/${d.shipmentId}`,
      canDecide: true,
    }));
  }

  /**
   * The assistant proposes a draft. Everything is authorised before the idempotency key is looked
   * up: the token's user sees the shipment, the shipment is active, and the document is a packing
   * list of that shipment with those bytes. Then: no draft under the key creates one; a draft for
   * the same shipment, document and request returns it; anything else is a 409 that reveals
   * nothing about the stored draft. The key is scoped to the assistant client and the user.
   */
  async create(
    user: AuthUser,
    shipmentId: string,
    input: GrnDraftCreateInput,
  ): Promise<GrnDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const shipment = await this.shipments.childContext(user, shipmentId);
    if (!isActive(shipment.status)) throw shipmentClosed();
    const { lines, statedTotals, hash } = grnRequest(input);
    // Only what the assistant reports about the file is stored; the rest is worked out on read.
    const warnings = reportedWarnings(input.warnings);
    const scope = { agentClientId, createdById: user.id, idempotencyKey: input.idempotencyKey };
    const sameRequest = (row: {
      shipmentId: string;
      documentId: string;
      documentSha256: string;
      payloadHash: string;
    }) =>
      row.shipmentId === shipmentId &&
      row.documentId === input.documentId &&
      row.documentSha256 === input.documentSha256 &&
      row.payloadHash === hash;

    const attempt = () =>
      this.prisma.$transaction(async (tx) => {
        const status = await this.shipments.lockForChildWrite(tx, shipmentId);
        if (!isActive(status)) throw shipmentClosed();
        await this.documents.requirePackingList(
          tx,
          shipmentId,
          input.documentId,
          input.documentSha256,
        );
        await lockKeyInTx(tx, 'grn_drafts', scope);
        const existing = await tx.grnDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: {
            id: true,
            shipmentId: true,
            documentId: true,
            documentSha256: true,
            payloadHash: true,
          },
        });
        if (existing) {
          if (!sameRequest(existing)) throw keyReused();
          return existing.id;
        }
        const expiresAt = draftExpiry();
        const draft = await tx.grnDraft.create({
          data: {
            ...scope,
            branchId: shipment.branchId,
            shipmentId,
            documentId: input.documentId,
            documentSha256: input.documentSha256,
            expiresAt,
            payloadHash: hash,
            statedPackages: statedTotals.packages,
            statedGrossKg: statedTotals.grossKg,
            statedNetKg: statedTotals.netKg,
            statedCbm: statedTotals.cbm,
            warnings,
          },
          select: { id: true },
        });
        // The proposal as the assistant made it, kept as a record whatever a person edits later.
        await tx.grnDraftProposal.create({
          data: {
            draftId: draft.id,
            branchId: shipment.branchId,
            retainUntil: proposalRetainedUntil(expiresAt),
            lines: lines.map((line) => ({
              ...lineDto(line.lineNo, line.values, line, line.meta),
              fields: metaJson(line.meta),
            })),
          },
        });
        await tx.grnDraftLine.createMany({
          data: lines.map((line) => ({
            draftId: draft.id,
            lineNo: line.lineNo,
            branchId: shipment.branchId,
            ...line.values,
            sourcePage: line.sourcePage,
            sourceRow: line.sourceRow,
            fieldMeta: metaJson(line.meta),
          })),
        });
        return draft.id;
      });

    const id = await this.drafts.createIdempotently(attempt);
    return toSummary(await this.findDraft(user, shipmentId, id), new Date());
  }

  /**
   * The assistant recovers the draft it created under a key (after a crash between its model call
   * and its create), with the same checks as create: the shipment visible, the source packing
   * list still there. Only the assistant client and the user that created it find it.
   */
  async findByKey(
    user: AuthUser,
    shipmentId: string,
    idempotencyKey: string,
  ): Promise<GrnDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    await this.shipments.childContext(user, shipmentId);
    const draft = await this.prisma.grnDraft.findFirst({
      where: {
        agentClientId,
        createdById: user.id,
        idempotencyKey,
        shipmentId,
        shipment: shipmentScope(user),
      },
      include: draftDetails,
    });
    if (!draft) throw new NotFoundException('GRN draft not found');
    await this.documents.requirePackingList(
      this.prisma,
      shipmentId,
      draft.documentId,
      draft.documentSha256,
    );
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, shipmentId: string): Promise<GrnDraftSummaryDto[]> {
    await this.shipments.requireAccessible(user, shipmentId);
    const drafts = await this.prisma.grnDraft.findMany({
      where: { shipmentId, shipment: shipmentScope(user) },
      include: draftDetails,
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    return drafts.map((d) => toSummary(d, now));
  }

  async get(user: AuthUser, shipmentId: string, draftId: string): Promise<GrnDraftDto> {
    await this.shipments.requireAccessible(user, shipmentId);
    return this.toDto(await this.findDraft(user, shipmentId, draftId), user);
  }

  /**
   * A person replaces the lines. A value left as it was keeps who filled it and its match; a
   * value typed or changed becomes the person's.
   */
  async update(
    user: AuthUser,
    shipmentId: string,
    draftId: string,
    input: GrnDraftUpdateInput,
  ): Promise<GrnDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    await this.prisma.$transaction(async (tx) => {
      await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      const draft = await this.lockOpenDraft(tx, user, shipmentId, draftId, input.version);
      const before = await tx.grnDraftLine.findMany({ where: { draftId: draft.id } });
      const byNo = new Map(before.map((row) => [row.lineNo, row]));
      const lines = input.lines.map((line, i) => {
        const values = storedValues(line);
        const previous = line.lineNo === undefined ? undefined : byNo.get(line.lineNo);
        return {
          draftId: draft.id,
          lineNo: i + 1,
          branchId: shipment.branchId,
          ...values,
          sourcePage: previous ? previous.sourcePage : (line.sourcePage ?? null),
          sourceRow: previous ? previous.sourceRow : (line.sourceRow ?? null),
          fieldMeta: metaJson(
            metaAfterEdit(
              previous && { values: rowValues(previous), meta: rowMeta(previous) },
              values,
            ),
          ),
        };
      });
      await tx.grnDraftLine.deleteMany({ where: { draftId: draft.id } });
      await tx.grnDraftLine.createMany({ data: lines });
      await tx.grnDraft.update({
        where: { id: draft.id },
        data: { version: { increment: 1 } },
      });
    });
    return this.get(user, shipmentId, draftId);
  }

  /**
   * A person approves the draft: records the goods receipt they entered (warehouse, packages,
   * condition...) through the normal receipt path, in the same transaction as the approval. The
   * source packing list must still be there with the same bytes. Approving an approved draft
   * returns it as it is, without a second receipt.
   */
  async approve(
    user: AuthUser,
    shipmentId: string,
    draftId: string,
    input: GoodsReceiptRequest & { version: number },
  ): Promise<GrnDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const { version, ...receipt } = input;
    // Already approved: return it as it is, even if the shipment has moved on since.
    const current = await this.findDraft(user, shipmentId, draftId);
    if (current.state === 'APPROVED') return this.toDto(current, user);
    const prepared = await this.movements.prepareReceipt(user, shipmentId, receipt);
    await this.prisma.$transaction(async (tx) => {
      await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      const draft = await this.lockDraft(tx, user, shipmentId, draftId);
      if (draft.state === 'APPROVED') return;
      requireOpen(draft, version, LABEL);
      await this.documents
        .requirePackingList(tx, shipmentId, draft.documentId, draft.documentSha256)
        .catch((error: unknown) => {
          if (error instanceof NotFoundException) {
            throw new ConflictException('The source packing list was deleted or changed');
          }
          throw error;
        });
      const movementId = await this.movements.receiveInTx(tx, user, prepared, receipt);
      await tx.grnDraft.update({
        where: { id: draft.id },
        data: {
          state: 'APPROVED',
          movementId,
          decidedById: user.id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, shipmentId, draftId);
  }

  async reject(
    user: AuthUser,
    shipmentId: string,
    draftId: string,
    input: { version: number; reason: string },
  ): Promise<GrnDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.shipments.requireAccessible(user, shipmentId);
    await this.prisma.$transaction(async (tx) => {
      await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      const draft = await this.lockOpenDraft(tx, user, shipmentId, draftId, input.version);
      await tx.grnDraft.update({
        where: { id: draft.id },
        data: {
          state: 'REJECTED',
          rejectReason: input.reason,
          decidedById: user.id,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, shipmentId, draftId);
  }

  private async lockDraft(
    tx: Tx,
    user: AuthUser,
    shipmentId: string,
    draftId: string,
  ): Promise<LockedDraft> {
    // Visibility first, through the shipment scope, then the row lock.
    const visible = await tx.grnDraft.findFirst({
      where: { id: draftId, shipmentId, shipment: shipmentScope(user) },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('GRN draft not found');
    const row = await lockDraftRow(tx, 'grn_drafts', draftId);
    if (!row) throw new NotFoundException('GRN draft not found');
    // The source document of a locked row cannot change under us.
    const source = await tx.grnDraft.findUniqueOrThrow({
      where: { id: draftId },
      select: { documentId: true, documentSha256: true },
    });
    return { ...row, ...source };
  }

  private async lockOpenDraft(
    tx: Tx,
    user: AuthUser,
    shipmentId: string,
    draftId: string,
    version: number,
  ): Promise<LockedDraft> {
    const draft = await this.lockDraft(tx, user, shipmentId, draftId);
    requireOpen(draft, version, LABEL);
    return draft;
  }

  /** The draft with the assistant's proposal, read from its record. */
  private async toDto(draft: DraftWithDetails, user: AuthUser): Promise<GrnDraftDto> {
    const proposal = await this.prisma.grnDraftProposal.findUnique({
      where: { draftId: draft.id },
      select: { lines: true },
    });
    return toDto(draft, proposal, user, new Date());
  }

  private async findDraft(
    user: AuthUser,
    shipmentId: string,
    id: string,
  ): Promise<DraftWithDetails> {
    const draft = await this.prisma.grnDraft.findFirst({
      where: { id, shipmentId, shipment: shipmentScope(user) },
      include: draftDetails,
    });
    if (!draft) throw new NotFoundException('GRN draft not found');
    return draft;
  }
}

function decimalOrNull(value: string | null): Decimal | null {
  return value === null ? null : dec(value);
}

function rowValues(row: DraftLineRow): StoredLineValues {
  return {
    marks: row.marks,
    description: row.description,
    packageCount: row.packageCount,
    packageType: row.packageType,
    quantity: row.quantity,
    unit: row.unit,
    grossKg: row.grossKg,
    netKg: row.netKg,
    cbm: row.cbm,
  };
}

/** field_meta is only ever written by this service, from validated values. */
function rowMeta(row: DraftLineRow): FieldMeta {
  return row.fieldMeta as FieldMeta;
}

function statedTotals(d: DraftWithDetails): StoredTotals {
  return {
    packages: d.statedPackages,
    grossKg: d.statedGrossKg,
    netKg: d.statedNetKg,
    cbm: d.statedCbm,
  };
}

function totalsDto(t: StoredTotals): GrnDraftTotals {
  return {
    packages: t.packages,
    grossKg: toDecimalStringOrNull(t.grossKg),
    netKg: toDecimalStringOrNull(t.netKg),
    cbm: toDecimalStringOrNull(t.cbm),
  };
}

function toSummary(d: DraftWithDetails, now: Date): GrnDraftSummaryDto {
  return {
    id: d.id,
    shipmentId: d.shipmentId,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.lines.length,
    lineTotals: totalsDto(lineTotals(d.lines.map(rowValues))),
    warnings: draftWarnings(d.warnings, statedTotals(d), d.lines.map(rowValues)),
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

function lineDto(
  lineNo: number,
  values: StoredLineValues,
  source: { sourcePage: number | null; sourceRow: number | null },
  meta: FieldMeta,
): GrnDraftLineDto {
  return {
    lineNo,
    marks: values.marks,
    description: values.description,
    packageCount: values.packageCount,
    packageType: values.packageType,
    quantity: toDecimalStringOrNull(values.quantity),
    unit: values.unit,
    grossKg: toDecimalStringOrNull(values.grossKg),
    netKg: toDecimalStringOrNull(values.netKg),
    cbm: toDecimalStringOrNull(values.cbm),
    sourcePage: source.sourcePage,
    sourceRow: source.sourceRow,
    fields: meta,
  };
}

function toLineDto(row: DraftLineRow): GrnDraftLineDto {
  return lineDto(row.lineNo, rowValues(row), row, rowMeta(row));
}

/** grn_draft_proposals.lines is only ever written by create, as GrnDraftLineDto objects. */
function proposedLines(proposal: { lines: Prisma.JsonValue } | null): GrnDraftLineDto[] | null {
  return proposal ? (proposal.lines as unknown as GrnDraftLineDto[]) : null;
}

function toDto(
  d: DraftWithDetails,
  proposal: { lines: Prisma.JsonValue } | null,
  user: AuthUser,
  now: Date,
): GrnDraftDto {
  const summary = toSummary(d, now);
  const open = summary.status === 'DRAFT' && user.permissions.has('warehouse:create');
  return {
    ...summary,
    documentId: d.documentId,
    statedTotals: totalsDto(statedTotals(d)),
    lines: d.lines.map(toLineDto),
    proposedLines: proposedLines(proposal),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    movementId: d.movementId,
    movementNumber: d.movement?.number ?? null,
    actions: { canEdit: open && !user.agent, canDecide: open && !user.agent },
  };
}

function shipmentClosed(): ConflictException {
  return new ConflictException('A closed or cancelled shipment takes no GRN draft');
}

/** A create request as stored: its lines numbered, its totals as decimals, and its hash. */
function grnRequest(input: GrnDraftCreateInput) {
  const lines = input.lines.map((line, i) => {
    const values = storedValues(line);
    return {
      lineNo: i + 1,
      values,
      sourcePage: line.sourcePage ?? null,
      sourceRow: line.sourceRow ?? null,
      meta: metaForAiLine(values, line.match),
    };
  });
  const statedTotals: StoredTotals = {
    packages: input.statedTotals.packages,
    grossKg: decimalOrNull(input.statedTotals.grossKg),
    netKg: decimalOrNull(input.statedTotals.netKg),
    cbm: decimalOrNull(input.statedTotals.cbm),
  };
  const hash = payloadHash({
    documentId: input.documentId,
    documentSha256: input.documentSha256,
    statedTotals,
    warnings: [...new Set(input.warnings)],
    lines,
  });
  return { lines, statedTotals, hash };
}
