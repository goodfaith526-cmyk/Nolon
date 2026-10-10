import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GRN_DRAFT_TTL_DAYS,
  type GoodsReceiptRequest,
  type GrnDraftDto,
  type GrnDraftLineDto,
  type GrnDraftLineField,
  type GrnDraftLineInput,
  type GrnDraftSummaryDto,
  type GrnDraftTotals,
  type GrnDraftWarning,
  type GrnFieldMatch,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { type Decimal, dec, toDecimalStringOrNull } from '../common/money.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { DocumentsService } from '../documents/documents.service.js';
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
  lineTotals,
  metaAfterEdit,
  metaForAiLine,
  payloadHash,
  storedValues,
} from './grn-draft-rules.js';
import { WarehouseMovementsService } from './warehouse-movements.service.js';

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** A draft row as locked for a change (SELECT ... FOR UPDATE). */
interface LockedDraft {
  id: string;
  state: 'DRAFT' | 'APPROVED' | 'REJECTED';
  version: number;
  expires_at: Date;
  document_id: string;
  document_sha256: string;
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
  ) {}

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
    const agentClientId = await this.agentClientOf(user);
    const shipment = await this.shipments.childContext(user, shipmentId);
    if (!isActive(shipment.status)) {
      throw new ConflictException('A closed or cancelled shipment takes no GRN draft');
    }
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
    const warnings = [...new Set(input.warnings)];
    const hash = payloadHash({
      documentId: input.documentId,
      documentSha256: input.documentSha256,
      statedTotals,
      warnings,
      lines,
    });
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
        if (!isActive(status)) {
          throw new ConflictException('A closed or cancelled shipment takes no GRN draft');
        }
        await this.documents.requirePackingList(
          tx,
          shipmentId,
          input.documentId,
          input.documentSha256,
        );
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
        const draft = await tx.grnDraft.create({
          data: {
            ...scope,
            branchId: shipment.branchId,
            shipmentId,
            documentId: input.documentId,
            documentSha256: input.documentSha256,
            expiresAt: new Date(Date.now() + GRN_DRAFT_TTL_DAYS * DAY_MS),
            payloadHash: hash,
            statedPackages: statedTotals.packages,
            statedGrossKg: statedTotals.grossKg,
            statedNetKg: statedTotals.netKg,
            statedCbm: statedTotals.cbm,
            warnings,
          },
          select: { id: true },
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

    let id: string;
    try {
      id = await attempt();
    } catch (error) {
      // A concurrent create with the same key inserted first: this one now finds it.
      if (!isUniqueViolation(error)) throw error;
      id = await attempt();
    }
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
    const agentClientId = await this.agentClientOf(user);
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
    return toDto(await this.findDraft(user, shipmentId, draftId), user, new Date());
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
    this.requireHuman(user);
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
    this.requireHuman(user);
    const { version, ...receipt } = input;
    // Already approved: return it as it is, even if the shipment has moved on since.
    const current = await this.findDraft(user, shipmentId, draftId);
    if (current.state === 'APPROVED') return toDto(current, user, new Date());
    const prepared = await this.movements.prepareReceipt(user, shipmentId, receipt);
    await this.prisma.$transaction(async (tx) => {
      await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      const draft = await this.lockDraft(tx, user, shipmentId, draftId);
      if (draft.state === 'APPROVED') return;
      requireOpen(draft, version);
      await this.documents
        .requirePackingList(tx, shipmentId, draft.document_id, draft.document_sha256)
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
    this.requireHuman(user);
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

  /** The assistant client a delegated token belongs to; drafts are created by the assistant only. */
  private async agentClientOf(user: AuthUser): Promise<string> {
    if (!user.agent) throw new ForbiddenException('GRN drafts are proposed by the assistant');
    const token = await this.prisma.agentToken.findUnique({
      where: { id: user.agent.tokenId },
      select: { agentClientId: true },
    });
    if (!token) throw new ForbiddenException('GRN drafts are proposed by the assistant');
    return token.agentClientId;
  }

  /**
   * Edits and decisions are a person's. The guard already refuses assistant tokens on these
   * routes; this keeps the rule if a route is ever opened by mistake.
   */
  private requireHuman(user: AuthUser): void {
    if (user.agent) throw new ForbiddenException('Only a person can change a GRN draft');
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
    const rows = await tx.$queryRaw<LockedDraft[]>`
      SELECT "id", "state"::text AS "state", "version", "expires_at", "document_id",
             "document_sha256"
      FROM "grn_drafts" WHERE "id" = ${draftId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundException('GRN draft not found');
    return row;
  }

  private async lockOpenDraft(
    tx: Tx,
    user: AuthUser,
    shipmentId: string,
    draftId: string,
    version: number,
  ): Promise<LockedDraft> {
    const draft = await this.lockDraft(tx, user, shipmentId, draftId);
    requireOpen(draft, version);
    return draft;
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

function keyReused(): ConflictException {
  return new ConflictException('This idempotency key was used for another request');
}

/** An undecided, unexpired draft at the version the person read. */
function requireOpen(draft: LockedDraft, version: number): void {
  const status = draftStatus(draft.state, draft.expires_at, new Date());
  if (status === 'EXPIRED') throw new ConflictException('This GRN draft has expired');
  if (status !== 'DRAFT') throw new ConflictException('This GRN draft is already decided');
  if (draft.version !== version) {
    throw new ConflictException('This GRN draft changed since you opened it: reload it');
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

/** The field metadata as a JSON object (only the fields that hold a value). */
function metaJson(meta: FieldMeta): Prisma.InputJsonObject {
  const json: Record<string, Prisma.InputJsonObject> = {};
  for (const [field, entry] of Object.entries(meta)) {
    if (entry) json[field] = { filledBy: entry.filledBy, match: entry.match };
  }
  return json;
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
    warnings: d.warnings as GrnDraftWarning[],
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

function toLineDto(row: DraftLineRow): GrnDraftLineDto {
  return {
    lineNo: row.lineNo,
    marks: row.marks,
    description: row.description,
    packageCount: row.packageCount,
    packageType: row.packageType,
    quantity: toDecimalStringOrNull(row.quantity),
    unit: row.unit,
    grossKg: toDecimalStringOrNull(row.grossKg),
    netKg: toDecimalStringOrNull(row.netKg),
    cbm: toDecimalStringOrNull(row.cbm),
    sourcePage: row.sourcePage,
    sourceRow: row.sourceRow,
    fields: rowMeta(row),
  };
}

function toDto(d: DraftWithDetails, user: AuthUser, now: Date): GrnDraftDto {
  const summary = toSummary(d, now);
  const open = summary.status === 'DRAFT' && user.permissions.has('warehouse:create');
  return {
    ...summary,
    documentId: d.documentId,
    statedTotals: totalsDto({
      packages: d.statedPackages,
      grossKg: d.statedGrossKg,
      netKg: d.statedNetKg,
      cbm: d.statedCbm,
    }),
    lines: d.lines.map(toLineDto),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    movementId: d.movementId,
    movementNumber: d.movement?.number ?? null,
    actions: { canEdit: open && !user.agent, canDecide: open && !user.agent },
  };
}
