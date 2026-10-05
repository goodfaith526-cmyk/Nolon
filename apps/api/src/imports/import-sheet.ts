import { BadRequestException, HttpStatus, PayloadTooLargeException } from '@nestjs/common';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  type ImportFileError,
  type ImportFileErrorBody,
  type ImportKind,
  type ImportPreviewDto,
  type ImportIssueDto,
  type ImportRowError,
  type Locale,
} from '@nolon/shared';
import ExcelJS from 'exceljs';
import type { z } from 'zod';
import {
  type CellResult,
  type RawCell,
  cellAmount,
  cellCode,
  cellDate,
  cellInteger,
  cellPhone,
  cellText,
  rawCell,
} from './cells.js';
import { repackZip } from './zip-guard.js';

/**
 * The developer-defined import templates (scope 18): column definitions, reading an uploaded
 * workbook into typed cells, and the per-row issue list. Business rules are not here: each
 * module checks its rows through its own service.
 */

export interface Labeled {
  en: string;
  ar: string;
}

export type ColumnKind = 'text' | 'code' | 'phone' | 'amount' | 'date' | 'integer';

export interface ImportColumn<K extends string = string> {
  key: K;
  kind: ColumnKind;
  required: boolean;
  label: Labeled;
  /** Format or allowed values, for the instructions sheet. */
  hint: Labeled;
  /** Name of the lists-sheet column that holds the allowed values (a dropdown in the template). */
  list?: string;
  width?: number;
}

export type CellValue = string | number | null;

export interface SheetRow<K extends string> {
  /** Excel row number. */
  row: number;
  values: Record<K, CellValue>;
  issues: ImportIssueDto[];
}

export interface UploadedWorkbook {
  originalname: string;
  buffer: Buffer;
}

/**
 * Bounds on what an upload may expand to once unzipped, counted on the bytes actually inflated.
 * A full template of IMPORT_MAX_ROWS rows is a few megabytes of XML; 16 MiB leaves room for long
 * texts while keeping the parsed workbook (and so a file with far too many rows) small.
 */
export const ZIP_LIMITS = { maxEntries: 200, maxUncompressedBytes: 16 * 1024 * 1024 };

/** Parts of a worksheet the import never needs; skipping them keeps parsing lean. */
const IGNORED_NODES = ['dataValidations', 'conditionalFormatting', 'hyperlinks', 'drawing'];

export function fileError(
  code: ImportFileError,
  message: string,
  columns?: string[],
): BadRequestException | PayloadTooLargeException {
  if (code === 'FILE_TOO_LARGE') {
    const body: ImportFileErrorBody = {
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
      code,
      message,
    };
    return new PayloadTooLargeException(body);
  }
  const body: ImportFileErrorBody = {
    statusCode: HttpStatus.BAD_REQUEST,
    code,
    message,
    ...(columns ? { columns } : {}),
  };
  return new BadRequestException(body);
}

/** Header text as compared: trimmed, lower case, single spaces, without the required mark. */
export function normalizeHeader(text: string): string {
  return text.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The header text the template writes: the label, marked with * when required. */
export function headerText(column: ImportColumn, locale: Locale): string {
  return column.required ? `${column.label[locale]} *` : column.label[locale];
}

function convert(kind: ColumnKind, raw: RawCell): CellResult<CellValue> {
  switch (kind) {
    case 'code':
      return cellCode(raw);
    case 'phone':
      return cellPhone(raw);
    case 'amount':
      return cellAmount(raw);
    case 'date':
      return cellDate(raw);
    case 'integer':
      return cellInteger(raw);
    default:
      return cellText(raw);
  }
}

/** Opens the upload: .xlsx only, within the size limit, a sound zip, a readable workbook. */
async function openWorkbook(file: UploadedWorkbook | undefined): Promise<ExcelJS.Worksheet> {
  if (!file) throw fileError('NO_FILE', 'Attach the filled template (.xlsx)');
  if (file.buffer.length > IMPORT_MAX_BYTES) {
    throw fileError('FILE_TOO_LARGE', `Files are limited to ${IMPORT_MAX_BYTES} bytes`);
  }
  if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
    throw fileError('NOT_XLSX', 'Only .xlsx workbooks are accepted');
  }
  // exceljs only ever sees the archive rebuilt from entries inflated under the cap (zip-guard.ts).
  const verified = repackZip(file.buffer, ZIP_LIMITS);
  if (!verified) {
    throw fileError('UNREADABLE', 'The file is not a readable .xlsx workbook');
  }
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's typings redeclare Buffer as an ArrayBuffer, which no Node Buffer satisfies; at
    // runtime it hands the Node Buffer to JSZip, which is what it expects.
    const data = verified as unknown as Parameters<ExcelJS.Xlsx['load']>[0];
    await workbook.xlsx.load(data, { ignoreNodes: IGNORED_NODES });
  } catch {
    throw fileError('UNREADABLE', 'The file is not a readable .xlsx workbook');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw fileError('UNREADABLE', 'The workbook has no sheet');
  return sheet;
}

