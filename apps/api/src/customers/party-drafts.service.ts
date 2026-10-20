import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DraftEvidence,
  DraftPreCheckDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  PartyDraftCreateRequest,
  PartyDraftDto,
  PartyDraftListItemDto,
  PartyDraftRequest,
  PartyDraftUpdateRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
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
  lockReplacedInTx,
  listScope,
  type ReviewPage,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  replacementParentIds,
  requireSameParent,
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
  partyCompleteness,
  requireApprovable,
} from '../drafts/draft-completeness.js';
import { CustomersService } from './customers.service.js';

const LABEL = 'party draft';
const ASSISTANT_ONLY = 'Party drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a party draft';

const details = {
  customer: { select: { number: true, name: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
} satisfies Prisma.PartyDraftInclude;

type DraftRow = Prisma.PartyDraftGetPayload<{ include: typeof details }>;

/**
 * The drafts a user sees: those of a customer in their branches (access follows the customer, as
 * it always has), and those naming no customer yet, by the draft's own branch.
 */
function draftScope(user: AuthUser): Prisma.PartyDraftWhereInput {
  return { OR: [{ customer: branchScope(user) }, { customerId: null, ...branchScope(user) }] };
}

/** A party draft's customer and party, as stored (a missing value is null). */
type PartyValues = PartyDraftRequest & { customerId: string | null };

function valuesOfRow(d: DraftRow): PartyValues {
  return { customerId: d.customerId, ...partyRequestOf(d) };
}

/** The value columns of a draft, a missing value as NULL. */
function columnsOf(values: PartyValues) {
  return {
    customerId: values.customerId ?? null,
    name: values.name ?? null,
    companyName: values.companyName ?? null,
    phone: values.phone ?? null,
    email: values.email ?? null,
    countryCode: values.countryCode ?? null,
    city: values.city ?? null,
    address: values.address ?? null,
  };
}

/** What a party draft still misses before it can be approved (the gate's missing values). */
export function partyMissingFields(d: DraftRow): string[] {
  return partyDraftCompleteness(d).missing;
}

/** A party draft's approval gate (draft-completeness.ts): its customer and the party. */
export function partyDraftCompleteness(d: DraftRow): Completeness {
  return partyCompleteness({ customerId: d.customerId, ...partyRequestOf(d) });
}

/** The party a stored draft proposes. */
export function partyRequestOf(d: DraftRow): PartyDraftRequest {
  return {
    name: d.name,
    companyName: d.companyName,
    phone: d.phone,
    email: d.email,
    countryCode: d.countryCode,
    city: d.city,
    address: d.address,
  };
}

/** sha256 of the normalised request and the staff member's words (customer included): ids lower case, absent fields null. */
export function partyRequestHash(
  customerId: string | null | undefined,
  input: PartyDraftRequest,
  evidence: readonly DraftEvidence[] = [],
): string {
  return requestHash({
    ...evidenceHashPart(evidence),
    customerId: customerId?.toLowerCase() ?? null,
    name: input.name ?? null,
    companyName: input.companyName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    countryCode: input.countryCode ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
  });
}

/**
 * Parties of a customer (shipper, consignee, notify party) proposed by the staff AI assistant
 * (entry drafts, src/drafts), so a booking can name someone the customer ships for or to. A
 * person approves a draft on the review screen, which adds the party through CustomersService in
 * the same transaction, under the customer's lock, with their permissions; or rejects it. Access
 * follows the customer's branch. There is no decision from the assistant's chat.
 */
@Injectable()
export class PartyDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly drafts: DraftsService,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: PartyDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { customerId = null, branchId, evidence = [], ...input } = valuesOf(body);
    const hash = withBranch(partyRequestHash(customerId, input, evidence), branchId);
    return preCheck(hash, async () => {
      await this.validate(user, customerId, branchId);
      const missingFields = partyCompleteness({ customerId, ...input }).missing;
      return { total: null, currency: null, missingFields };
    });
  }

  /**
   * The checks of a real addParty that need no lock, on the customer when named: the draft's
   * branch is the customer's (which a branch given must be); with no customer yet, the branch
   * given, one of the user's.
   */
  private async validate(
    user: AuthUser,
    customerId: string | null,
    branchId: string | null | undefined,
  ): Promise<{ branchId: string }> {
    const customer = customerId ? await this.customers.prepareAddParty(user, customerId) : null;
    return { branchId: draftBranch(user, branchId, customer?.branchId ?? null) };
  }

  async create(
    user: AuthUser,
    body: PartyDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, customerId = null, branchId, evidence = [], ...input } = body;
    const hash = withReplaced(
      withBranch(partyRequestHash(customerId, input, evidence), branchId),
      replacesDraftId,
    );
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'party_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real addParty that need no lock, on the values present; nothing is written.
    const prepared = await this.validate(user, customerId, branchId);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // An approval locks the customer, then the draft: a replacement takes the same order.
        if (replacesDraftId !== null) {
          const ids = await replacementParentIds(tx, 'party_drafts', replacesDraftId, customerId);
          for (const customer of ids) await this.customers.lockForPartyWrite(tx, customer);
        }
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'party_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'party_drafts', scope);
        const existing = await tx.partyDraft.findUnique({
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
        const draft = await tx.partyDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId: prepared.branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
            ...columnsOf({ customerId, ...input }),
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
   * are checked as on create (a customer named must be of the draft's branch, and once named it
   * stays: an approval locks it before the draft), and the version
   * moves on. The words of a value the person changed are dropped. The assistant's request (its
   * payload hash) stays the draft's, so a replay of that create still finds this draft.
   */
  async update(user: AuthUser, id: string, input: PartyDraftUpdateRequest): Promise<PartyDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    requireSameParent(current.customerId, patch.customerId, 'customer');
    const values = patched(valuesOfRow(current), patch);
    await this.validate(user, values.customerId, current.branchId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'party_drafts', id);
      if (!locked) throw new NotFoundException('Party draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.partyDraft.update({
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
    const draft = await this.prisma.partyDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...draftScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Party draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
  ): Promise<PartyDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.partyDraft.findMany({
      where: {
        ...draftScope(user),
        ...stateFilter(status, now),
        ...scope.where,
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: scope.take,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: 1 }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('customers:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'party',
        d,
        d.partyId === null || d.customerId === null
          ? null
          : { type: 'party', id: d.partyId, number: null, path: `/customers/${d.customerId}` },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<PartyDraftDto> {
    return withReplacedBy(this.prisma, 'party_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<PartyDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return {
      ...baseFields(draft, user, now),
      request: partyRequestOf(draft),
      evidence: evidenceOf(draft.evidence),
      check,
    };
  }

  /**
   * A person approves the version they reviewed: the party is added in the same transaction as
   * the approval. Locks the customer first, then the draft row, as every party change does.
   * Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    confirmed: readonly string[] = [],
  ): Promise<PartyDraftDto> {
    this.drafts.requireDecider(user, 'SESSION', HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is checked or recorded while the draft misses or holds an invalid value (422).
    requireApprovable(partyDraftCompleteness(current));
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const customerId = storedValue(current.customerId, 'customer');
    await this.customers.prepareAddParty(user, customerId);
    await this.prisma.$transaction(async (tx) => {
      let partyId = '';
      const decided = await decideInTx(tx, {
        table: 'party_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        lockParents: async () => {
          await this.customers.lockForPartyWrite(tx, customerId);
        },
        gate: async () => {
          const row = await tx.partyDraft.findUniqueOrThrow({ where: { id }, include: details });
          requireApprovable(partyDraftCompleteness(row));
        },
        record: async () => {
          partyId = await this.customers.addPartyInTx(tx, user, customerId, {
            ...partyRequestOf(current),
            name: storedValue(current.name, 'name'),
          });
        },
      });
      if (decided) {
        await tx.partyDraft.update({
          where: { id },
          data: { ...approvedFields(user, 'SESSION'), partyId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<PartyDraftDto> {
    this.drafts.requireDecider(user, 'SESSION', HUMAN_ONLY, id);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'party_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.partyDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason, 'SESSION'),
      });
    });
    return this.get(user, id);
  }

  /**
   * NOLON's checks of adding the party now (checked again on approval). Null while the draft
   * names no customer yet: it waits for it (missingFields).
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const customerId = draft.customerId;
    if (customerId === null) return null;
    return checkDraft(async () => {
      await this.customers.prepareAddParty(user, customerId);
      return { total: null, currency: null };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.partyDraft.findFirst({
      where: { id, ...draftScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Party draft not found');
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
    missingFields: partyMissingFields(d),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<PartyDraftDto, 'request' | 'check' | 'evidence'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('customers:update');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: d.name ?? '',
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
    missingFields: partyMissingFields(d),
    customerId: d.customerId,
    customerNumber: d.customer?.number ?? null,
    customerName: d.customer?.name ?? null,
    partyId: d.partyId,
  };
}
