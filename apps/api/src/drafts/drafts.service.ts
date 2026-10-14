import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AssistantDecidableKind,
  AssistantDraftDto,
  DraftKeySettlementDto,
  DraftStatus,
  EntryDraftReviewFields,
  MyDraftItemDto,
  MyDraftKind,
  MyDraftResult,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { z } from 'zod';
import { parse } from '../common/validation.js';
import { type DraftState, contentHashOf, requestHash, requireOpen } from './draft-rules.js';
import { referenceNames } from './reference-names.js';

const ASSISTANT_DECISION: unique symbol = Symbol('assistant decision');

/**
 * Proof that a decision from the assistant's chat passed authorizeAssistant: only that method
 * builds one, so a draft service decides with a delegated token only after it.
 */
export interface AssistantDecision {
  readonly [ASSISTANT_DECISION]: true;
  readonly draftId: string;
  /** What the card showed an approval would record (resolvedKey), when the type resolves any. */
  readonly resolved: string | null;
}

/** How a person decides: on the review screen with their session, or in the assistant chat. */
export type DecisionVia = 'SESSION' | AssistantDecision;

export function decidedVia(via: DecisionVia): 'SESSION' | 'ASSISTANT' {
  return via === 'SESSION' ? 'SESSION' : 'ASSISTANT';
}

/**
 * Who may do what with an entry draft, the same for every type. The staff assistant (a delegated
 * token) only creates drafts, under an idempotency key scoped to its client and the user it acts
 * for; reading, editing, approving and rejecting are a person's, with their own session.
 */
/**
 * The values a chat card names: the proposed request, and the rate cards NOLON priced lines from
 * (a draft's `priceSources`), whose names carry their prices.
 */
function namedValues(draft: { request: unknown }): unknown {
  return 'priceSources' in draft ? [draft.request, draft.priceSources] : draft.request;
}