/** Maps each header cell of row 1 to a column, by key or by its English or Arabic label. */
function mapHeader<K extends string>(
  sheet: ExcelJS.Worksheet,
  columns: readonly ImportColumn<K>[],
): Map<number, ImportColumn<K>> {
  const byName = new Map<string, ImportColumn<K>>();
  for (const column of columns) {
    for (const name of [column.key, column.label.en, column.label.ar]) {
      byName.set(normalizeHeader(name), column);
    }
  }
  const mapped = new Map<number, ImportColumn<K>>();
  const seen = new Set<string>();
  const unknown: string[] = [];
  const duplicate: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellText(rawCell(cell.value));
    const header = text.ok ? text.value : null;
    if (header === null) return;
    const column = byName.get(normalizeHeader(header));
    if (!column) {
      unknown.push(header);
    } else if (seen.has(column.key)) {
      duplicate.push(header);
    } else {
      seen.add(column.key);
      mapped.set(colNumber, column);
    }
  });
  if (unknown.length > 0) {
    throw fileError('UNKNOWN_COLUMNS', 'Columns not in the template', unknown);
  }
  if (duplicate.length > 0) {
    throw fileError('DUPLICATE_COLUMNS', 'A column appears twice', duplicate);
  }
  const missing = columns.filter((c) => c.required && !seen.has(c.key)).map((c) => c.key);
  if (missing.length > 0) {
    throw fileError('MISSING_COLUMNS', 'Required columns are missing', missing);
  }
  return mapped;
}

/**
 * Reads the first sheet of an uploaded template: row 1 is the header, every non-blank row after
 * it is a record. Each cell is converted by its column's kind; a cell that cannot be read is an
 * issue on that row and column, and its value is null.
 */
export async function readImportSheet<K extends string>(
  file: UploadedWorkbook | undefined,
  columns: readonly ImportColumn<K>[],
): Promise<SheetRow<K>[]> {
  const sheet = await openWorkbook(file);
  const header = mapHeader(sheet, columns);
  const rows: SheetRow<K>[] = [];
  let tooMany = false;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || tooMany) return;
    const values = Object.fromEntries(columns.map((c) => [c.key, null])) as Record<K, CellValue>;
    const issues: ImportIssueDto[] = [];
    let blank = true;
    for (const [colNumber, column] of header) {
      const raw = rawCell(row.getCell(colNumber).value);
      if (raw.kind === 'empty' || (raw.kind === 'text' && raw.text.trim() === '')) continue;
      blank = false;
      const result = convert(column.kind, raw);
      if (result.ok) {
        values[column.key] = result.value;
      } else {
        issues.push({
          row: rowNumber,
          column: column.key,
          code: result.code,
          message: result.message,
        });
      }
    }
    if (blank) return;
    if (rows.length >= IMPORT_MAX_ROWS) {
      tooMany = true;
      return;
    }
    rows.push({ row: rowNumber, values, issues });
  });
  if (tooMany) {
    throw fileError('TOO_MANY_ROWS', `At most ${IMPORT_MAX_ROWS} rows per file`);
  }
  if (rows.length === 0) throw fileError('NO_ROWS', 'The file has no data rows');
  return rows;
}

/** One issue; `column` null for the whole row. */
export function issue(
  row: number,
  column: string | null,
  code: ImportRowError,
  message: string,
  otherRow?: number,
): ImportIssueDto {
  return { row, column, code, message, ...(otherRow === undefined ? {} : { otherRow }) };
}

