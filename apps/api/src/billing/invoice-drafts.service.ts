import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  InvoiceDraftCreateRequest,
  InvoiceDraftDto,
  InvoiceDraftListItemDto,
  InvoiceDraftRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
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
import { InvoicesService } from './invoices.service.js';

const LABEL = 'invoice draft';
const ASSISTANT_ONLY = 'Invoice drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on an invoice draft';

const details = {
  lines: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  shipment: { select: { number: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  invoice: { select: { number: true } },
} satisfies Prisma.InvoiceDraftInclude;

type DraftRow = Prisma.InvoiceDraftGetPayload<{ include: typeof details }>;

/** The invoice a stored draft proposes, as InvoicesService.prepareForShipment takes it. */
export function invoiceRequestOf(d: DraftRow): InvoiceDraftRequest {
  return {
    shipmentId: d.shipmentId,
    currency: d.currency,
    invoiceDate: fromDbDate(d.invoiceDate),
    dueDate: fromDbDate(d.dueDate),
    notes: d.notes,
    lines: d.lines.map((l) => ({
      chargeTypeCode: l.chargeTypeCode,
      description: l.description,
      quantity: toDecimalString(l.quantity),
      unitPrice: toDecimalString(l.unitPrice),
    })),
  };
}

/** sha256 of the normalised request: ids lower case, decimals canonical, null for absent. */
export function invoiceRequestHash(input: InvoiceDraftRequest): string {
  return requestHash({
    shipmentId: input.shipmentId.toLowerCase(),
    currency: input.currency,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    notes: input.notes ?? null,
    lines: input.lines.map((l) => ({
      chargeTypeCode: l.chargeTypeCode,
      description: l.description ?? null,
      quantity: decimalKey(dec(l.quantity)),
      unitPrice: decimalKey(dec(l.unitPrice)),
    })),
  });
}

/**
 * Customer invoice drafts proposed by the staff AI assistant (entry drafts, src/drafts). A person
 * approves a draft, which creates an ordinary DRAFT invoice for the shipment through
 * InvoicesService in the same transaction, with their permissions and branches; nothing is posted
 * until that invoice is itself approved in NOLON. Access follows the shipment's owning branch, as
 * invoices do.
 */
@Injectable()
export class InvoiceDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly drafts: DraftsService,
  ) {}

  async create(user: AuthUser, body: InvoiceDraftCreateRequest): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, shipmentId, ...input } = body;
    // The checks of a real draft invoice; nothing is written.
    const prepared = await this.invoices.prepareForShipment(user, shipmentId, input);
    const hash = invoiceRequestHash({ shipmentId, ...input });
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.invoiceDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        const draft = await tx.invoiceDraft.create({
          data: {
            ...scope,
            branchId: prepared.branchId,
            shipmentId: prepared.shipmentId,
            customerId: prepared.customerId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            currency: prepared.currency,
            invoiceDate: toDbDate(input.invoiceDate),
            dueDate: toDbDate(input.dueDate),
            notes: input.notes ?? null,
          },
          select: { id: true },
        });
        await tx.invoiceDraftLine.createMany({
          data: prepared.lines.map((l, i) => ({
            draftId: draft.id,
            lineNo: i + 1,
            chargeTypeCode: l.chargeTypeCode,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.invoiceDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Invoice draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<InvoiceDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.invoiceDraft.findMany({
      where: { ...branchScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: d.lines.length }));
  }

  async get(user: AuthUser, id: string): Promise<InvoiceDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return { ...baseFields(draft, user, now), request: invoiceRequestOf(draft), check };
  }

  /**
   * A person approves the version they reviewed: a DRAFT invoice is created in the same
   * transaction as the approval. Approving an approved draft returns it as it is.
   */
  async approve(user: AuthUser, id: string, version: number): Promise<InvoiceDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    const { shipmentId, ...input } = invoiceRequestOf(current);
    const prepared = await this.invoices.prepareForShipment(user, shipmentId, input);
    await this.prisma.$transaction(async (tx) => {
      let invoiceId = '';
      const decided = await decideInTx(tx, {
        table: 'invoice_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        record: async () => {
          invoiceId = await this.invoices.insertInTx(tx, user, prepared);
        },
      });
      if (decided) {
        await tx.invoiceDraft.update({
          where: { id },
          data: { ...approvedFields(user), invoiceId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<InvoiceDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'invoice_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.invoiceDraft.update({ where: { id }, data: rejectedFields(user, input.reason) });
    });
    return this.get(user, id);
  }

  /** NOLON's checks of the invoice now, and its total as NOLON rounds it. */
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      const { shipmentId, ...input } = invoiceRequestOf(draft);
      const prepared = await this.invoices.prepareForShipment(user, shipmentId, input);
      return { total: toDecimalString(prepared.total), currency: prepared.currency };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.invoiceDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Invoice draft not found');
    return draft;
  }
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.lines.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<InvoiceDraftDto, 'request' | 'check'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open =
    status === 'DRAFT' && !user.agent && user.permissions.has('customer_invoices:create');
  return {
    id: d.id,
    branchId: d.branchId,
    customerId: d.customerId,
    customerName: d.customer.name,
    subject: `${d.shipment.number} · ${d.customer.name}`,
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: false, canDecide: open },
    shipmentNumber: d.shipment.number,
    invoiceId: d.invoiceId,
    invoiceNumber: d.invoice?.number ?? null,
  };
}
