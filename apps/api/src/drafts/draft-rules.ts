import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  DRAFT_TTL_DAYS,
  type DraftFieldMatch,
  type DraftFieldMeta,
  type DraftStatus,
} from '@nolon/shared';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Rules every entry draft type shares (GRN drafts first). A type keeps its own tables and its own
 * field list; these work over any field list.
 */

export type DraftState = 'DRAFT' | 'APPROVED' | 'REJECTED';

export type FieldMetaOf<F extends string> = Partial<Record<F, DraftFieldMeta>>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a draft created now stops being open for review. */
export function draftExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + DRAFT_TTL_DAYS * DAY_MS);
}

/** An undecided draft past its expiry reads as EXPIRED. */
export function draftStatus(state: DraftState, expiresAt: Date, now: Date): DraftStatus {
  if (state === 'DRAFT' && expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return state;
}

/**
 * A change is allowed only on an undecided, unexpired draft at the version the person read.
 * `label` names the entry in the messages ("GRN draft", "quotation draft").
 */
export function requireOpen(
  draft: { state: DraftState; expiresAt: Date; version: number },
  version: number,
  label: string,
  now: Date = new Date(),
): void {
  const status = draftStatus(draft.state, draft.expiresAt, now);
  if (status === 'EXPIRED') throw new ConflictException(`This ${label} has expired`);
  if (status !== 'DRAFT') throw new ConflictException(`This ${label} is already decided`);
  if (draft.version !== version) {
    throw new ConflictException(`This ${label} changed since you opened it: reload it`);
  }
}

/** JSON with object keys sorted at every level, so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of a normalised request (the caller puts decimals in canonical form first). */
export function requestHash(normalised: unknown): string {
  return createHash('sha256').update(canonicalJson(normalised)).digest('hex');
}

/** Canonical text of a decimal for hashing: "1.50" and "1.5" are one value. */
export function decimalKey(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

/** A stored value compared with another: decimals by value, everything else strictly. */
export function sameStoredValue(x: unknown, y: unknown): boolean {
  if (x === null || y === null) return x === y;
  if (x instanceof Prisma.Decimal && y instanceof Prisma.Decimal) return x.equals(y);
  if (x instanceof Date && y instanceof Date) return x.getTime() === y.getTime();
  return x === y;
}

/**
 * Field metadata of values the assistant proposed: every field holding a value was filled by AI,
 * with what its code reported about the value against a source (`fallback` when it reported
 * nothing: UNVERIFIED for a draft read from a document, null for one with no document).
 */
export function metaForAi<F extends string>(
  fields: readonly F[],
  values: Readonly<Record<F, unknown>>,
  match: Partial<Record<F, DraftFieldMatch>> | undefined,
  fallback: DraftFieldMatch | null,
): FieldMetaOf<F> {
  const meta: FieldMetaOf<F> = {};
  for (const field of fields) {
    if (values[field] !== null) {
      meta[field] = { filledBy: 'AI', match: match?.[field] ?? fallback };
    }
  }
  return meta;
}

/**
 * Field metadata after a person edits: a value left as it was keeps its metadata; a value typed
 * or changed is the person's (STAFF, nothing matched); an emptied field has none.
 */
export function metaAfterEdit<F extends string>(
  fields: readonly F[],
  before: { values: Readonly<Record<F, unknown>>; meta: FieldMetaOf<F> } | undefined,
  values: Readonly<Record<F, unknown>>,
): FieldMetaOf<F> {
  const meta: FieldMetaOf<F> = {};
  for (const field of fields) {
    if (values[field] === null) continue;
    const kept = before?.meta[field];
    meta[field] =
      before && kept && sameStoredValue(before.values[field], values[field])
        ? kept
        : { filledBy: 'STAFF', match: null };
  }
  return meta;
}

/** The field metadata as a JSON object (only the fields that hold a value). */
export function metaJson(meta: Partial<Record<string, DraftFieldMeta>>): Prisma.InputJsonObject {
  const json: Record<string, Prisma.InputJsonObject> = {};
  for (const [field, entry] of Object.entries(meta)) {
    if (entry) json[field] = { filledBy: entry.filledBy, match: entry.match };
  }
  return json;
}