/** Cell values as the preview shows them (counts as text). */
export function displayValues<K extends string>(
  values: Record<K, CellValue>,
): Record<string, string | null> {
  const shown: Record<string, string | null> = {};
  for (const [key, value] of Object.entries<CellValue>(values)) {
    shown[key] = value === null ? null : String(value);
  }
  return shown;
}

/** A zod failure on a row, as issues on the template's columns. */
export function schemaIssues<K extends string>(
  row: number,
  input: Record<string, unknown>,
  error: z.ZodError,
  columnOf: (field: string) => K | null,
  kindOf: (column: K) => ColumnKind | undefined,
): ImportIssueDto[] {
  return error.issues.map((zodIssue) => {
    const field = String(zodIssue.path[0] ?? '');
    const column = columnOf(field);
    const given = input[field];
    const absent = given === undefined || given === null || given === '';
    let code: ImportRowError;
    if (absent) code = 'REQUIRED';
    else if (zodIssue.code === 'too_big' && typeof given === 'string') code = 'TOO_LONG';
    else if (column && kindOf(column) === 'amount') code = 'INVALID_AMOUNT';
    else if (zodIssue.code === 'invalid_format' || zodIssue.code === 'custom')
      code = 'INVALID_FORMAT';
    else code = 'INVALID_VALUE';
    return issue(row, column, code, zodIssue.message);
  });
}

/**
 * For a row that failed its schema: the fields that passed it, parsed, so the rule checks can
 * still report on them and the user sees every problem of the row at once. Null when even those
 * do not parse.
 */
export function passingFields<S extends z.ZodObject>(
  schema: S,
  input: Record<string, unknown>,
  error: z.ZodError,
): Partial<z.infer<S>> | null {
  const failed = new Set(error.issues.map((i) => String(i.path[0] ?? '')));
  const rest = Object.fromEntries(Object.entries(input).filter(([field]) => !failed.has(field)));
  const parsed = schema.partial().safeParse(rest);
  return parsed.success ? (parsed.data as Partial<z.infer<S>>) : null;
}

/** A row after every check: the parsed input when it passed the schema, and all its issues. */
export interface CheckedRow<K extends string, T> {
  row: number;
  values: Record<K, CellValue>;
  input: T | null;
  issues: ImportIssueDto[];
}

/** Adds `extra` issues, skipping columns that already have one (the first problem is enough). */
export function addIssues(target: ImportIssueDto[], extra: readonly ImportIssueDto[]): void {
  for (const candidate of extra) {
    const taken =
      candidate.column !== null && target.some((existing) => existing.column === candidate.column);
    if (!taken) target.push(candidate);
  }
}

/**
 * Flags rows whose duplicate keys repeat an earlier row of the file. `keysOf` gives each key with
 * the column the issue is reported on (e.g. the phone column for a repeated phone).
 */
export function flagDuplicatesInFile<K extends string, T>(
  rows: CheckedRow<K, T>[],
  keysOf: (input: T) => { key: string; column: K; what: string }[],
): void {
  const firstRow = new Map<string, number>();
  for (const row of rows) {
    if (!row.input) continue;
    for (const { key, column, what } of keysOf(row.input)) {
      const earlier = firstRow.get(key);
      if (earlier === undefined) {
        firstRow.set(key, row.row);
      } else {
        addIssues(row.issues, [
          issue(row.row, column, 'DUPLICATE_IN_FILE', `Same ${what} as row ${earlier}`, earlier),
        ]);
      }
    }
  }
}

export function buildPreview<K extends string, T>(
  kind: ImportKind,
  columns: readonly ImportColumn<K>[],
  rows: readonly CheckedRow<K, T>[],
): ImportPreviewDto {
  const issues = rows.flatMap((r) => r.issues);
  return {
    kind,
    columns: columns.map((c) => c.key),
    totalRows: rows.length,
    validRows: rows.filter((r) => r.issues.length === 0).length,
    rows: rows.map((r) => ({
      row: r.row,
      values: displayValues(r.values),
      valid: r.issues.length === 0,
    })),
    issues,
  };
}
