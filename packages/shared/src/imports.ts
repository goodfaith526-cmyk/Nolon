/**
 * Excel import of customers and rates (scope 6, 7 and 18): developer-defined templates, a preview
 * that writes nothing, and an all-or-nothing commit.
 */

export const IMPORT_KINDS = ['customers', 'rates'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Largest workbook accepted (bytes). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Most data rows in one file. */
export const IMPORT_MAX_ROWS = 5000;

/** Template columns, in template order. Keys are what the preview and errors refer to. */
export const CUSTOMER_IMPORT_COLUMNS = [
  'branchCode',
  'kind',
  'name',
  'companyName',
  'phone',
  'whatsapp',
  'email',
  'countryCode',
  'city',
  'address',
  'taxNumber',
  'preferredCurrency',
  'preferredLocale',
  'paymentTermsDays',
  'creditLimit',
  'creditLimitCurrency',
  'notes',
] as const;
export type CustomerImportColumn = (typeof CUSTOMER_IMPORT_COLUMNS)[number];

export const RATE_IMPORT_COLUMNS = [
  'branchCode',
  'originCode',
  'destinationCode',
  'mode',
  'loadType',
  'cargoType',
  'containerType',
  'chargeType',
  'unit',
  'price',
  'minimumCharge',
  'currency',
  'validFrom',
  'validTo',
  'transitDays',
  'notes',
] as const;
export type RateImportColumn = (typeof RATE_IMPORT_COLUMNS)[number];

/** Why a whole file is refused (400, or 413 for FILE_TOO_LARGE). */
export const IMPORT_FILE_ERRORS = [
  'NO_FILE',
  'NOT_XLSX',
  'FILE_TOO_LARGE',
  'UNREADABLE',
  'MISSING_COLUMNS',
  'UNKNOWN_COLUMNS',
  'DUPLICATE_COLUMNS',
  'NO_ROWS',
  'TOO_MANY_ROWS',
] as const;
export type ImportFileError = (typeof IMPORT_FILE_ERRORS)[number];

/** Why one cell or row is refused. */
export const IMPORT_ROW_ERRORS = [
  'REQUIRED',
  'TOO_LONG',
  'INVALID_FORMAT',
  'INVALID_VALUE',
  'INVALID_AMOUNT',
  'AMOUNT_NOT_EXACT',
  'INVALID_DATE',
  'INVALID_INTEGER',
  'FORMULA_NOT_ALLOWED',
  'BRANCH_NOT_ALLOWED',
  'UNKNOWN_CURRENCY',
  'CREDIT_LIMIT_PAIR',
  'UNKNOWN_LOCATION',
  'SAME_ROUTE',
  'LOAD_TYPE_SEA_ONLY',
  'CONTAINER_TYPE_REQUIRED',
  'CONTAINER_TYPE_NOT_APPLICABLE',
  'UNKNOWN_CONTAINER_TYPE',
  'UNKNOWN_CHARGE_TYPE',
  'VALID_TO_BEFORE_FROM',
  'DUPLICATE_IN_FILE',
  'DUPLICATE_IN_DB',
] as const;
export type ImportRowError = (typeof IMPORT_ROW_ERRORS)[number];

/** Body of a refused file. */
export interface ImportFileErrorBody {
  statusCode: number;
  code: ImportFileError;
  message: string;
  /** Header texts for MISSING_COLUMNS / UNKNOWN_COLUMNS / DUPLICATE_COLUMNS. */
  columns?: string[];
}

export interface ImportIssueDto {
  /** Excel row number (the header is row 1). */
  row: number;
  /** Column key, or null for a row-level problem. */
  column: string | null;
  code: ImportRowError;
  /** English detail; the screen shows the code's text in its own language. */
  message: string;
  /** For DUPLICATE_IN_FILE: the earlier row with the same key. */
  otherRow?: number;
}

export interface ImportRowDto {
  row: number;
  /** The cells as read, by column key (text, decimal strings and YYYY-MM-DD dates). */
  values: Record<string, string | null>;
  valid: boolean;
}

/** POST /{customers|rates}/import/preview. Nothing is written. */
export interface ImportPreviewDto {
  kind: ImportKind;
  columns: string[];
  totalRows: number;
  validRows: number;
  rows: ImportRowDto[];
  issues: ImportIssueDto[];
}

/** POST /{customers|rates}/import: every row written in one transaction. */
export interface ImportResultDto {
  kind: ImportKind;
  requestId: string;
  created: number;
  /** True when this requestId had already been imported: nothing new was written. */
  replayed: boolean;
  ids: string[];
}

/** Body of a commit refused because some rows are invalid (422). Nothing was written. */
export interface ImportRowsInvalidBody {
  statusCode: number;
  code: 'ROWS_INVALID';
  message: string;
  preview: ImportPreviewDto;
}
