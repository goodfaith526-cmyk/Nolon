import {
  SHEET_PREVIEW_MAX_COLUMNS,
  SHEET_PREVIEW_MAX_ROWS,
  type SheetPreviewDto,
} from '@nolon/shared';
import ExcelJS from 'exceljs';
import { repackZip } from '../common/zip-guard.js';

/** The same bound as when the workbook was accepted (file-type.ts). */
const ZIP_LIMITS = { maxEntries: 200, maxUncompressedBytes: 32 * 1024 * 1024 };

/** Parts the preview never needs; skipping them keeps parsing lean. */
const IGNORED_NODES = ['dataValidations', 'conditionalFormatting', 'hyperlinks', 'drawing'];

/**
 * The first sheet of a stored .xlsx as text cells, for a person to compare a draft with. exceljs
 * only sees the archive rebuilt from entries inflated under the cap; formulas are never
 * evaluated (their stored result is shown), and links are not followed. Null when unreadable.
 */
export async function sheetPreview(data: Buffer): Promise<SheetPreviewDto | null> {
  const verified = repackZip(data, ZIP_LIMITS);
  if (!verified) return null;
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's typings redeclare Buffer as an ArrayBuffer; at runtime it takes a Node Buffer.
    await workbook.xlsx.load(verified as unknown as Parameters<ExcelJS.Xlsx['load']>[0], {
      ignoreNodes: IGNORED_NODES,
    });
  } catch {
    return null;
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return null;
  const rows: SheetPreviewDto['rows'] = [];
  let truncated = sheet.actualColumnCount > SHEET_PREVIEW_MAX_COLUMNS;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= SHEET_PREVIEW_MAX_ROWS) {
      truncated = true;
      return;
    }
    const cells: string[] = [];
    for (let col = 1; col <= Math.min(row.cellCount, SHEET_PREVIEW_MAX_COLUMNS); col++) {
      cells.push(cellText(row.getCell(col)).slice(0, 500));
    }
    rows.push({ rowNumber, cells });
  });
  return { sheetName: sheet.name.slice(0, 100), rows, truncated };
}

/** A cell's value as text: a formula's stored result, rich text joined, dates as ISO. */
function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('result' in value) {
      const result: unknown = value.result;
      return typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean'
        ? String(result)
        : result instanceof Date
          ? result.toISOString()
          : '';
    }
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return String(value.error);
    return '';
  }
  return String(value);
}
