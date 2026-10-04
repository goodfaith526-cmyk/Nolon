import type { Locale } from '@nolon/shared';
import ExcelJS from 'exceljs';
import { dec } from '../common/money.js';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * How a column's cells are written: `amount` and `percent` take decimal strings and become
 * numeric cells; `date` takes YYYY-MM-DD; `integer` takes a count (never money).
 */
export type CellKind = 'text' | 'amount' | 'percent' | 'date' | 'integer';

export type Cell = string | number | null;

export interface ColumnSpec {
  header: string;
  kind: CellKind;
  width?: number;
}

export interface RowSpec {
  cells: Cell[];
  /** Section headings and totals. */
  bold?: boolean;
}

export interface SheetSpec {
  name: string;
  columns: ColumnSpec[];
  rows: RowSpec[];
}

export interface WorkbookSpec {
  locale: Locale;
  title: string;
  /** Filter lines under the title (period, branch, currency). */
  subtitle: string[];
  sheets: SheetSpec[];
}

/**
 * A decimal string as an Excel numeric cell. Excel keeps numbers as binary doubles, so this is
 * the one place an amount leaves Decimal: the string is converted once, with no arithmetic, and
 * only when the double gives back exactly the same decimal. Otherwise (more than 15 significant
 * digits) the amount is written as text, so no digit is ever changed silently.
 */
export function excelAmount(value: string): number | string {
  const exact = dec(value);
  const asDouble = exact.toNumber();
  return dec(asDouble).eq(exact) ? asDouble : value;
}

function excelDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

const FORMATS: Partial<Record<CellKind, string>> = {
  amount: '#,##0.00##;-#,##0.00##',
  percent: '0.00',
  date: 'yyyy-mm-dd',
  integer: '0',
};

const DEFAULT_WIDTHS: Record<CellKind, number> = {
  text: 28,
  amount: 16,
  percent: 10,
  date: 12,
  integer: 10,
};

function cellValue(kind: CellKind, value: Cell): ExcelJS.CellValue {
  if (value === null || value === '') return null;
  if ((kind === 'amount' || kind === 'percent') && typeof value === 'string') {
    return excelAmount(value);
  }
  if (kind === 'date' && typeof value === 'string') return excelDate(value);
  return value;
}

/** Builds the .xlsx: one sheet per spec, title and filters on top, right to left in Arabic. */
export async function buildWorkbook(spec: WorkbookSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NOLON';
  for (const sheet of spec.sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31), {
      views: [
        { rightToLeft: spec.locale === 'ar', state: 'frozen', ySplit: spec.subtitle.length + 3 },
      ],
    });
    ws.columns = sheet.columns.map((c) => ({ width: c.width ?? DEFAULT_WIDTHS[c.kind] }));
    ws.addRow([spec.title]).font = { bold: true, size: 14 };
    for (const line of spec.subtitle) ws.addRow([line]);
    ws.addRow([]);
    const header = ws.addRow(sheet.columns.map((c) => c.header));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
      cell.border = { bottom: { style: 'thin' } };
    });
    for (const row of sheet.rows) {
      const added = ws.addRow(
        sheet.columns.map((column, i) => cellValue(column.kind, row.cells[i] ?? null)),
      );
      if (row.bold) added.font = { bold: true };
      sheet.columns.forEach((column, i) => {
        const format = FORMATS[column.kind];
        if (format) added.getCell(i + 1).numFmt = format;
      });
    }
  }
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}
