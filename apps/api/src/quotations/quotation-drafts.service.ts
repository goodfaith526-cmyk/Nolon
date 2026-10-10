import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AssistantDraftApproveRequest,
  AssistantDraftDto,
  CreateQuotationRequest,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  QuotationDraftCreateRequest,
  QuotationDraftDto,
  QuotationDraftListItemDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import {
  decimalKey,
  draftExpiry,
  draftStatus,
  requestHash,
  requireOpen,
  resolvedKey,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  type DecisionVia,
  DraftsService,
  decidedVia,
  keyReused,
  lockDraftRow,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotationsService } from './quotations.service.js';

const LABEL = 'quotation draft';
const ASSISTANT_ONLY = 'Quotation drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a quotation draft';

const details = {
  lines: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  quotation: { select: { number: true } },
} satisfies Prisma.QuotationDraftInclude;

type DraftRow = Prisma.QuotationDraftGetPayload<{ include: typeof details }>;

/** A create request as stored: decimals as Decimal, absent values as null. */
function storedLines(input: CreateQuotationRequest) {
  return input.lines.map((line, i) => ({
    lineNo: i + 1,
    rateCardId: line.rateCardId ?? null,
    chargeTypeCode: line.chargeTypeCode ?? null,
    description: line.description ?? null,
    unit: line.unit ?? null,
    quantity: dec(line.quantity),
    unitPrice: line.unitPrice === undefined ? null : dec(line.unitPrice),
    discount: line.discount === undefined ? null : dec(line.discount),
  }));
}

/**
 * The request a stored draft proposes, in the shape QuotationsService takes. Values are given back
 * exactly as stored: a draft created from request R reads back as R in canonical form.
 */
export function requestOf(row: {
  customerId: string;
  originLocationId: string;
  destinationLocationId: string;
  mode: CreateQuotationRequest['mode'];
  loadType: CreateQuotationRequest['loadType'];
  cargoType: CreateQuotationRequest['cargoType'];
  cargoDescription: string | null;
  currency: string;
  validUntil: Date;
  terms: string | null;
  lines: ReturnType<typeof storedLines>;
}): CreateQuotationRequest {
  return {
    customerId: row.customerId,
    originLocationId: row.originLocationId,
    destinationLocationId: row.destinationLocationId,
    mode: row.mode,
    loadType: row.loadType ?? null,
    cargoType: row.cargoType,
    cargoDescription: row.cargoDescription,
    currency: row.currency,
    validUntil: fromDbDate(row.validUntil),
    terms: row.terms,
    lines: row.lines.map((l) => ({
      ...(l.rateCardId === null ? {} : { rateCardId: l.rateCardId }),
      ...(l.chargeTypeCode === null ? {} : { chargeTypeCode: l.chargeTypeCode }),
      description: l.description,
      ...(l.unit === null ? {} : { unit: l.unit }),
      quantity: toDecimalString(l.quantity),
      ...(l.unitPrice === null ? {} : { unitPrice: toDecimalString(l.unitPrice) }),
      ...(l.discount === null ? {} : { discount: toDecimalString(l.discount) }),
    })),
  };
}

/** sha256 of the normalised request: decimals canonical, missing and null alike, keys sorted. */
export function quotationRequestHash(input: CreateQuotationRequest): string {
  return requestHash({
    ...input,
    customerId: input.customerId.toLowerCase(),
    originLocationId: input.originLocationId.toLowerCase(),
    destinationLocationId: input.destinationLocationId.toLowerCase(),
    loadType: input.loadType ?? null,
    cargoDescription: input.cargoDescription ?? null,
    terms: input.terms ?? null,
    lines: storedLines(input).map((l) => ({
      ...l,
      rateCardId: l.rateCardId?.toLowerCase() ?? null,
      quantity: decimalKey(l.quantity),
      unitPrice: decimalKey(l.unitPrice),
      discount: decimalKey(l.discount),
    })),
  });
}

/**
 * Quotation drafts proposed by the staff AI assistant (entry drafts, src/drafts). The assistant
 * creates a draft (@AgentDraftWritable) and recovers the one it created under a key; a person
 * reads it, approves it (an ordinary DRAFT quotation is created through QuotationsService in the
 * same transaction, with that person's permissions and branches) or rejects it. Access follows
 * the customer's branch.
 */
