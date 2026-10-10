import {
  GRN_DRAFT_LINE_FIELDS,
  GRN_DRAFT_WARNINGS,
  type GrnDraftLineField,
  type GrnDraftLineValues,
  type GrnDraftWarning,
  type GrnFieldMatch,
} from '@nolon/shared';
import { type Decimal, dec } from '../common/money.js';
import {
  type FieldMetaOf,
  decimalKey,
  metaAfterEdit as metaAfterEditOf,
  metaForAi,
  requestHash,
} from '../drafts/draft-rules.js';

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

export type FieldMeta = FieldMetaOf<GrnDraftLineField>;

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

/**
 * Field metadata of a line the assistant proposed: every field holding a value was filled by AI,
 * with what the assistant's code reported about it (UNVERIFIED when it reported nothing).
 */
export function metaForAiLine(
  values: StoredLineValues,
  match: Partial<Record<GrnDraftLineField, GrnFieldMatch>> | undefined,
): FieldMeta {
  return metaForAi(GRN_DRAFT_LINE_FIELDS, values, match, 'UNVERIFIED');
}

/**
 * Field metadata after a person edits a line: a value left as it was keeps its metadata; a value
 * typed or changed is the person's (STAFF, nothing matched); an emptied field has none.
 */
export function metaAfterEdit(
  before: { values: StoredLineValues; meta: FieldMeta } | undefined,
  values: StoredLineValues,
): FieldMeta {
  return metaAfterEditOf(GRN_DRAFT_LINE_FIELDS, before, values);
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

export { canonicalJson, draftStatus } from '../drafts/draft-rules.js';

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
  const decimal = decimalKey;
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
  return requestHash(normalised);
}

export interface StoredTotals {
  packages: number | null;
  grossKg: Decimal | null;
  netKg: Decimal | null;
  cbm: Decimal | null;
}

/**
 * Warnings that follow from the values themselves. They are never taken from the assistant or
 * stored: they are worked out from the stated totals and the current lines each time a draft is
 * read, so an edit that opens or closes a difference shows at once.
 */
const DERIVED_WARNINGS = new Set<GrnDraftWarning>([
  'TOTAL_PACKAGES_MISMATCH',
  'TOTAL_GROSS_MISMATCH',
  'TOTAL_NET_MISMATCH',
  'TOTAL_CBM_MISMATCH',
  'NET_ABOVE_GROSS',
]);

/** The warnings the assistant may report and that are stored (about the file, not the values). */
export function reportedWarnings(warnings: readonly GrnDraftWarning[]): GrnDraftWarning[] {
  return GRN_DRAFT_WARNINGS.filter((w) => !DERIVED_WARNINGS.has(w) && warnings.includes(w));
}

/**
 * A draft's warnings: the stored reported ones plus those the stated totals and the current lines
 * give. A total stated on the document differs when the lines add up to another value or carry
 * none. Net above gross is checked on each line and on the line totals.
 */
export function draftWarnings(
  stored: readonly string[],
  stated: StoredTotals,
  lines: readonly StoredLineValues[],
): GrnDraftWarning[] {
  const sums = lineTotals(lines);
  const differs = (a: Decimal | null, b: Decimal | null) =>
    a !== null && (b === null || !a.equals(b));
  const found = new Set<GrnDraftWarning>(
    reportedWarnings(stored.filter((w): w is GrnDraftWarning => isWarning(w))),
  );
  if (stated.packages !== null && stated.packages !== sums.packages) {
    found.add('TOTAL_PACKAGES_MISMATCH');
  }
  if (differs(stated.grossKg, sums.grossKg)) found.add('TOTAL_GROSS_MISMATCH');
  if (differs(stated.netKg, sums.netKg)) found.add('TOTAL_NET_MISMATCH');
  if (differs(stated.cbm, sums.cbm)) found.add('TOTAL_CBM_MISMATCH');
  const netAboveGross = (v: { grossKg: Decimal | null; netKg: Decimal | null }) =>
    v.grossKg !== null && v.netKg !== null && v.netKg.greaterThan(v.grossKg);
  if (lines.some(netAboveGross) || netAboveGross(sums)) found.add('NET_ABOVE_GROSS');
  return GRN_DRAFT_WARNINGS.filter((w) => found.has(w));
}

function isWarning(value: string): value is GrnDraftWarning {
  return (GRN_DRAFT_WARNINGS as readonly string[]).includes(value);
}
