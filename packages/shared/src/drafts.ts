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
