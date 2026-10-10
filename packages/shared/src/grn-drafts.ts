import type { DecimalString } from './currencies.js';
import type { GoodsReceiptRequest } from './warehouse.js';

/**
 * Draft goods received notes (Document Pilot, erp-agents docs/packing-list-grn-drafts.md). The
 * staff AI assistant reads a shipment's packing list and proposes a draft; a person reviews it next
 * to the source file and approves it, which records an ordinary goods receipt (GRN). The assistant
 * can create a draft and nothing else.
 */

/** A draft past its expiry that was never decided reads as EXPIRED; nothing can change it. */
export const GRN_DRAFT_STATUSES = ['DRAFT', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type GrnDraftStatus = (typeof GRN_DRAFT_STATUSES)[number];

/** Days a draft stays open for review (owner decision, 2026-10-10). */
export const GRN_DRAFT_TTL_DAYS = 7;

/** Lines per draft, and the line fields a draft carries. */
export const GRN_DRAFT_MAX_LINES = 300;

export const GRN_DRAFT_LINE_FIELDS = [
  'marks',
  'description',
  'packageCount',
  'packageType',
  'quantity',
  'unit',
  'grossKg',
  'netKg',
  'cbm',
] as const;
export type GrnDraftLineField = (typeof GRN_DRAFT_LINE_FIELDS)[number];

/** Who filled a value: the assistant from the document, or a person on the review screen. */
export const GRN_FIELD_SOURCES = ['AI', 'STAFF'] as const;
export type GrnFieldSource = (typeof GRN_FIELD_SOURCES)[number];

/**
 * What code could check about an AI-filled value. MATCHED means only that the value was found in
 * the source at the stated position, not that its column, unit or meaning is right.
 */
export const GRN_FIELD_MATCHES = ['MATCHED', 'UNVERIFIED', 'MISMATCH'] as const;
export type GrnFieldMatch = (typeof GRN_FIELD_MATCHES)[number];

/** Closed list of warnings the assistant's code may attach to a draft. */
export const GRN_DRAFT_WARNINGS = [
  'TOTAL_PACKAGES_MISMATCH',
  'TOTAL_GROSS_MISMATCH',
  'TOTAL_NET_MISMATCH',
  'TOTAL_CBM_MISMATCH',
  'SOURCE_NOT_VERIFIABLE',
  'NET_ABOVE_GROSS',
] as const;
export type GrnDraftWarning = (typeof GRN_DRAFT_WARNINGS)[number];

export interface GrnDraftLineValues {
  marks: string | null;
  description: string | null;
  packageCount: number | null;
  packageType: string | null;
  quantity: DecimalString | null;
  unit: string | null;
  grossKg: DecimalString | null;
  netKg: DecimalString | null;
  cbm: DecimalString | null;
}

export interface GrnDraftFieldMeta {
  filledBy: GrnFieldSource;
  /** Null for a value a person typed. */
  match: GrnFieldMatch | null;
}

export interface GrnDraftLineDto extends GrnDraftLineValues {
  lineNo: number;
  /** Page (PDF, image) or row (Excel) in the source, as the assistant reported it. */
  sourcePage: number | null;
  sourceRow: number | null;
  /** One entry per field that holds a value. */
  fields: Partial<Record<GrnDraftLineField, GrnDraftFieldMeta>>;
}

export interface GrnDraftTotals {
  packages: number | null;
  grossKg: DecimalString | null;
  netKg: DecimalString | null;
  cbm: DecimalString | null;
}

/** What the assistant gets back: no string from the document. */
export interface GrnDraftSummaryDto {
  id: string;
  shipmentId: string;
  status: GrnDraftStatus;
  version: number;
  lineCount: number;
  /** Sums of the lines, computed by NOLON. */
  lineTotals: GrnDraftTotals;
  warnings: GrnDraftWarning[];
  expiresAt: string;
  createdAt: string;
}

export interface GrnDraftDto extends GrnDraftSummaryDto {
  documentId: string;
  /** The totals printed on the document, as the assistant read them. */
  statedTotals: GrnDraftTotals;
  lines: GrnDraftLineDto[];
  createdByName: string;
  decidedByName: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  /** The GRN an approval recorded. */
  movementId: string | null;
  movementNumber: string | null;
  actions: { canEdit: boolean; canDecide: boolean };
}

export interface GrnDraftLineInput extends Partial<GrnDraftLineValues> {
  sourcePage?: number | null;
  sourceRow?: number | null;
}

/** POST /shipments/:id/grn-drafts: the assistant's only write. */
export interface GrnDraftCreateRequest {
  /** Scoped to the assistant client and the user it acts for. */
  idempotencyKey: string;
  documentId: string;
  documentSha256: string;
  statedTotals?: Partial<GrnDraftTotals>;
  warnings?: GrnDraftWarning[];
  lines: (GrnDraftLineInput & {
    match?: Partial<Record<GrnDraftLineField, GrnFieldMatch>>;
  })[];
}

/** PATCH /shipments/:id/grn-drafts/:draftId: a person replaces the lines. */
export interface GrnDraftUpdateRequest {
  version: number;
  lines: (GrnDraftLineInput & {
    /** The line this row was, when it was already on the draft; omitted for a new line. */
    lineNo?: number;
  })[];
}

/** POST .../approve: the receipt a person records from the draft. */
export interface GrnDraftApproveRequest extends GoodsReceiptRequest {
  version: number;
}

export interface GrnDraftRejectRequest {
  version: number;
  reason: string;
}

/** The document type the assistant reads (a row of the document types master). */
export const PACKING_LIST_DOCUMENT_TYPE = 'PACKING_LIST';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * GET /shipments/:id/documents/:documentId/packing-list-content: the bytes of a packing list for
 * the assistant to read, as JSON. Never the file name.
 */
export interface PackingListContentDto {
  documentId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  dataBase64: string;
}