@Injectable()
export class DraftsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The assistant client a delegated token belongs to; drafts are created by the assistant only. */
  async agentClientOf(user: AuthUser, refusal: string): Promise<string> {
    if (!user.agent) throw new ForbiddenException(refusal);
    const token = await this.prisma.agentToken.findUnique({
      where: { id: user.agent.tokenId },
      select: { agentClientId: true },
    });
    if (!token) throw new ForbiddenException(refusal);
    return token.agentClientId;
  }

  /**
   * Edits and decisions are a person's. The guard already refuses assistant tokens on those
   * routes; this keeps the rule if a route is ever opened by mistake.
   */
  requireHuman(user: AuthUser, refusal: string): void {
    if (user.agent) throw new ForbiddenException(refusal);
  }

  /**
   * A decision on the review screen needs a person's session. A decision from the assistant's
   * chat needs the delegated token and the proof authorizeAssistant gave for this same draft.
   */
  requireDecider(user: AuthUser, via: DecisionVia, refusal: string, draftId: string): void {
    if (via === 'SESSION') return this.requireHuman(user, refusal);
    if (!user.agent || via[ASSISTANT_DECISION] !== true || via.draftId !== draftId) {
      throw new ForbiddenException(refusal);
    }
  }

  /**
   * An approval records only what the person was shown: the type passes what it resolved for the
   * record it is about to write (resolvedKey), and it must be what the chat card showed (proved
   * by authorizeAssistant) or, on the review screen, the key the screen sent back. Anything else
   * asks for a reload.
   */
  requireResolved(
    via: DecisionVia,
    resolved: string,
    label: string,
    sessionKey: string | null,
  ): void {
    const shown = via === 'SESSION' ? sessionKey : via.resolved;
    if (shown !== resolved) {
      throw new ConflictException(`This ${label} changed since you opened it: reload it`);
    }
  }

  /**
   * What the assistant's chat card shows: the draft as `draft` (already read through the type's
   * own scope), its content hash, and whether the user holds the grant for its kind. Only a draft
   * this assistant client created for this same user; any other reads as not found.
   */
  async assistantView<D extends { id: string; request: unknown }>(
    user: AuthUser,
    kind: AssistantDecidableKind,
    table: DraftTable,
    draft: D,
    label: string,
    resolved: string | null = null,
  ): Promise<AssistantDraftDto<D>> {
    await this.requireOwnDraft(user, table, draft.id, label);
    const names = await referenceNames(this.prisma, user, namedValues(draft));
    return {
      kind,
      contentHash: contentHashOf({ ...draft, names, resolved }),
      canDecideFromAssistant: await this.hasGrant(user.id, kind),
      draft,
      names,
    };
  }

  /**
   * Checks a decision from the assistant's chat, before the type decides in its own transaction:
   * a draft this assistant client created for this same user (else not found), a grant for the
   * kind (else forbidden), and for an approval the content the card showed (else conflict). The
   * version is checked under the row lock by the decision itself.
   */
  async authorizeAssistant<D extends { id: string; request: unknown }>(
    user: AuthUser,
    kind: AssistantDecidableKind,
    table: DraftTable,
    draft: D,
    label: string,
    contentHash: string | null,
    resolved: string | null = null,
  ): Promise<AssistantDecision> {
    await this.requireOwnDraft(user, table, draft.id, label);
    if (!(await this.hasGrant(user.id, kind))) {
      throw new ForbiddenException(
        `Deciding a ${label} from the assistant is not turned on for you`,
      );
    }
    // The names are hashed too: a rate card's price is in its name, so a repricing since the
    // card was shown asks for a reload instead of approving a price nobody saw.
    const names =
      contentHash === null ? {} : await referenceNames(this.prisma, user, namedValues(draft));
    if (contentHash !== null && contentHash !== contentHashOf({ ...draft, names, resolved })) {
      throw new ConflictException(`This ${label} changed since you opened it: reload it`);
    }
    return { [ASSISTANT_DECISION]: true, draftId: draft.id, resolved };
  }

  private async requireOwnDraft(
    user: AuthUser,
    table: DraftTable,
    id: string,
    label: string,
  ): Promise<void> {
    const agentClientId = await this.agentClientOf(
      user,
      `Only the assistant reads a ${label} here`,
    );
    requireDraftTable(table);
    const rows = await this.prisma.$queryRaw<{ created_by_id: string; agent_client_id: string }[]>`
      SELECT "created_by_id", "agent_client_id" FROM ${Prisma.raw(`"${table}"`)}
      WHERE "id" = ${id}::uuid`;
    const row = rows[0];
    if (!row || row.created_by_id !== user.id || row.agent_client_id !== agentClientId) {
      throw new NotFoundException(`${capitalise(label)} not found`);
    }
  }

  private async hasGrant(userId: string, kind: AssistantDecidableKind): Promise<boolean> {
    const grant = await this.prisma.assistantApprovalGrant.findUnique({
      where: { userId_kind: { userId, kind } },
      select: { kind: true },
    });
    return grant !== null;
  }

  /**
   * Runs a create under an idempotency key. `attempt` authorises, then finds the draft under the
   * key (returning it when the request is the same, refusing with keyReused() otherwise) or
   * inserts it. A concurrent create with the same key that inserted first makes this one's insert
   * fail on the unique key; the second attempt then finds it.
   */
  async createIdempotently<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return attempt();
    }
  }
}

/**
 * The decision skeleton every draft type shares, inside one transaction: `lockParents` takes the
 * type's parent locks first (e.g. the shipment), then the draft row is locked. An approval of an
 * approved draft does nothing (returns false); otherwise the draft must be open at `version`,
 * `record` writes the entry through its own service and `mark` stores the decision.
 */
