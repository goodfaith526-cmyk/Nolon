import { createHash } from 'node:crypto';
import {
  GRN_DRAFT_LINE_FIELDS,
  type GrnDraftFieldMeta,
  type GrnDraftLineField,
  type GrnDraftLineValues,
  type GrnDraftStatus,
  type GrnFieldMatch,
} from '@nolon/shared';
import { type Decimal, dec } from '../common/money.js';

/** A line's values as stored: decimals as Decimal, everything else as is. */
export interface StoredLineValues {
  marks: string | null;
  description: string | null;
  packageCount: number | null;
  packageType: string | null;
  quantity: Decimal | null;
  unit: string | null;
  grossKg: Decimal | null;
  netKg: Decimal | null;
  cbm: Decimal | null;
}

export type FieldMeta = Partial<Record<GrnDraftLineField, GrnDraftFieldMeta>>;

const DECIMAL_FIELDS = new Set<GrnDraftLineField>(['quantity', 'grossKg', 'netKg', 'cbm']);

/** Stored values from request values (decimal strings already validated). */
export function storedValues(values: Partial<GrnDraftLineValues>): StoredLineValues {
  const decimal = (v: string | null | undefined) => (v === null || v === undefined ? null : dec(v));
  return {
    marks: values.marks ?? null,
    description: values.description ?? null,
    packageCount: values.packageCount ?? null,
    packageType: values.packageType ?? null,
    quantity: decimal(values.quantity),
    unit: values.unit ?? null,
    grossKg: decimal(values.grossKg),
    netKg: decimal(values.netKg),
    cbm: decimal(values.cbm),
  };
}

function sameValue(field: GrnDraftLineField, a: StoredLineValues, b: StoredLineValues): boolean {
  const x = a[field];
  const y = b[field];
  if (x === null || y === null) return x === y;
  if (DECIMAL_FIELDS.has(field)) return (x as Decimal).equals(y);
  return x === y;
}

/**
 * Field metadata of a line the assistant proposed: every field holding a value was filled by AI,
 * with what the assistant's code reported about it (UNVERIFIED when it reported nothing).
 */
export function metaForAiLine(
  values: StoredLineValues,
  match: Partial<Record<GrnDraftLineField, GrnFieldMatch>> | undefined,
): FieldMeta {
  const meta: FieldMeta = {};
  for (const field of GRN_DRAFT_LINE_FIELDS) {
    if (values[field] !== null) {
      meta[field] = { filledBy: 'AI', match: match?.[field] ?? 'UNVERIFIED' };
    }
  }
  return meta;
}

/**
 * Field metadata after a person edits a line: a value left as it was keeps its metadata; a value
 * typed or changed is the person's (STAFF, nothing matched); an emptied field has none.
 */
export function metaAfterEdit(
  before: { values: StoredLineValues; meta: FieldMeta } | undefined,
  values: StoredLineValues,
): FieldMeta {
  const meta: FieldMeta = {};
  for (const field of GRN_DRAFT_LINE_FIELDS) {
    if (values[field] === null) continue;
    const kept = before?.meta[field];
    meta[field] =
      before && kept && sameValue(field, before.values, values)
        ? kept
        : { filledBy: 'STAFF', match: null };
  }
  return meta;
}

/** Sums of the lines; null for a total no line has a value for. */
export function lineTotals(lines: readonly StoredLineValues[]): {
  packages: number | null;
  grossKg: Decimal | null;
  netKg: Decimal | null;
  cbm: Decimal | null;
} {
  const sumDecimal = (field: 'grossKg' | 'netKg' | 'cbm') => {
    const values = lines.map((l) => l[field]).filter((v): v is Decimal => v !== null);
    return values.length === 0 ? null : values.reduce((a, b) => a.plus(b), dec(0));
  };
  const counts = lines.map((l) => l.packageCount).filter((v): v is number => v !== null);
  return {
    packages: counts.length === 0 ? null : counts.reduce((a, b) => a + b, 0),
    grossKg: sumDecimal('grossKg'),
    netKg: sumDecimal('netKg'),
    cbm: sumDecimal('cbm'),
  };
}

/** An undecided draft past its expiry reads as EXPIRED. */
export function draftStatus(
  state: 'DRAFT' | 'APPROVED' | 'REJECTED',
  expiresAt: Date,
  now: Date,
): GrnDraftStatus {
  if (state === 'DRAFT' && expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return state;
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

/**
 * sha256 of a normalised create request, without its idempotency key: decimals in canonical form
 * ("1.50" and "1.5" are one value), missing and null alike, keys sorted.
 */
export function payloadHash(request: {
  documentId: string;
  documentSha256: string;
  statedTotals: StoredTotals;
  warnings: readonly string[];
  lines: readonly {
    values: StoredLineValues;
    sourcePage: number | null;
    sourceRow: number | null;
    meta: FieldMeta;
  }[];
}): string {
  const decimal = (v: Decimal | null) => (v === null ? null : v.toString());
  const normalised = {
    documentId: request.documentId.toLowerCase(),
    documentSha256: request.documentSha256,
    statedTotals: {
      packages: request.statedTotals.packages,
      grossKg: decimal(request.statedTotals.grossKg),
      netKg: decimal(request.statedTotals.netKg),
      cbm: decimal(request.statedTotals.cbm),
    },
    warnings: [...request.warnings].sort(),
    lines: request.lines.map((l) => ({
      ...l.values,
      quantity: decimal(l.values.quantity),
      grossKg: decimal(l.values.grossKg),
      netKg: decimal(l.values.netKg),
      cbm: decimal(l.values.cbm),
      sourcePage: l.sourcePage,
      sourceRow: l.sourceRow,
      meta: l.meta,
    })),
  };
  return createHash('sha256').update(canonicalJson(normalised)).digest('hex');
}

export interface StoredTotals {
  packages: number | null;
  grossKg: Decimal | null;
  netKg: Decimal | null;
  cbm: Decimal | null;
}
