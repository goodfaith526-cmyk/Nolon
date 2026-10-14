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
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { fromDbDate, fromDbDateOrNull, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import { throwFirstConflict } from '../common/rule-issues.js';
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
  storedDraftUnderKey,
  valuesOf,
  withReplaced,
  withReplacedBy,
  MY_DRAFTS_ORDER,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RatesService } from './rates.service.js';

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

/** The rate a stored draft proposes. Absent optional fields stay absent: the rate's defaults apply. */
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
    price: toDecimalString(d.price),
    ...(d.minimumCharge === null ? {} : { minimumCharge: toDecimalString(d.minimumCharge) }),
    currency: d.currency,
    validFrom: fromDbDate(d.validFrom),
    validTo: fromDbDateOrNull(d.validTo),
    transitDays: d.transitDays,
    notes: d.notes,
  };
}

/**
 * sha256 of the normalised request and the staff member's words (branch included): ids lower
 * case, amounts to 4 places, absent fields null.
 */
export function rateRequestHash(
  branchId: string,
  input: RateCardDraftRequest,
  evidence: readonly DraftEvidence[] = [],
): string {
  return requestHash({
    ...evidenceHashPart(evidence),
    branchId: branchId.toLowerCase(),
    originLocationId: input.originLocationId.toLowerCase(),
    destinationLocationId: input.destinationLocationId.toLowerCase(),
    mode: input.mode,
    loadType: input.loadType ?? null,
    cargoType: input.cargoType,
    containerTypeCode: input.containerTypeCode ?? null,
    chargeTypeCode: input.chargeTypeCode ?? null,
    unit: input.unit,
    price: dec(input.price).toFixed(4),
    minimumCharge: input.minimumCharge === undefined ? null : dec(input.minimumCharge).toFixed(4),
    currency: input.currency,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    transitDays: input.transitDays ?? null,
    notes: input.notes ?? null,
  });
}

function createRequestOf(branchId: string, input: RateCardDraftRequest): CreateRateCardRequest {
  return { branchId, ...input };
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
      assertBranchAccess(user, branchId);
      const request = createRequestOf(branchId, input);
      await this.rates.prepareCreate(user, request);
      throwFirstConflict(await this.rates.duplicateIssues(this.prisma, [request]));
    });
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
    // The checks of a real create that need no lock; nothing is written.
    const request = createRequestOf(branchId, input);
    await this.rates.prepareCreate(user, request);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'rate_card_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        const existing = await tx.rateCardDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // Only a new request: the same offer already drafted or approved in the branch is refused
        // (409), so the assistant can say so; it is checked again under the lock on approval.
        throwFirstConflict(await this.rates.duplicateIssues(tx, [request]));
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.rateCardDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
            originLocationId: input.originLocationId,
            destinationLocationId: input.destinationLocationId,
            mode: input.mode,
            loadType: input.loadType ?? null,
            cargoType: input.cargoType,
            containerTypeCode: input.containerTypeCode ?? null,
            chargeTypeCode: input.chargeTypeCode ?? null,
            unit: input.unit,
            price: dec(input.price),
            minimumCharge: input.minimumCharge === undefined ? null : dec(input.minimumCharge),
            currency: input.currency,
            validFrom: toDbDate(input.validFrom),
            validTo: input.validTo ? toDbDate(input.validTo) : null,
            transitDays: input.transitDays ?? null,
            notes: input.notes ?? null,
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
  ): Promise<RateCardDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.rateCardDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...(mine ? mineWhere(user, mine) : {}),
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: mine?.limit ?? 200,
    });
    return drafts.map((d) => ({
      ...baseFields(d, user, now),
      lineCount: 1,
      price: toDecimalString(d.price),
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
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const request = createRequestOf(current.branchId, rateRequestOf(current));
    await this.rates.prepareCreate(user, request);
    await this.prisma.$transaction(async (tx) => {
      let rateCardId = '';
      const decided = await decideInTx(tx, {
        table: 'rate_card_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
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
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      assertBranchAccess(user, draft.branchId);
      const request = createRequestOf(draft.branchId, rateRequestOf(draft));
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
    subject: `${d.origin.code} → ${d.destination.code}`,
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
    branchCode: d.branch.code,
    originCode: d.origin.code,
    destinationCode: d.destination.code,
    rateCardId: d.rateCardId,
  };
}