export async function decideInTx(
  tx: Prisma.TransactionClient,
  spec: {
    table: DraftTable;
    id: string;
    version: number;
    label: string;
    approving: boolean;
    lockParents?: () => Promise<void>;
    record?: () => Promise<void>;
  },
): Promise<boolean> {
  await spec.lockParents?.();
  const locked = await lockDraftRow(tx, spec.table, spec.id);
  if (!locked) throw new NotFoundException(`${capitalise(spec.label)} not found`);
  if (spec.approving && locked.state === 'APPROVED') return false;
  requireOpen(locked, spec.version, spec.label);
  await spec.record?.();
  return true;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why a replaced draft was closed (shown with a link to the draft that replaced it). */
export const REPLACED_REASON = 'Replaced by a newer draft';

/** An open draft locked for replacement, checked to be the caller's and in their branches. */
export interface LockedReplacement {
  table: DraftTable;
  id: string;
  userId: string;
  label: string;
  state: DraftState;
  version: number;
  expiresAt: Date;
}

/**
 * Locks the draft a new one replaces, before the new request's key is looked up: an identical
 * retry waits on this lock and then finds the request that won, rather than finding the old
 * draft already closed. Only the same person through the same client replaces a draft, and only
 * in a branch they still hold; anything else reads as not found.
 */
export async function lockReplacedInTx(
  tx: Prisma.TransactionClient,
  id: string | null,
  spec: { table: DraftTable; agentClientId: string; user: AuthUser; label: string },
): Promise<LockedReplacement | null> {
  if (id === null) return null;
  requireDraftTable(spec.table);
  const rows = await tx.$queryRaw<
    {
      state: DraftState;
      version: number;
      expires_at: Date;
      created_by_id: string;
      agent_client_id: string;
      branch_id: string;
    }[]
  >`
    SELECT "state"::text AS "state", "version", "expires_at", "created_by_id", "agent_client_id",
           "branch_id"
    FROM ${Prisma.raw(`"${spec.table}"`)} WHERE "id" = ${id}::uuid FOR UPDATE`;
  const row = rows[0];
  if (
    !row ||
    row.created_by_id !== spec.user.id ||
    row.agent_client_id !== spec.agentClientId ||
    !spec.user.allowedBranchIds.includes(row.branch_id)
  ) {
    throw new NotFoundException(`The ${spec.label} to replace was not found`);
  }
  return {
    table: spec.table,
    id,
    userId: spec.user.id,
    label: spec.label,
    state: row.state,
    version: row.version,
    expiresAt: row.expires_at,
  };
}

/**
 * Closes the draft a new one replaces, in the new draft's transaction: the person asked the
 * assistant for changes to a draft they read, and the assistant proposes the whole draft again.
 * It must still be open (else a conflict); it is closed as rejected from the assistant, so it can
 * never be approved after its replacement exists.
 */
export async function replaceInTx(
  tx: Prisma.TransactionClient,
  locked: LockedReplacement,
): Promise<void> {
  requireOpen(
    { state: locked.state, expiresAt: locked.expiresAt, version: locked.version },
    locked.version,
    locked.label,
  );
  await tx.$executeRaw`
    UPDATE ${Prisma.raw(`"${locked.table}"`)}
    SET "state" = 'REJECTED', "reject_reason" = ${REPLACED_REASON},
        "decided_by_id" = ${locked.userId}::uuid, "decided_at" = CURRENT_TIMESTAMP,
        "decided_via" = 'ASSISTANT', "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${locked.id}::uuid`;
}

/** The parent row an approval locks before the draft, per kind that has one. */
const PARENT_COLUMNS = {
  goods_release_drafts: 'shipment_id',
  shipment_status_drafts: 'shipment_id',
  party_drafts: 'customer_id',
} as const;

/**
 * For kinds whose approval locks the draft's parent (a shipment, a customer) before the draft:
 * the parents a replacement locks before it locks the old draft, so a replacement and an approval
 * take their locks in the same order and cannot wait on each other. The old draft's parent and
 * the new one's, deduplicated, in id order. A draft's parent never changes, so it is read without
 * a lock; a missing old draft is answered by lockReplacedInTx.
 */
export async function replacementParentIds(
  tx: Prisma.TransactionClient,
  table: keyof typeof PARENT_COLUMNS,
  replacesDraftId: string,
  parentId: string,
): Promise<string[]> {
  requireDraftTable(table);
  const column = PARENT_COLUMNS[table];
  const rows = await tx.$queryRaw<{ parent_id: string }[]>`
    SELECT ${Prisma.raw(`"${column}"`)} AS "parent_id" FROM ${Prisma.raw(`"${table}"`)}
    WHERE "id" = ${replacesDraftId}::uuid`;
  return [...new Set([parentId, ...rows.map((r) => r.parent_id)])].sort();
}

/** The draft that replaced this one, if any. */
export async function replacedByOf(
  client: Prisma.TransactionClient,
  table: DraftTable,
  id: string,
): Promise<string | null> {
  requireDraftTable(table);
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "replaces_draft_id" = ${id}::uuid LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** A draft as a person reads it, with the draft that replaced it when it was replaced. */
export async function withReplacedBy<D extends { id: string; status: string }>(
  client: Prisma.TransactionClient,
  table: DraftTable,
  draft: D,
): Promise<D & { replacedByDraftId: string | null }> {
  const replacedByDraftId =
    draft.status === 'REJECTED' ? await replacedByOf(client, table, draft.id) : null;
  return { ...draft, replacedByDraftId };
}

/**
 * The idempotency hash of a create: the type's own request hash, bound to the draft it replaces
 * when it replaces one (unchanged otherwise).
 */
export function withReplaced(hash: string, replacesDraftId: string | null): string {
  return replacesDraftId === null
    ? hash
    : requestHash({ hash, replacesDraftId: replacesDraftId.toLowerCase() });
}

/**
 * Splits `replacesDraftId` off a create body, before the type's own schema reads the rest (which
 * may be a union): a uuid, or absent.
 */
export function splitReplaced(body: unknown): { replacesDraftId: string | null; rest: unknown } {
  if (body === null || typeof body !== 'object' || !Object.hasOwn(body, 'replacesDraftId')) {
    return { replacesDraftId: null, rest: body };
  }
  const { replacesDraftId, ...rest } = body as Record<string, unknown>;
  return { replacesDraftId: parse(z.uuid(), replacesDraftId), rest };
}

/** A "my drafts" read: the user's own drafts, newest first. */
export interface MyDraftsQuery {
  /** The assistant client asking (its row id), when the assistant asks: only its drafts. */
  agentClientId: string | null;
  status?: DraftStatus;
  /** Only drafts created at or after this time. */
  since?: Date;
  /**
   * The next page: drafts after this one in the list's order (createdAt, then id, both newest
   * first), from the last item's createdAt and id. Drafts made in one transaction share a
   * createdAt, so the id breaks the tie; without `beforeId`, only drafts created before `before`.
   */
  before?: Date;
  beforeId?: string;
  limit: number;
}

/** The order of every "my drafts" list and page: newest first, then by id. */
export const MY_DRAFTS_ORDER = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * The drafts made for this user, by the assistant asking when it is one (another assistant
 * client's drafts are not its own). Each kind adds its own branch scope and status filter.
 */
export function mineWhere(
  user: AuthUser,
  query: MyDraftsQuery,
): {
  createdById: string;
  agentClientId?: string;
  createdAt?: { gte: Date };
  AND?: { OR: ({ createdAt: { lt: Date } } | { createdAt: Date; id: { lt: string } })[] }[];
} {
  const { before, beforeId } = query;
  const page = before
    ? [
        {
          OR: [
            { createdAt: { lt: before } },
            ...(beforeId ? [{ createdAt: before, id: { lt: beforeId } }] : []),
          ],
        },
      ]
    : null;
  return {
    createdById: user.id,
    ...(query.agentClientId !== null ? { agentClientId: query.agentClientId } : {}),
    ...(query.since ? { createdAt: { gte: query.since } } : {}),
    ...(page ? { AND: page } : {}),
  };
}

/** Each kind's review page segment (/drafts/<page>/<id> on the web). */
const REVIEW_PAGES: Record<MyDraftKind, string> = {
  booking: 'bookings',
  new_customer_booking: 'new-customer-bookings',
  quotation: 'quotations',
  new_customer_quotation: 'new-customer-quotations',
  invoice: 'invoices',
  receipt: 'receipts',
  trip: 'trips',
  goods_release: 'releases',
  shipment_status: 'shipment-statuses',
  party: 'parties',
  customer: 'customers',
  rate_card: 'rate-cards',
};

/** A "my drafts" item before the branch code is added. */
export type MyDraftRow = Omit<MyDraftItemDto, 'branchCode'>;

/** A kind's list item as "my drafts" shows it, with the record its approval made. */
export function myDraftItem(
  kind: MyDraftKind,
  d: EntryDraftReviewFields,
  result: MyDraftResult | null,
): MyDraftRow {
  return {
    kind,
    id: d.id,
    status: d.status,
    subject: d.subject,
    branchId: d.branchId,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    decidedAt: d.decidedAt,
    decidedByName: d.decidedByName,
    rejectReason: d.rejectReason,
    reviewPath: `/drafts/${REVIEW_PAGES[kind]}/${d.id}`,
    result,
  };
}

/** The idempotency key a pre-check's body is parsed with: a check stores nothing under it. */
const CHECK_KEY = 'pre-check-only';

/**
 * A pre-check's body, ready for the create's own schema: the values only, with no replaced draft
 * and a placeholder key (whatever key was sent is ignored).
 */
export function checkRequest(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const values = Object.entries(body).filter(
    ([key]) => key !== 'replacesDraftId' && key !== 'idempotencyKey',
  );
  return { ...Object.fromEntries(values), idempotencyKey: CHECK_KEY };
}

/** A create request without its idempotency key (each member of a union on its own). */
export type ValuesOf<T> = T extends unknown ? Omit<T, 'idempotencyKey'> : never;

/** A create request without its idempotency key: the values a pre-check checks. */
export function valuesOf<T extends { idempotencyKey: string }>(body: T): ValuesOf<T> {
  const values: Partial<T> = { ...body };
  delete values.idempotencyKey;
  return values as ValuesOf<T>;
}

/**
 * The draft stored under an idempotency key, read before a create checks anything on live data, so
 * a replay is answered with the draft it made (whatever happened since: approved, or the records
 * moved on), not refused by checks that only a new draft must pass. Null when the key is new; a
 * key stored with another request is refused (keyReused). The caller reads the draft back through
 * its scope, so access is still checked as of now. The lookup inside the create's transaction
 * stays: it settles concurrent creates under one key.
 */
export async function storedDraftUnderKey(
  client: Prisma.TransactionClient,
  table: DraftTable,
  scope: KeyScope,
  hash: string,
): Promise<string | null> {
  const row = await draftUnderKey(client, table, scope);
  if (!row) {
    // Refused before any check: the key's outcome is on the ledger (NOT_CREATED, or a draft
    // since purged), and no create under it ever commits.
    if (await ledgerRow(client, table, scope)) throw keySettled();
    return null;
  }
  if (row.payload_hash !== hash) throw keyReused();
  return row.id;
}

/** An assistant client's idempotency key for one user, as a draft table scopes it. */
export interface KeyScope {
  agentClientId: string;
  createdById: string;
  idempotencyKey: string;
}

async function draftUnderKey(
  client: Prisma.TransactionClient,
  table: DraftTable,
  scope: KeyScope,
): Promise<{ id: string; payload_hash: string } | null> {
  requireDraftTable(table);
  const rows = await client.$queryRaw<{ id: string; payload_hash: string }[]>`
    SELECT "id", "payload_hash" FROM ${Prisma.raw(`"${table}"`)}
    WHERE "agent_client_id" = ${scope.agentClientId}::uuid
      AND "created_by_id" = ${scope.createdById}::uuid
      AND "idempotency_key" = ${scope.idempotencyKey}`;
  return rows[0] ?? null;
}

const ledgerKey = (table: DraftTable, scope: KeyScope) => ({
  agentClientId_createdById_draftTable_idempotencyKey: { ...scope, draftTable: table },
});

function ledgerRow(client: Prisma.TransactionClient, table: DraftTable, scope: KeyScope) {
  return client.assistantDraftKey.findUnique({
    where: ledgerKey(table, scope),
    select: { outcome: true, draftId: true, ackedAt: true },
  });
}

/** pg advisory lock namespace (with a hash of the key): "nolon draft idempotency key". */
const KEY_LOCK_NAMESPACE = 72_031_012;

/**
 * Takes the key's lock for the rest of the transaction, then refuses a key whose outcome is on
 * the ledger without a live draft (settled as not created, or created and since purged). Every
 * create takes it before its key lookup, and a settle takes the same lock, so a settle waits for
 * a create in flight to commit (and then finds its draft), and a create after a settle finds the
 * ledger row: "not created" is final, and a purged draft is never created again.
 */
export async function lockKeyInTx(
  tx: Prisma.TransactionClient,
  table: DraftTable,
  scope: KeyScope,
): Promise<void> {
  await takeKeyLock(tx, table, scope);
  if ((await ledgerRow(tx, table, scope)) && !(await draftUnderKey(tx, table, scope))) {
    throw keySettled();
  }
}

async function takeKeyLock(
  tx: Prisma.TransactionClient,
  table: DraftTable,
  scope: KeyScope,
): Promise<void> {
  requireDraftTable(table);
  const name = `${table}:${scope.agentClientId}:${scope.createdById}:${scope.idempotencyKey}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${KEY_LOCK_NAMESPACE}::int, hashtext(${name}))::text`;
}

/**
 * Settles a key whose create the assistant got no answer for: CREATED with the draft committed
 * under it (live, or purged since and kept on the ledger), or NOT_CREATED, recorded so that no
 * create under the key ever commits afterwards. With `ack`, the assistant also says its task
 * under the key is final: the ledger row then goes DRAFT_RETENTION_DAYS later, never before.
 * Asks nothing of the user's permissions or branches (they may have changed since the create);
 * only the same assistant client and user reach their own key.
 */
export async function settleKeyInTx(
  tx: Prisma.TransactionClient,
  table: DraftTable,
  scope: KeyScope,
  ack: boolean,
): Promise<DraftKeySettlementDto> {
  await takeKeyLock(tx, table, scope);
  const draft = await draftUnderKey(tx, table, scope);
  const ledger = await ledgerRow(tx, table, scope);
  const answer: DraftKeySettlementDto = draft
    ? { state: 'CREATED', draftId: draft.id }
    : ledger?.outcome === 'CREATED' && ledger.draftId
      ? { state: 'CREATED', draftId: ledger.draftId }
      : { state: 'NOT_CREATED' };
  const ackedAt = ack ? new Date() : null;
  if (!ledger) {
    await tx.assistantDraftKey.create({
      data: {
        ...scope,
        draftTable: table,
        outcome: answer.state,
        draftId: answer.state === 'CREATED' ? answer.draftId : null,
        ackedAt,
      },
    });
  } else if (ackedAt && !ledger.ackedAt) {
    await tx.assistantDraftKey.update({ where: ledgerKey(table, scope), data: { ackedAt } });
  }
  return answer;
}

/**
 * Before the retention purge deletes drafts, inside its transaction: a CREATED ledger row for
 * every draft of `table` it may delete, so a settle after the purge still answers CREATED and
 * the key is never used again. Covers at least what the purge removes (removable(cutoff)).
 */
export async function recordPurgedKeysInTx(
  tx: Prisma.TransactionClient,
  table: DraftTable,
  cutoff: Date,
): Promise<number> {
  requireDraftTable(table);
  return tx.$executeRaw`
    INSERT INTO "assistant_draft_keys"
      ("agent_client_id", "created_by_id", "draft_table", "idempotency_key", "outcome", "draft_id")
    SELECT "agent_client_id", "created_by_id", ${table}, "idempotency_key", 'CREATED', "id"
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE ("state" = 'REJECTED' AND "decided_at" <= ${cutoff})
       OR ("state" = 'DRAFT' AND "expires_at" <= ${cutoff})
    ON CONFLICT DO NOTHING`;
}

/** A create under a key whose outcome is already settled (for the assistant only). */
export function keySettled(): ConflictException {
  return new ConflictException({
    message: 'This idempotency key is settled; use a new key',
    code: 'KEY_SETTLED',
    params: {},
    fields: [],
    error: 'Conflict',
    statusCode: 409,
  });
}

/** A key reused for another request: reveals nothing about the stored draft. */
export function keyReused(): ConflictException {
  return new ConflictException('This idempotency key was used for another request');
}

/** Draft tables a row lock may name (a closed list: the name goes into the SQL text). */
export const DRAFT_TABLES = [
  'grn_drafts',
  'quotation_drafts',
  'booking_drafts',
  'trip_drafts',
  'goods_release_drafts',
  'invoice_drafts',
  'receipt_drafts',
  'customer_drafts',
  'shipment_status_drafts',
  'party_drafts',
  'rate_card_drafts',
  'new_customer_booking_drafts',
  'new_customer_quotation_drafts',
] as const;
export type DraftTable = (typeof DRAFT_TABLES)[number];

/** A draft row as locked for a change. */
export interface LockedDraftRow {
  id: string;
  state: DraftState;
  version: number;
  expiresAt: Date;
}

/**
 * Locks a draft row (SELECT ... FOR UPDATE) and returns what every change checks. The caller
 * checks visibility first, through its own scope, and takes its parent lock (e.g. the shipment)
 * before this one.
 */
export async function lockDraftRow(
  tx: Prisma.TransactionClient,
  table: DraftTable,
  id: string,
): Promise<LockedDraftRow | null> {
  requireDraftTable(table);
  const rows = await tx.$queryRaw<
    { id: string; state: DraftState; version: number; expires_at: Date }[]
  >`
    SELECT "id", "state"::text AS "state", "version", "expires_at"
    FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid FOR UPDATE`;
  const row = rows[0];
  return row
    ? { id: row.id, state: row.state, version: row.version, expiresAt: row.expires_at }
    : null;
}

function requireDraftTable(table: string): void {
  if (!(DRAFT_TABLES as readonly string[]).includes(table)) {
    throw new Error(`Not a draft table: ${table}`);
  }
}
