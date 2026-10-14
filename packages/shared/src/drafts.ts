import type { FormRefusal } from './commercial.js';
import type { DraftPriceSource } from './commercial-drafts.js';
import type { DecimalString } from './currencies.js';

/**
 * Entry drafts proposed by the staff AI assistant (erp-agents docs/packing-list-grn-drafts.md,
 * the first type). The assistant proposes; a person reviews, edits, approves or rejects; an
 * approval records the real entry through NOLON's own service with that person's permissions and
 * branch. The assistant never approves, edits or posts. Every entry type has its own tables (real
 * Decimal columns and database checks) and shares the rules below.
 */

/** An undecided draft past its expiry reads as EXPIRED; nothing can change it. */
export const DRAFT_STATUSES = ['DRAFT', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Days a draft stays open for review (owner decision, 2026-10-10). */
export const DRAFT_TTL_DAYS = 7;

/**
 * Days after a draft's expiry during which the record of what the assistant proposed cannot be
 * removed (data governance v2.1, section 4: 90 days from expiry or rejection, to be confirmed).
 * A draft is decided before it expires, so this is never less than 90 days after a decision.
 */
export const DRAFT_PROPOSAL_RETENTION_DAYS = 90;

/**
 * Days an undecided draft is kept after its expiry, and a rejected draft after its rejection,
 * before the retention purge removes it with its lines (data governance v2.1, section 4). An
 * approved draft is kept: it is the record behind the entry it created.
 */
export const DRAFT_RETENTION_DAYS = 90;

/** Who filled a value: the assistant, or a person on the review screen. */
export const DRAFT_FIELD_SOURCES = ['AI', 'STAFF'] as const;
export type DraftFieldSource = (typeof DRAFT_FIELD_SOURCES)[number];

/**
 * What code could check about an AI-filled value against a source document. MATCHED means only
 * that the value was found in the source at the stated position, not that its meaning is right.
 * Drafts with no source document carry null.
 */
export const DRAFT_FIELD_MATCHES = ['MATCHED', 'UNVERIFIED', 'MISMATCH'] as const;
export type DraftFieldMatch = (typeof DRAFT_FIELD_MATCHES)[number];

export interface DraftFieldMeta {
  filledBy: DraftFieldSource;
  /** Null for a value a person typed, or a draft with no source document. */
  match: DraftFieldMatch | null;
}

/** Idempotency keys the assistant sends: scoped to the assistant client and the user. */
export const DRAFT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

export interface DraftActions {
  canEdit: boolean;
  canDecide: boolean;
}

export interface DraftRejectRequest {
  version: number;
  reason: string;
}

/** What the assistant gets back: ids, status and counts, never the values it sent. */
export interface EntryDraftSummaryDto {
  id: string;
  status: DraftStatus;
  version: number;
  lineCount: number;
  expiresAt: string;
  createdAt: string;
}

/**
 * The staff member's own words for one value of a draft (`field`: its path in the request, such
 * as `status` or `shipmentId`), as the assistant checked them against the conversation. Drafts
 * decided on the review screen only carry them, and the person ticks each value against its
 * words before approving.
 */
export interface DraftEvidence {
  field: string;
  quote: string;
}

/** The words of a review-screen draft, and what an approval sends back: each field it ticked. */
export interface EvidenceReviewFields {
  evidence: DraftEvidence[];
}

/** Common to every draft a person reviews. */
export interface EntryDraftReviewFields {
  id: string;
  branchId: string;
  /** What the draft is about, for lists: the customer, the route, the shipment... */
  subject: string;
  status: DraftStatus;
  version: number;
  expiresAt: string;
  createdAt: string;
  /** The staff member the assistant acted for. */
  createdByName: string;
  decidedByName: string | null;
  decidedAt: string | null;
  /** The person decided in the assistant's chat (assistant approval), not on the review screen. */
  decidedFromAssistant: boolean;
  rejectReason: string | null;
  actions: DraftActions;
  /** The draft this one replaced, when the person asked the assistant for changes. */
  replacesDraftId: string | null;
  /** The draft that replaced this one (read on a single draft only). */
  replacedByDraftId?: string | null;
}

/**
 * Whether the draft would be accepted by NOLON now, worked out on every read by the same checks
 * an approval runs (nothing is written). `message` is NOLON's own refusal.
 */
export type EntryDraftCheck =
  | { ok: true; total: DecimalString | null; currency: string | null }
  | { ok: false; message: string };

/** POST .../approve: the version the person reviewed. */
export interface EntryDraftApproveRequest {
  version: number;
}

/**
 * Entry kinds a person may approve or reject from the assistant's chat (erp-agents
 * docs/chat-draft-approval.md), once an admin granted that kind to them. GRN drafts are not among
 * them: their approval needs the receipt details a person enters on the review screen.
 */
export const ASSISTANT_DECIDABLE_KINDS = [
  'quotation',
  'booking',
  'trip',
  'goods_release',
  'invoice',
  'receipt',
] as const;
export type AssistantDecidableKind = (typeof ASSISTANT_DECIDABLE_KINDS)[number];

/** A draft as the assistant's chat card shows it, with what an approval must repeat. */
export interface AssistantDraftDto<D> {
  kind: AssistantDecidableKind;
  /** Fingerprint of the proposed content; an approval sends it back with the version. */
  contentHash: string;
  /** The user holds the grant for this kind (the route's permission is checked on decision). */
  canDecideFromAssistant: boolean;
  draft: D;
  /**
   * A readable name for each id in the draft's proposed values that the user may see. The card
   * shows names, never bare ids; an id missing here sends the person to the review screen.
   */
  names: Record<string, string>;
}

export interface AssistantDraftApproveRequest {
  version: number;
  contentHash: string;
}

/** The kinds a user may decide from the assistant's chat. */
export interface AssistantApprovalGrantsDto {
  userId: string;
  kinds: AssistantDecidableKind[];
}

/**
 * One reason a pre-check refused the values: the field it is about (its path in the request, null
 * when the reason names none), NOLON's code for it (`INVALID` for a malformed value, null when the
 * reason has none), the English message and its params.
 */
export interface DraftCheckRefusal {
  field: string | null;
  code: FormRefusal | 'INVALID' | null;
  message: string;
  params: Record<string, string>;
}

/**
 * POST /<kind>-drafts/check: what a create with these values would get from NOLON now, for this
 * user, without creating anything. `valuesHash` fingerprints the values checked (null when the
 * body is malformed), so the assistant can tie the result to the values it holds; a create runs
 * every check again. A refusal of the route itself (missing permission) stays an HTTP error.
 */
export type DraftPreCheckDto =
  | {
      ok: true;
      valuesHash: string;
      total: DecimalString | null;
      currency: string | null;
      /** The price of each line, for quotation and invoice drafts; null for other kinds. */
      priceSources: DraftPriceSource[] | null;
    }
  | { ok: false; valuesHash: string | null; refusals: DraftCheckRefusal[] };
