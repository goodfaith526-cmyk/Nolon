import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateRateCardRequest,
  DraftEvidence,
  DraftPreCheckDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  RateCardDraftCreateRequest,
  RateCardDraftDto,
  RateCardDraftListItemDto,
  RateCardDraftRequest,
  RateCardDraftUpdateRequest,
  RateCardInput,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { fromDbDate, fromDbDateOrNull, toDbDate } from '../common/dates.js';
import { dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import { throwFirstConflict } from '../common/rule-issues.js';
import { evidenceHashPart, evidenceOf, requireConfirmed } from '../drafts/draft-evidence.js';
import {
  approvedFields,
  checkDraft,
  draftExpiry,
  draftStatus,
  patched,
  preCheck,
  rejectedFields,
  sameStoredValue,
  storedValue,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  decideInTx,
  DraftsService,
  keyReused,
  lockDraftRow,
  lockReplacedInTx,
  listScope,
  type ReviewPage,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  storedDraftUnderKey,
  valuesOf,
  withReplaced,
  withReplacedBy,
  MY_DRAFTS_ORDER,
  lockKeyInTx,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RatesService } from './rates.service.js';
import { rateCardCompleteness, requireApprovable } from '../drafts/draft-completeness.js';

const LABEL = 'rate card draft';
const ASSISTANT_ONLY = 'Rate card drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a rate card draft';

const details = {
  branch: { select: { code: true } },
  origin: { select: { code: true } },
  destination: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
} satisfies Prisma.RateCardDraftInclude;

type DraftRow = Prisma.RateCardDraftGetPayload<{ include: typeof details }>;

/**
 * The rate a stored draft proposes. Absent optional fields stay absent: the rate's defaults apply.
 * A value the draft misses is null.
 */
export function rateRequestOf(d: DraftRow): RateCardDraftRequest {
  return {
    originLocationId: d.originLocationId,
    destinationLocationId: d.destinationLocationId,
    mode: d.mode,
    loadType: d.loadType,
    cargoType: d.cargoType,
    containerTypeCode: d.containerTypeCode,
    ...(d.chargeTypeCode === null ? {} : { chargeTypeCode: d.chargeTypeCode }),
    unit: d.unit,
    price: toDecimalStringOrNull(d.price),
    ...(d.minimumCharge === null ? {} : { minimumCharge: toDecimalString(d.minimumCharge) }),
    currency: d.currency,
    validFrom: d.validFrom === null ? null : fromDbDate(d.validFrom),
    validTo: fromDbDateOrNull(d.validTo),
    transitDays: d.transitDays,
    notes: d.notes,
  };
}

/**
 * What a rate card draft still misses before it can be approved: the approval gate's missing
 * values (draft-completeness.ts), from a rate's own rules.
 */
export function rateMissingFields(input: RateCardDraftRequest): string[] {
  return rateCardCompleteness(input).missing;
}

/** The rate of a complete draft, in the shape RatesService takes. */
function completeRate(input: RateCardDraftRequest): RateCardInput {
  return {
    ...input,
    originLocationId: storedValue(input.originLocationId, 'origin'),
    destinationLocationId: storedValue(input.destinationLocationId, 'destination'),
    mode: storedValue(input.mode, 'mode'),
    cargoType: storedValue(input.cargoType, 'cargo type'),
    unit: storedValue(input.unit, 'unit'),
    price: storedValue(input.price, 'price'),
    minimumCharge: input.minimumCharge ?? undefined,
    chargeTypeCode: input.chargeTypeCode ?? undefined,
    currency: storedValue(input.currency, 'currency'),
    validFrom: storedValue(input.validFrom, 'valid-from date'),
  };
}

/** The values present, as the rate rules read a partial rate (a missing one absent). */
function presentRate(input: RateCardDraftRequest): Partial<RateCardInput> {
  return {
    originLocationId: input.originLocationId ?? undefined,
    destinationLocationId: input.destinationLocationId ?? undefined,
    mode: input.mode ?? undefined,
    loadType: input.loadType,
    cargoType: input.cargoType ?? undefined,
    containerTypeCode: input.containerTypeCode,
    chargeTypeCode: input.chargeTypeCode ?? undefined,
    unit: input.unit ?? undefined,
    price: input.price ?? undefined,
    minimumCharge: input.minimumCharge ?? undefined,
    currency: input.currency ?? undefined,
    validFrom: input.validFrom ?? undefined,
    validTo: input.validTo,
    transitDays: input.transitDays,
    notes: input.notes,
  };
}

/**
 * sha256 of the normalised request and the staff member's words (branch included): ids lower
 * case, amounts to 4 places, absent fields null (a complete request hashes as it always has).
 */
export function rateRequestHash(
  branchId: string,
  input: RateCardDraftRequest,
  evidence: readonly DraftEvidence[] = [],
): string {
  return requestHash({
    ...evidenceHashPart(evidence),
    branchId: branchId.toLowerCase(),
    originLocationId: input.originLocationId?.toLowerCase() ?? null,
    destinationLocationId: input.destinationLocationId?.toLowerCase() ?? null,
    mode: input.mode ?? null,
    loadType: input.loadType ?? null,
    cargoType: input.cargoType ?? null,
    containerTypeCode: input.containerTypeCode ?? null,
    chargeTypeCode: input.chargeTypeCode ?? null,
    unit: input.unit ?? null,
    price: amountKey(input.price),
    minimumCharge: amountKey(input.minimumCharge),
    currency: input.currency ?? null,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    transitDays: input.transitDays ?? null,
    notes: input.notes ?? null,
  });
}

function amountKey(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : dec(value).toFixed(4);
}

function createRequestOf(branchId: string, input: RateCardInput): CreateRateCardRequest {
  return { branchId, ...input };
}

/**
 * The staff member's words that still stand after a person's edit: the words of a value the person
 * changed are dropped, since the value is now the reviewer's own entry, not the assistant's.
 */
export function evidenceAfterEdit(
  evidence: readonly DraftEvidence[],
  before: RateCardDraftRequest,
  after: RateCardDraftRequest,
): DraftEvidence[] {
  const key = (field: string, values: RateCardDraftRequest): unknown => {
    const value = (values as Record<string, unknown>)[field] ?? null;
    if (field === 'price' || field === 'minimumCharge') return amountKey(value as string | null);
    return typeof value === 'string' ? value.toLowerCase() : value;
  };
  return evidence.filter(
    (e) => e.field === 'branchId' || sameStoredValue(key(e.field, before), key(e.field, after)),
  );
}

/**
 * Selling rates proposed by the staff AI assistant (entry drafts, src/drafts). A person approves a
 * draft on the review screen, which creates a DRAFT rate card through RatesService in the same
 * transaction, with their permissions and branches (the same offer already drafted or approved in
 * the branch is checked under the branch's rate lock); or rejects it. The rate then goes through
 * the usual rate approval (rates:approve) before a quotation can use it. Drafts are branch-owned
 * like rates. There is no decision from the assistant's chat.
 */
@Injectable()
export class RateCardDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
    private readonly drafts: DraftsService,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: RateCardDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { branchId, evidence = [], ...input } = valuesOf(body);
    return preCheck(rateRequestHash(branchId, input, evidence), async () => {
      // As an approval would: a rate card that duplicates another refuses it.
      const request = await this.validate(user, branchId, input);
      if (request) throwFirstConflict(await this.rates.duplicateIssues(this.prisma, [request]));
      return { total: null, currency: null, missingFields: rateMissingFields(input) };
    });
  }

  /**
   * The checks a draft's values get on create and on a person's edit: a complete rate's in full
   * (prepareCreate), returning it; a rate still missing values, those of the values present.
   */
  private async validate(
    user: AuthUser,
    branchId: string,
    input: RateCardDraftRequest,
  ): Promise<CreateRateCardRequest | null> {
    if (rateMissingFields(input).length > 0) {
      await this.rates.checkPresent(user, branchId, presentRate(input));
      return null;
    }
    const request = createRequestOf(branchId, completeRate(input));
    await this.rates.prepareCreate(user, request);
    return request;
  }

  async create(
    user: AuthUser,
    body: RateCardDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, branchId, evidence = [], ...input } = body;
    const hash = withReplaced(rateRequestHash(branchId, input, evidence), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'rate_card_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real create that need no lock, on the values present; nothing is written.
    const request = await this.validate(user, branchId, input);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'rate_card_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'rate_card_drafts', scope);
        const existing = await tx.rateCardDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The user holds the branch now, as stored (not only as their request loaded it).
        await requireBranchMemberInTx(tx, user, branchId);
        // Only a new request: the same offer already drafted or approved in the branch is refused
        // (409), so the assistant can say so; it is checked again under the lock on approval.
        if (request) throwFirstConflict(await this.rates.duplicateIssues(tx, [request]));
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.rateCardDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
            ...columnsOf(input),
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
   * are checked as on create, the staff member's words of a changed value are dropped (it is the
   * reviewer's own entry now), and the version moves on. The assistant's request (its payload
   * hash) stays the draft's, so a replay of that create still finds this draft.
   */
  async update(
    user: AuthUser,
    id: string,
    input: RateCardDraftUpdateRequest,
  ): Promise<RateCardDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const before = rateRequestOf(current);
    const values = patched(before, patch);
    await this.validate(user, current.branchId, values);
    const evidence = evidenceAfterEdit(evidenceOf(current.evidence), before, values);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'rate_card_drafts', id);
      if (!locked) throw new NotFoundException('Rate card draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.rateCardDraft.update({
        where: { id },
        data: {
          ...columnsOf(values),
          evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.rateCardDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Rate card draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
  ): Promise<RateCardDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.rateCardDraft.findMany({
      where: {
        ...branchScope(user),
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
      price: toDecimalStringOrNull(d.price),
      currency: d.currency,
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('rates:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'rate_card',
        d,
        d.rateCardId === null
          ? null
          : { type: 'rate_card', id: d.rateCardId, number: null, path: '/rates' },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<RateCardDraftDto> {
    return withReplacedBy(this.prisma, 'rate_card_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<RateCardDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return {
      ...baseFields(draft, user, now),
      request: rateRequestOf(draft),
      evidence: evidenceOf(draft.evidence),
      check,
    };
  }

  /**
   * A person approves the version they reviewed: the DRAFT rate card is created in the same
   * transaction as the approval. Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    confirmed: readonly string[] = [],
  ): Promise<RateCardDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is recorded while the draft misses a value (422, naming each one).
    const values = rateRequestOf(current);
    requireApprovable(rateCardCompleteness(values));
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const request = createRequestOf(current.branchId, completeRate(values));
    await this.rates.prepareCreate(user, request);
    await this.prisma.$transaction(async (tx) => {
      let rateCardId = '';
      const decided = await decideInTx(tx, {
        table: 'rate_card_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        gate: async () => {
          const row = await tx.rateCardDraft.findUniqueOrThrow({ where: { id }, include: details });
          requireApprovable(rateCardCompleteness(rateRequestOf(row)));
        },
        record: async () => {
          rateCardId = (await this.rates.createInTx(tx, user, request)).id;
        },
      });
      if (decided) {
        await tx.rateCardDraft.update({
          where: { id },
          data: { ...approvedFields(user), rateCardId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<RateCardDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'rate_card_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.rateCardDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason),
      });
    });
    return this.get(user, id);
  }

  /** NOLON's checks of a create, duplicates included (binding only under the lock, on approval). */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const values = rateRequestOf(draft);
    if (rateMissingFields(values).length > 0) {
      // Null while it waits for its missing values and those present pass (missingFields).
      const present = await checkDraft(async () => {
        await this.rates.checkPresent(user, draft.branchId, presentRate(values));
        return { total: null, currency: null };
      });
      return present.ok ? null : present;
    }
    return checkDraft(async () => {
      assertBranchAccess(user, draft.branchId);
      const request = createRequestOf(draft.branchId, completeRate(values));
      await this.rates.prepareCreate(user, request);
      throwFirstConflict(await this.rates.duplicateIssues(this.prisma, [request]));
      return { total: null, currency: null };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.rateCardDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Rate card draft not found');
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
    missingFields: rateMissingFields(rateRequestOf(d)),
  };
}

/** The value columns of a draft, a missing value as NULL. */
function columnsOf(input: RateCardDraftRequest) {
  return {
    originLocationId: input.originLocationId ?? null,
    destinationLocationId: input.destinationLocationId ?? null,
    mode: input.mode ?? null,
    loadType: input.loadType ?? null,
    cargoType: input.cargoType ?? null,
    containerTypeCode: input.containerTypeCode ?? null,
    chargeTypeCode: input.chargeTypeCode ?? null,
    unit: input.unit ?? null,
    price: input.price ? dec(input.price) : null,
    minimumCharge: input.minimumCharge ? dec(input.minimumCharge) : null,
    currency: input.currency ?? null,
    validFrom: input.validFrom ? toDbDate(input.validFrom) : null,
    validTo: input.validTo ? toDbDate(input.validTo) : null,
    transitDays: input.transitDays ?? null,
    notes: input.notes ?? null,
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<RateCardDraftDto, 'request' | 'check' | 'evidence'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('rates:create');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: `${d.origin?.code ?? '?'} → ${d.destination?.code ?? '?'}`,
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
    missingFields: rateMissingFields(rateRequestOf(d)),
    branchCode: d.branch.code,
    originCode: d.origin?.code ?? null,
    destinationCode: d.destination?.code ?? null,
    rateCardId: d.rateCardId,
  };
}
