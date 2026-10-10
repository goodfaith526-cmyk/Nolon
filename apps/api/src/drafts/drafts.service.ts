import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AssistantDecidableKind, AssistantDraftDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type DraftState, contentHashOf, requireOpen } from './draft-rules.js';
import { referenceNames } from './reference-names.js';

const ASSISTANT_DECISION: unique symbol = Symbol('assistant decision');

/**
 * Proof that a decision from the assistant's chat passed authorizeAssistant: only that method
 * builds one, so a draft service decides with a delegated token only after it.
 */
export interface AssistantDecision {
  readonly [ASSISTANT_DECISION]: true;
  readonly draftId: string;
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
  ): Promise<AssistantDraftDto<D>> {
    await this.requireOwnDraft(user, table, draft.id, label);
    const names = await referenceNames(this.prisma, user, draft.request);
    return {
      kind,
      contentHash: contentHashOf({ ...draft, names }),
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
      contentHash === null ? {} : await referenceNames(this.prisma, user, draft.request);
    if (contentHash !== null && contentHash !== contentHashOf({ ...draft, names })) {
      throw new ConflictException(`This ${label} changed since you opened it: reload it`);
    }
    return { [ASSISTANT_DECISION]: true, draftId: draft.id };
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
