import { createHash } from 'node:crypto';
import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import {
  DRAFT_INCOMPLETE,
  DRAFT_PROPOSAL_RETENTION_DAYS,
  DRAFT_TTL_DAYS,
  type DraftFieldMatch,
  type DraftFieldMeta,
  type DraftCheckRefusal,
  type DraftComputedValue,
  type DraftPreCheckDto,
  type DraftPriceSource,
  type DraftStatus,
  type EntryDraftCheck,
  FORM_REFUSALS,
  type FormRefusal,
} from '@nolon/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import { fieldRefusal } from '../common/validation.js';
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

/** Until when the record of an assistant's proposal is kept, for a draft expiring then. */
export function proposalRetainedUntil(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + DRAFT_PROPOSAL_RETENTION_DAYS * DAY_MS);
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

/**
 * A value of a draft that its missing fields said is there (a draft is saved with missing values,
 * MissingFieldsReview): absent here is a bug, not a refusal.
 */
export function storedValue<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Entry draft has no ${what}`);
  return value;
}

/**
 * The branch a draft is saved in (no-required-fields plan, section 1). The branch is security
 * context, never a business field, so it is never missing:
 * - a draft whose parent is given (its customer, its shipment, its quotation) belongs to the
 *   parent's branch; a branch given with it must be that one (400 BRANCH_MISMATCH), and it must be
 *   one of the user's branches (403). A parent's lookup may see more than the user's branches (a
 *   shipment shared with one of them), so a draft is never filed in a branch the user lacks;
 * - a draft with no parent yet names its branch (400 BRANCH_REQUIRED otherwise), and that branch
 *   must be one of the user's branches now, as NOLON loads them for this request (403).
 */
export function draftBranch(
  user: AuthUser,
  given: string | null | undefined,
  parentBranchId: string | null,
): string {
  const named = given ? given.toLowerCase() : null;
  if (parentBranchId !== null) {
    if (named !== null && named !== parentBranchId.toLowerCase()) {
      throw fieldRefusal('BRANCH_MISMATCH', 'This branch is not the branch of the record', [
        'branchId',
      ]);
    }
    assertBranchAccess(user, parentBranchId);
    return parentBranchId;
  }
  if (named === null) {
    throw fieldRefusal('BRANCH_REQUIRED', 'Choose the branch of this draft', ['branchId']);
  }
  assertBranchAccess(user, named);
  return named;
}

/**
 * A create request's hash with the branch it named, when it named one: a request that names no
 * branch (every complete request an older client sends) hashes exactly as before.
 */
export function withBranch(hash: string, branchId: string | null | undefined): string {
  return branchId ? requestHash({ hash, branchId: branchId.toLowerCase() }) : hash;
}

/** The path of a line's field in a request, as missing fields name it: `lines[0].quantity`. */
export function linePath(list: string, index: number, field: string): string {
  return `${list}[${index}].${field}`;
}

/** Each of `fields` that `values` does not hold (null or absent), in order. */
export function missingOf<T extends object>(values: T, fields: readonly (keyof T & string)[]) {
  return fields.filter((field) => values[field] === null || values[field] === undefined);
}

/**
 * An approval refused while the draft misses values, or holds values the record would refuse
 * (422): nothing is recorded, and the body names each one (`missingFields`, `invalidFields`, and
 * both in `fields` where the web reads a refusal's fields).
 */
export function draftIncomplete(
  missingFields: readonly string[],
  invalidFields: readonly string[] = [],
): HttpException {
  const reasons = [
    ...(missingFields.length > 0 ? [`missing required values: ${missingFields.join(', ')}`] : []),
    ...(invalidFields.length > 0 ? [`holding invalid values: ${invalidFields.join(', ')}`] : []),
  ];
  return new HttpException(
    {
      message: `This draft is ${reasons.join('; ')}`,
      code: DRAFT_INCOMPLETE,
      missingFields: [...missingFields],
      invalidFields: [...invalidFields],
      fields: [...new Set([...missingFields, ...invalidFields])],
      params: {},
      error: 'Unprocessable Entity',
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * A draft's values after a person's edit: each value the edit gives replaces the draft's (null
 * clears it); a value it leaves out stays as it was.
 */
export function patched<T extends object>(current: T, patch: Partial<T>): T {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) next[key] = value;
  }
  return next;
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

/** Where-fragment for a status, EXPIRED being an undecided draft past its expiry. */
export function stateFilter(
  status: DraftStatus | undefined,
  now: Date,
): { state?: DraftState; expiresAt?: { gt: Date } | { lte: Date } } {
  if (status === undefined) return {};
  if (status === 'DRAFT') return { state: 'DRAFT', expiresAt: { gt: now } };
  if (status === 'EXPIRED') return { state: 'DRAFT', expiresAt: { lte: now } };
  return { state: status };
}

/** The refusals a check reports as its message (a coded refusal is a plain HttpException). */
const REFUSALS: readonly number[] = [
  HttpStatus.BAD_REQUEST,
  HttpStatus.FORBIDDEN,
  HttpStatus.NOT_FOUND,
  HttpStatus.CONFLICT,
];

/** Whether an error is NOLON refusing a request (400, 403, 404, 409), not a failure. */
export function isRefusal(error: unknown): error is HttpException {
  return error instanceof HttpException && REFUSALS.includes(error.getStatus());
}

/**
 * Whether NOLON would accept a draft now: runs `prepare` (the same checks as an approval, without
 * writing) and turns a refusal into its message.
 */
export async function checkDraft(
  prepare: () => Promise<{ total: string | null; currency: string | null }>,
): Promise<EntryDraftCheck> {
  try {
    return { ok: true, ...(await prepare()) };
  } catch (error) {
    if (isRefusal(error)) return { ok: false, message: error.message };
    throw error;
  }
}

/** What a pre-check reports when the values pass. */
export interface PreCheckResult {
  total: string | null;
  currency: string | null;
  priceSources?: DraftPriceSource[] | null;
  computed?: DraftComputedValue[];
  /** For kinds saved with missing values: what a draft of these values would still miss. */
  missingFields?: string[];
}

const NO_TOTAL: PreCheckResult = { total: null, currency: null };

/**
 * A pre-check (POST /<kind>-drafts/check): runs `prepare`, the checks a create with these values
 * runs, and nothing else (it writes nothing). A refusal comes back as data with the fields it
 * names, so the assistant can show it under the field; any other failure propagates.
 */
export async function preCheck(
  valuesHash: string,
  prepare: () => Promise<PreCheckResult | void>,
): Promise<DraftPreCheckDto> {
  try {
    const result = (await prepare()) ?? NO_TOTAL;
    return {
      ok: true,
      valuesHash,
      total: result.total,
      currency: result.currency,
      priceSources: result.priceSources ?? null,
      computed: result.computed ?? [],
      ...(result.missingFields ? { missingFields: result.missingFields } : {}),
    };
  } catch (error) {
    if (isRefusal(error)) return { ok: false, valuesHash, refusals: refusalsOf(error) };
    throw error;
  }
}

/**
 * The body of a pre-check, parsed with the create's schema. A malformed body is a refusal per
 * invalid path (`INVALID`), with no values hash: there are no values to tie it to.
 */
export async function preCheckBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  check: (input: T) => Promise<DraftPreCheckDto>,
): Promise<DraftPreCheckDto> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return check(parsed.data);
  return {
    ok: false,
    valuesHash: null,
    refusals: parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join('.') : null,
      code: 'INVALID',
      message: issue.message,
      params: {},
    })),
  };
}

/** A refusal's response (`fieldRefusal`, `codedRefusal` or a plain message), one per field. */
function refusalsOf(error: HttpException): DraftCheckRefusal[] {
  const response = error.getResponse();
  const body = typeof response === 'object' && response !== null ? response : {};
  const raw = body as { message?: unknown; code?: unknown; fields?: unknown; params?: unknown };
  // `parse` inside a service: the message is the list of invalid paths.
  if (Array.isArray(raw.message)) {
    return raw.message.map((path) => ({
      field: String(path),
      code: 'INVALID',
      message: 'Invalid value',
      params: {},
    }));
  }
  const message = typeof raw.message === 'string' ? raw.message : error.message;
  const code = FORM_REFUSALS.includes(raw.code as FormRefusal) ? (raw.code as FormRefusal) : null;
  const params: Record<string, string> = {};
  if (typeof raw.params === 'object' && raw.params !== null) {
    for (const [key, value] of Object.entries(raw.params)) {
      if (typeof value === 'string') params[key] = value;
    }
  }
  const fields = Array.isArray(raw.fields)
    ? raw.fields.filter((f): f is string => typeof f === 'string')
    : [];
  if (fields.length === 0) return [{ field: null, code, message, params }];
  return fields.map((field) => ({ field, code, message, params }));
}

/** The fields of a decision, as the draft row stores them. */
export function approvedFields(
  user: { id: string },
  via: 'SESSION' | 'ASSISTANT' = 'SESSION',
): {
  state: 'APPROVED';
  decidedById: string;
  decidedAt: Date;
  decidedVia: 'SESSION' | 'ASSISTANT';
  version: { increment: number };
} {
  return {
    state: 'APPROVED',
    decidedById: user.id,
    decidedAt: new Date(),
    decidedVia: via,
    version: { increment: 1 },
  };
}

export function rejectedFields(
  user: { id: string },
  reason: string,
  via: 'SESSION' | 'ASSISTANT' = 'SESSION',
): {
  state: 'REJECTED';
  rejectReason: string;
  decidedById: string;
  decidedAt: Date;
  decidedVia: 'SESSION' | 'ASSISTANT';
  version: { increment: number };
} {
  return {
    state: 'REJECTED',
    rejectReason: reason,
    decidedById: user.id,
    decidedAt: new Date(),
    decidedVia: via,
    version: { increment: 1 },
  };
}

/**
 * Fingerprint of what an approval would record now, as the type's service resolved it (rate card
 * prices, totals): decimals by value, dates as instants. Bound to the chat card, so a value that
 * changed since the card was shown asks for a reload instead of being recorded unseen.
 */
export function resolvedKey(value: unknown): string {
  const normal = (v: unknown): unknown => {
    if (v instanceof Prisma.Decimal) return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normal);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normal(x)]));
    }
    return v;
  };
  return requestHash(normal(value));
}

/** Review fields that change between reads without the draft changing. */
const VOLATILE_REVIEW_FIELDS = new Set(['actions', 'check', 'status']);

/**
 * Fingerprint of a draft as a person reads it (its DTO, without the fields recomputed on every
 * read). An approval from the assistant's chat repeats it, so what is approved is what the card
 * showed; any change in between (a renamed customer included) asks for a reload.
 */
export function contentHashOf(draft: object): string {
  const stable = Object.fromEntries(
    Object.entries(draft).filter(([key]) => !VOLATILE_REVIEW_FIELDS.has(key)),
  );
  return requestHash(stable);
}
