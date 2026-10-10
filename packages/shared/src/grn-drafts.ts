import type { DecimalString } from './currencies.js';
import {
  DRAFT_FIELD_MATCHES,
  DRAFT_FIELD_SOURCES,
  DRAFT_STATUSES,
  DRAFT_TTL_DAYS,
  type DraftFieldMatch,
  type DraftFieldMeta,
  type DraftFieldSource,
  type DraftRejectRequest,
  type DraftStatus,
} from './drafts.js';
import type { GoodsReceiptRequest } from './warehouse.js';

/**
 * Draft goods received notes (Document Pilot, erp-agents docs/packing-list-grn-drafts.md). The
 * staff AI assistant reads a shipment's packing list and proposes a draft; a person reviews it next
 * to the source file and approves it, which records an ordinary goods receipt (GRN). The assistant
 * can create a draft and nothing else.
 */

/** The generic draft rules (drafts.ts), under the names the GRN draft code uses. */
export const GRN_DRAFT_STATUSES = DRAFT_STATUSES;
export type GrnDraftStatus = DraftStatus;
export const GRN_DRAFT_TTL_DAYS = DRAFT_TTL_DAYS;

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

export const GRN_FIELD_SOURCES = DRAFT_FIELD_SOURCES;
export type GrnFieldSource = DraftFieldSource;
export const GRN_FIELD_MATCHES = DRAFT_FIELD_MATCHES;
export type GrnFieldMatch = DraftFieldMatch;

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

export type GrnDraftFieldMeta = DraftFieldMeta;

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

export type GrnDraftRejectRequest = DraftRejectRequest;

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

/** Rows and columns of a spreadsheet packing list shown next to a draft, at most. */
export const SHEET_PREVIEW_MAX_ROWS = 500;
export const SHEET_PREVIEW_MAX_COLUMNS = 30;

/**
 * GET /shipments/:id/documents/:documentId/sheet: the first sheet of an .xlsx packing list as
 * plain text cells (formulas show their stored result; nothing is evaluated), for the review
 * screen. Row and column numbers are 1-based, as in Excel.
 */
export interface SheetPreviewDto {
  sheetName: string;
  rows: { rowNumber: number; cells: string[] }[];
  truncated: boolean;
}