@Injectable()
export class QuotationDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotations: QuotationsService,
    private readonly drafts: DraftsService,
  ) {}

  /**
   * Everything is checked before the key is looked up: the request is one NOLON would accept for
   * this user now (customer in their branches, route, rates, currency...). Then: no draft under
   * the key creates one; the same request returns it; anything else is a 409.
   */
  async create(user: AuthUser, body: QuotationDraftCreateRequest): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...input } = body;
    const prepared = await this.quotations.prepareCreate(user, input);
    const hash = quotationRequestHash(input);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.quotationDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        const draft = await tx.quotationDraft.create({
          data: {
            ...scope,
            branchId: prepared.branchId,
            customerId: prepared.customerId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            originLocationId: input.originLocationId,
            destinationLocationId: input.destinationLocationId,
            mode: input.mode,
            loadType: input.loadType ?? null,
            cargoType: input.cargoType,
            cargoDescription: input.cargoDescription ?? null,
            currency: input.currency,
            validUntil: toDbDate(input.validUntil),
            terms: input.terms ?? null,
          },
          select: { id: true },
        });
        await tx.quotationDraftLine.createMany({
          data: storedLines(input).map((line) => ({ ...line, draftId: draft.id })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /** The assistant recovers the draft it created under a key; only that client and user find it. */
  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.quotationDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Quotation draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<QuotationDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.quotationDraft.findMany({
      where: { ...branchScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: d.lines.length }));
  }

  /** The draft, with whether NOLON would accept it now (checked, nothing written). */
  async get(user: AuthUser, id: string): Promise<QuotationDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return toDto(draft, user, now, check);
  }

  /**
   * A person approves the version they reviewed: the quotation is created through
   * QuotationsService with their permissions and branches, in the same transaction as the
   * approval. Approving an approved draft returns it as it is, without a second quotation.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    via: DecisionVia = 'SESSION',
  ): Promise<QuotationDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // The request is the one at `version`; the lock below refuses if it changed since.
    const prepared = await this.quotations.prepareCreate(user, requestOf(current));
    // From the chat: the prices the card showed (rate cards resolved), or a reload.
    this.drafts.requireResolved(via, resolvedKey(prepared), LABEL);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'quotation_drafts', id);
      if (!locked) throw new NotFoundException('Quotation draft not found');
      if (locked.state === 'APPROVED') return;
      requireOpen(locked, version, LABEL);
      const quotation = await this.quotations.insertInTx(tx, user, prepared);
      await tx.quotationDraft.update({
        where: { id },
        data: {
          state: 'APPROVED',
          quotationId: quotation.id,
          decidedById: user.id,
          decidedAt: new Date(),
          decidedVia: decidedVia(via),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  /** The draft as the assistant's chat card shows it (erp-agents docs/chat-draft-approval.md). */
  async forAssistant(user: AuthUser, id: string): Promise<AssistantDraftDto<QuotationDraftDto>> {
    const draft = await this.get(user, id);
    return this.drafts.assistantView(
      user,
      'quotation',
      'quotation_drafts',
      draft,
      LABEL,
      await this.resolved(user, id),
    );
  }

  /** What an approval would record now, with rate card prices resolved (null if refused). */
  private async resolved(user: AuthUser, id: string): Promise<string | null> {
    const draft = await this.findScoped(user, id);
    if (draftStatus(draft.state, draft.expiresAt, new Date()) !== 'DRAFT') return null;
    try {
      return resolvedKey(await this.quotations.prepareCreate(user, requestOf(draft)));
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        return null;
      }
      throw error;
    }
  }

  /** A person approves in the assistant's chat the content the card showed them. */
  async approveFromAssistant(
    user: AuthUser,
    id: string,
    input: AssistantDraftApproveRequest,
  ): Promise<QuotationDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'quotation',
      'quotation_drafts',
      draft,
      LABEL,
      input.contentHash,
      await this.resolved(user, id),
    );
    return this.approve(user, id, input.version, decision);
  }

  /** A person rejects in the assistant's chat. */
  async rejectFromAssistant(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<QuotationDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'quotation',
      'quotation_drafts',
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
  ): Promise<QuotationDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'quotation_drafts', id);
      if (!locked) throw new NotFoundException('Quotation draft not found');
      requireOpen(locked, input.version, LABEL);
      await tx.quotationDraft.update({
        where: { id },
        data: {
          state: 'REJECTED',
          rejectReason: input.reason,
          decidedById: user.id,
          decidedAt: new Date(),
          decidedVia: decidedVia(via),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    try {
      const prepared = await this.quotations.prepareCreate(user, requestOf(draft));
      return { ok: true, total: toDecimalString(prepared.header.total), currency: draft.currency };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.quotationDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Quotation draft not found');
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

function toDto(
  d: DraftRow,
  user: AuthUser,
  now: Date,
  check: EntryDraftCheck | null,
): QuotationDraftDto {
  return { ...baseFields(d, user, now), request: requestOf(d), check };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<QuotationDraftDto, 'request' | 'check'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('quotations:create');
  return {
    id: d.id,
    branchId: d.branchId,
    customerId: d.customerId,
    customerName: d.customer.name,
    subject: d.customer.name,
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
    quotationId: d.quotationId,
    quotationNumber: d.quotation?.number ?? null,
  };
}
