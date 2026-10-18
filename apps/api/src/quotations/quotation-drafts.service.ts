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
  DraftPreCheckDto,
  DraftPriceSource,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  QuotationDraftCreateRequest,
  QuotationDraftDto,
  QuotationDraftListItemDto,
  QuotationDraftLine,
  QuotationDraftPricing,
  QuotationDraftQuotation,
  QuotationDraftUpdateRequest,
  QuotationDraftValues,
  QuotationInput,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import {
  decimalKey,
  draftBranch,
  draftExpiry,
  draftStatus,
  checkDraft,
  withBranch,
  patched,
  preCheck,
  requestHash,
  storedValue,
  requireOpen,
  resolvedKey,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  decidedVia,
  type DecisionVia,
  DraftsService,
  keyReused,
  lockDraftRow,
  lockReplacedInTx,
  mineWhere,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  storedDraftUnderKey,
  valuesOf,
  type ValuesOf,
  withReplaced,
  withReplacedBy,
  MY_DRAFTS_ORDER,
  lockKeyInTx,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { quotationCompleteness, requireApprovable } from '../drafts/draft-completeness.js';
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

/** The draft as it stands inside a transaction that holds its row lock. */
function lockedRow(tx: Prisma.TransactionClient, id: string): Promise<DraftRow> {
  return tx.quotationDraft.findUniqueOrThrow({ where: { id }, include: details });
}

/** A create request's lines as stored: decimals as Decimal, absent values as null. */
export function storedLines(input: QuotationInput) {
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

/** A draft's lines as stored: decimals as Decimal, absent values (a missing quantity) as null. */
export function draftLines(lines: readonly QuotationDraftLine[]) {
  const decimal = (v: string | null | undefined) => (v === null || v === undefined ? null : dec(v));
  return lines.map((line, i) => ({
    lineNo: i + 1,
    rateCardId: line.rateCardId ?? null,
    chargeTypeCode: line.chargeTypeCode ?? null,
    description: line.description ?? null,
    unit: line.unit ?? null,
    quantity: decimal(line.quantity),
    unitPrice: decimal(line.unitPrice),
    discount: decimal(line.discount),
  }));
}

/**
 * The request a stored draft proposes, as QuotationsService takes it once complete. Values are
 * given back exactly as stored (a draft created from request R reads back as R in canonical
 * form); a value the draft misses is null.
 */
export function requestOf(d: DraftRow): QuotationDraftValues {
  return { customerId: d.customerId, ...quotationValuesOf(d) };
}

/**
 * What a quotation draft still misses before it can be approved: the approval gate's missing
 * values (draft-completeness.ts), from a quotation's own rules.
 */
export function quotationMissingFields(values: QuotationDraftValues): string[] {
  return quotationCompleteness(values).missing;
}

/** The quotation of a complete draft, in the shape QuotationsService takes. */
export function completeQuotation(values: QuotationDraftValues): CreateQuotationRequest {
  const { customerId, ...quotation } = values;
  return { ...completeQuotationInput(quotation), customerId: storedValue(customerId, 'customer') };
}

/** The quotation part of a complete draft (no customer), in the shape QuotationsService takes. */
export function completeQuotationInput(values: QuotationDraftQuotation): QuotationInput {
  return {
    ...values,
    originLocationId: storedValue(values.originLocationId, 'origin'),
    destinationLocationId: storedValue(values.destinationLocationId, 'destination'),
    mode: storedValue(values.mode, 'mode'),
    cargoType: storedValue(values.cargoType, 'cargo type'),
    currency: storedValue(values.currency, 'currency'),
    validUntil: storedValue(values.validUntil, 'valid-until date'),
    lines: values.lines.map((line) => ({
      ...line,
      quantity: storedValue(line.quantity, 'line quantity'),
    })),
  };
}

/**
 * A quotation draft's values from a create body (absent lines are none yet), and the branch it
 * names (security context, not a value).
 */
function valuesOfCreate(input: ValuesOf<QuotationDraftCreateRequest>): {
  values: QuotationDraftValues;
  branchId: string | null;
} {
  const { branchId, ...values } = input;
  return { values: { ...values, lines: values.lines ?? [] }, branchId: branchId ?? null };
}

/**
 * The idempotency hash of a draft's values: a complete quotation's as it always was
 * (quotationRequestHash); one missing values, its own normalised form with each missing value
 * null, marked so it never equals a complete one.
 */
export function quotationDraftHash(values: QuotationDraftValues): string {
  if (quotationMissingFields(values).length === 0) {
    return quotationRequestHash(completeQuotation(values));
  }
  const { customerId, ...quotation } = values;
  return requestHash({
    ...normalisedDraftQuotation(quotation),
    customerId: customerId?.toLowerCase() ?? null,
  });
}

/**
 * The quotation part of a draft still missing values, as hashed: ids lower case, decimals
 * canonical, each missing value null, marked so it never equals a complete one.
 */
export function normalisedDraftQuotation(values: QuotationDraftQuotation): object {
  const lower = (v: string | null | undefined) => v?.toLowerCase() ?? null;
  return {
    incomplete: true,
    originLocationId: lower(values.originLocationId),
    destinationLocationId: lower(values.destinationLocationId),
    mode: values.mode ?? null,
    loadType: values.loadType ?? null,
    cargoType: values.cargoType ?? null,
    cargoDescription: values.cargoDescription ?? null,
    currency: values.currency ?? null,
    validUntil: values.validUntil ?? null,
    terms: values.terms ?? null,
    lines: draftLines(values.lines).map((l) => ({
      ...l,
      rateCardId: l.rateCardId?.toLowerCase() ?? null,
      quantity: decimalKey(l.quantity),
      unitPrice: decimalKey(l.unitPrice),
      discount: decimalKey(l.discount),
    })),
  };
}

/**
 * A stored quotation (a quotation draft's, or a new customer's), without its customer: any value
 * may be missing (null) until a person fills it in.
 */
export interface StoredQuotation {
  originLocationId: string | null;
  destinationLocationId: string | null;
  mode: CreateQuotationRequest['mode'] | null;
  loadType: CreateQuotationRequest['loadType'];
  cargoType: CreateQuotationRequest['cargoType'] | null;
  cargoDescription: string | null;
  currency: string | null;
  validUntil: Date | null;
  terms: string | null;
  lines: ReturnType<typeof draftLines>;
}

/**
 * The quotation a stored draft proposes, without its customer. Values are given back exactly as
 * stored (a draft created from request R reads back as R in canonical form); a value the draft
 * misses is null.
 */
export function quotationValuesOf(row: StoredQuotation): QuotationDraftQuotation {
  return {
    originLocationId: row.originLocationId,
    destinationLocationId: row.destinationLocationId,
    mode: row.mode,
    loadType: row.loadType ?? null,
    cargoType: row.cargoType,
    cargoDescription: row.cargoDescription,
    currency: row.currency,
    validUntil: row.validUntil === null ? null : fromDbDate(row.validUntil),
    terms: row.terms,
    lines: row.lines.map((l) => ({
      ...(l.rateCardId === null ? {} : { rateCardId: l.rateCardId }),
      ...(l.chargeTypeCode === null ? {} : { chargeTypeCode: l.chargeTypeCode }),
      description: l.description,
      ...(l.unit === null ? {} : { unit: l.unit }),
      quantity: l.quantity === null ? null : toDecimalString(l.quantity),
      ...(l.unitPrice === null ? {} : { unitPrice: toDecimalString(l.unitPrice) }),
      ...(l.discount === null ? {} : { discount: toDecimalString(l.discount) }),
    })),
  };
}

/** sha256 of the normalised request: decimals canonical, missing and null alike, keys sorted. */
export function quotationRequestHash(input: CreateQuotationRequest): string {
  return requestHash({ ...normalisedQuotation(input), customerId: input.customerId.toLowerCase() });
}

/** A quotation as hashed: ids lower case, decimals canonical, missing and null alike. */
export function normalisedQuotation(input: QuotationInput): object {
  return {
    ...input,
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
  };
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
  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: QuotationDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { values, branchId } = valuesOfCreate(valuesOf(body));
    return preCheck(withBranch(quotationDraftHash(values), branchId), async () => {
      const missingFields = quotationMissingFields(values);
      if (missingFields.length > 0) {
        await this.quotations.checkPresent(user, values, branchId);
        return { total: null, currency: null, missingFields };
      }
      const input = completeQuotation(values);
      const prepared = await this.quotations.prepareCreate(user, input);
      draftBranch(user, branchId, prepared.branchId);
      return {
        total: toDecimalString(prepared.header.total),
        currency: input.currency,
        priceSources: sourcesOf(prepared),
        // A line given no price takes the rate card's: what the draft would record.
        computed: prepared.lines.flatMap((l, i) =>
          l.rateCardId === null || input.lines[i]?.unitPrice !== undefined
            ? []
            : [
                {
                  field: `lines.${i}.unitPrice`,
                  value: toDecimalString(l.unitPrice),
                  source: 'RATE_CARD' as const,
                  rateCardId: l.rateCardId,
                },
              ],
        ),
        missingFields,
      };
    });
  }

  /**
   * The checks a draft's values get on create and on a person's edit: a complete quotation's in
   * full (prepareCreate, prices included); one still missing values, those of the values present.
   * The customer (when named) and the draft's branch either way: the customer's, which a branch
   * given must be; with no customer, the branch given, one of the user's.
   */
  private async validate(
    user: AuthUser,
    values: QuotationDraftValues,
    branchId: string | null,
  ): Promise<{ customerId: string | null; branchId: string }> {
    if (quotationMissingFields(values).length > 0) {
      return this.quotations.checkPresent(user, values, branchId);
    }
    const prepared = await this.quotations.prepareCreate(user, completeQuotation(values));
    return {
      customerId: prepared.customerId,
      branchId: draftBranch(user, branchId, prepared.branchId),
    };
  }

  async create(
    user: AuthUser,
    body: QuotationDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...rest } = body;
    const { values: input, branchId } = valuesOfCreate(rest);
    const hash = withReplaced(withBranch(quotationDraftHash(input), branchId), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'quotation_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real quotation, on the values present; nothing is written.
    const prepared = await this.validate(user, input, branchId);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'quotation_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'quotation_drafts', scope);
        const existing = await tx.quotationDraft.findUnique({
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
        const draft = await tx.quotationDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            ...columnsOf(input),
            branchId: prepared.branchId,
            customerId: prepared.customerId,
          },
          select: { id: true },
        });
        await tx.quotationDraftLine.createMany({
          data: draftLines(input.lines).map((line) => ({ ...line, draftId: draft.id })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create, and the version moves on (a pricing shown before no longer applies).
   * The assistant's request (its payload hash) stays the draft's, so a replay of that create still
   * finds this draft.
   */
  async update(
    user: AuthUser,
    id: string,
    input: QuotationDraftUpdateRequest,
  ): Promise<QuotationDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const values = patched(requestOf(current), patch);
    // A customer named here must be of the draft's branch: a draft never changes branch.
    await this.validate(user, values, current.branchId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'quotation_drafts', id);
      if (!locked) throw new NotFoundException('Quotation draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.quotationDraft.update({
        where: { id },
        data: { ...columnsOf(values), version: { increment: 1 } },
      });
      if (patch.lines !== undefined) {
        await tx.quotationDraftLine.deleteMany({ where: { draftId: id } });
        await tx.quotationDraftLine.createMany({
          data: draftLines(values.lines).map((line) => ({ ...line, draftId: id })),
        });
      }
    });
    return this.get(user, id);
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

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
  ): Promise<QuotationDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.quotationDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...(mine ? mineWhere(user, mine) : {}),
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: mine?.limit ?? 200,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: d.lines.length }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('quotations:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'quotation',
        d,
        d.quotationId === null
          ? null
          : {
              type: 'quotation',
              id: d.quotationId,
              number: d.quotationNumber,
              path: `/quotations/${d.quotationId}`,
            },
      ),
    );
  }

  /** The draft, with whether NOLON would accept it now (checked, nothing written). */
  async get(user: AuthUser, id: string): Promise<QuotationDraftDto> {
    return withReplacedBy(this.prisma, 'quotation_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<QuotationDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const { check, pricing, priceSources } =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.priced(user, draft)
        : { check: null, pricing: null, priceSources: null };
    return {
      ...baseFields(draft, user, now),
      request: requestOf(draft),
      check,
      pricing,
      priceSources,
    };
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
    pricingKey: string | null = null,
  ): Promise<QuotationDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is recorded while the draft misses a value (422, naming each one).
    const values = requestOf(current);
    requireApprovable(quotationCompleteness(values));
    // The request is the one at `version`; the lock below refuses if it changed since.
    const prepared = await this.quotations.prepareCreate(user, completeQuotation(values));
    // Exactly the prices the person reviewed (rate cards resolved), on the review screen or the
    // chat card; this same `prepared` is what is inserted. Anything else asks for a reload.
    this.drafts.requireResolved(via, resolvedKey(prepared), LABEL, pricingKey);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'quotation_drafts', id);
      if (!locked) throw new NotFoundException('Quotation draft not found');
      if (locked.state === 'APPROVED') return;
      requireOpen(locked, version, LABEL);
      // The gate again, on the row as locked: what is recorded is complete and valid.
      requireApprovable(quotationCompleteness(requestOf(await lockedRow(tx, id))));
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
      draft.pricing?.key ?? null,
    );
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
      draft.pricing?.key ?? null,
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

  /** Whether NOLON would accept the draft now and, if so, the prices it would record. */
  private async priced(
    user: AuthUser,
    draft: DraftRow,
  ): Promise<{
    check: EntryDraftCheck | null;
    pricing: QuotationDraftPricing | null;
    priceSources: DraftPriceSource[] | null;
  }> {
    const values = requestOf(draft);
    if (quotationMissingFields(values).length > 0) {
      // No prices while values are missing; null check while those present pass (missingFields).
      const present = await checkDraft(async () => {
        await this.quotations.checkPresent(user, values, draft.branchId);
        return { total: null, currency: null };
      });
      return { check: present.ok ? null : present, pricing: null, priceSources: null };
    }
    try {
      const prepared = await this.quotations.prepareCreate(user, completeQuotation(values));
      return {
        check: {
          ok: true,
          total: toDecimalString(prepared.header.total),
          currency: draft.currency,
        },
        pricing: pricingOf(prepared),
        priceSources: sourcesOf(prepared),
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        return {
          check: { ok: false, message: error.message },
          pricing: null,
          priceSources: null,
        };
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
    missingFields: quotationMissingFields(requestOf(d)),
  };
}

/** The value columns of a draft (its lines apart), a missing value as NULL. */
function columnsOf(values: QuotationDraftValues) {
  const { customerId, ...quotation } = values;
  return { customerId: customerId ?? null, ...quotationColumnsOf(quotation) };
}

/** The value columns of a draft's quotation part (its customer and lines apart), missing as NULL. */
export function quotationColumnsOf(values: Omit<QuotationDraftQuotation, 'lines'>) {
  return {
    originLocationId: values.originLocationId ?? null,
    destinationLocationId: values.destinationLocationId ?? null,
    mode: values.mode ?? null,
    loadType: values.loadType ?? null,
    cargoType: values.cargoType ?? null,
    cargoDescription: values.cargoDescription ?? null,
    currency: values.currency ?? null,
    validUntil: values.validUntil ? toDbDate(values.validUntil) : null,
    terms: values.terms ?? null,
  };
}

/** The prices an approval would record, and their fingerprint (what the approval sends back). */
export function pricingOf(
  prepared: Omit<Awaited<ReturnType<QuotationsService['prepareCreate']>>, 'customerId'>,
): QuotationDraftPricing {
  return {
    key: resolvedKey(prepared),
    lines: prepared.lines.map((l) => ({
      chargeTypeCode: l.chargeTypeCode,
      unit: l.unit,
      quantity: toDecimalString(l.quantity),
      unitPrice: toDecimalString(l.unitPrice),
      minimumCharge: toDecimalString(l.minimumCharge),
      discount: toDecimalString(l.discount),
      lineTotal: toDecimalString(l.lineTotal),
    })),
    subtotal: toDecimalString(prepared.header.subtotal),
    discountTotal: toDecimalString(prepared.header.discountTotal),
    total: toDecimalString(prepared.header.total),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<QuotationDraftDto, 'request' | 'check' | 'pricing' | 'priceSources'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('quotations:create');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    customerId: d.customerId,
    customerName: d.customer?.name ?? null,
    subject: d.customer?.name ?? '',
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
    missingFields: quotationMissingFields(requestOf(d)),
    quotationId: d.quotationId,
    quotationNumber: d.quotation?.number ?? null,
  };
}

/** A line priced from a rate card (named, or the system price) shows which one. */
export function sourcesOf(prepared: {
  lines: readonly { rateCardId: string | null }[];
}): DraftPriceSource[] {
  return prepared.lines.map((l) =>
    l.rateCardId === null
      ? { source: 'TYPED', rateCardId: null }
      : { source: 'RATE_CARD', rateCardId: l.rateCardId },
  );
}
