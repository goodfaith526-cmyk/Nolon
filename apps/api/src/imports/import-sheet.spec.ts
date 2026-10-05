import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '@nolon/shared';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type CheckedRow,
  type ImportColumn,
  addIssues,
  buildPreview,
  flagDuplicatesInFile,
  issue,
  readImportSheet,
  schemaIssues,
} from './import-sheet.js';
import { zipWithinLimits } from './zip-guard.js';

type Key = 'code' | 'name' | 'price' | 'from';

const COLUMNS: ImportColumn<Key>[] = [
  {
    key: 'code',
    kind: 'code',
    required: true,
    label: { en: 'Code', ar: 'الرمز' },
    hint: { en: '', ar: '' },
  },
  {
    key: 'name',
    kind: 'text',
    required: false,
    label: { en: 'Name', ar: 'الاسم' },
    hint: { en: '', ar: '' },
  },
  {
    key: 'price',
    kind: 'amount',
    required: true,
    label: { en: 'Price', ar: 'السعر' },
    hint: { en: '', ar: '' },
  },
  {
    key: 'from',
    kind: 'date',
    required: false,
    label: { en: 'Valid from', ar: 'ساري من' },
    hint: { en: '', ar: '' },
  },
];

async function workbook(rows: ExcelJS.CellValue[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const file = (buffer: Buffer, name = 'rates.xlsx') => ({ originalname: name, buffer });

async function fileErrorOf(
  promise: Promise<unknown>,
): Promise<{ status: number; code: string; columns?: string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof PayloadTooLargeException) {
      const body = error.getResponse() as { code: string; columns?: string[] };
      return { status: error.getStatus(), code: body.code, columns: body.columns };
    }
    throw error;
  }
  throw new Error('expected a file error');
}

describe('readImportSheet', () => {
  it('maps headers by English or Arabic label or key, in any order, and converts cells', async () => {
    const data = await workbook([
      ['السعر *', 'code', 'Valid From', 'Name'],
      ['1250.50', ' dxb ', new Date('2026-01-01T00:00:00Z'), 'Al Noor'],
      [],
      [99.5, 'jed', '2026-02-01', null],
    ]);
    const rows = await readImportSheet(file(data), COLUMNS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      row: 2,
      values: { code: 'DXB', name: 'Al Noor', price: '1250.5', from: '2026-01-01' },
      issues: [],
    });
    expect(rows[1]?.row).toBe(4);
    expect(rows[1]?.values).toMatchObject({ code: 'JED', price: '99.5', name: null });
  });

  it('reports unreadable cells as issues on their row and column', async () => {
    const data = await workbook([
      ['Code', 'Price', 'Valid from'],
      ['A', { formula: '1+1', result: 2 }, '01/02/2026'],
    ]);
    const [row] = await readImportSheet(file(data), COLUMNS);
    expect(row?.values.price).toBeNull();
    expect(row?.issues.map((i) => [i.column, i.code])).toEqual([
      ['price', 'FORMULA_NOT_ALLOWED'],
      ['from', 'INVALID_DATE'],
    ]);
  });

  it('refuses a file with missing, unknown or repeated columns', async () => {
    expect(
      await fileErrorOf(readImportSheet(file(await workbook([['Name'], ['x']])), COLUMNS)),
    ).toMatchObject({
      status: 400,
      code: 'MISSING_COLUMNS',
      columns: ['code', 'price'],
    });
    expect(
      await fileErrorOf(
        readImportSheet(
          file(
            await workbook([
              ['Code', 'Price', 'Colour'],
              ['a', '1', 'red'],
            ]),
          ),
          COLUMNS,
        ),
      ),
    ).toMatchObject({ code: 'UNKNOWN_COLUMNS', columns: ['Colour'] });
    expect(
      await fileErrorOf(
        readImportSheet(
          file(
            await workbook([
              ['Code', 'Price', 'الرمز'],
              ['a', '1', 'b'],
            ]),
          ),
          COLUMNS,
        ),
      ),
    ).toMatchObject({ code: 'DUPLICATE_COLUMNS' });
  });

  it('refuses an empty file and one with too many rows', async () => {
    expect(
      await fileErrorOf(
        readImportSheet(file(await workbook([['Code', 'Price'], [], ['  ']])), COLUMNS),
      ),
    ).toMatchObject({
      code: 'NO_ROWS',
    });
    const many: ExcelJS.CellValue[][] = [['Code', 'Price']];
    for (let i = 0; i <= IMPORT_MAX_ROWS; i++) many.push([`C${i}`, '1']);
    expect(await fileErrorOf(readImportSheet(file(await workbook(many)), COLUMNS))).toMatchObject({
      code: 'TOO_MANY_ROWS',
    });
  });

  it('refuses what is not a small, sound .xlsx', async () => {
    const good = await workbook([
      ['Code', 'Price'],
      ['a', '1'],
    ]);
    expect(await fileErrorOf(readImportSheet(undefined, COLUMNS))).toMatchObject({
      code: 'NO_FILE',
    });
    expect(await fileErrorOf(readImportSheet(file(good, 'rates.xls'), COLUMNS))).toMatchObject({
      code: 'NOT_XLSX',
    });
    expect(
      await fileErrorOf(readImportSheet(file(Buffer.from('a,b\n1,2'), 'rates.xlsx'), COLUMNS)),
    ).toMatchObject({
      code: 'UNREADABLE',
    });
    const big = Buffer.concat([good, Buffer.alloc(IMPORT_MAX_BYTES)]);
    expect(await fileErrorOf(readImportSheet(file(big), COLUMNS))).toMatchObject({
      status: 413,
      code: 'FILE_TOO_LARGE',
    });
  });
});

describe('zipWithinLimits', () => {
  it('accepts a workbook and refuses one that would expand too far', async () => {
    const data = await workbook([['Code'], ['a']]);
    expect(zipWithinLimits(data, { maxEntries: 100, maxUncompressedBytes: 10_000_000 })).toBe(true);
    expect(zipWithinLimits(data, { maxEntries: 100, maxUncompressedBytes: 100 })).toBe(false);
    expect(zipWithinLimits(data, { maxEntries: 1, maxUncompressedBytes: 10_000_000 })).toBe(false);
    expect(
      zipWithinLimits(Buffer.from('PK\u0003\u0004 not really a zip'), {
        maxEntries: 9,
        maxUncompressedBytes: 9,
      }),
    ).toBe(false);
  });
});

describe('row checks', () => {
  const schema = z.object({
    code: z.string().min(1),
    price: z.string().regex(/^\d+$/),
    name: z.string().max(3).optional(),
  });

  it('turns schema failures into column issues', () => {
    const input = { price: '1.5', name: 'too long' };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = schemaIssues(
      7,
      input,
      parsed.error,
      (f) => (f === 'code' || f === 'price' || f === 'name' ? f : null),
      (c) => COLUMNS.find((col) => col.key === c)?.kind,
    );
    expect(issues.map((i) => [i.row, i.column, i.code])).toEqual([
      [7, 'code', 'REQUIRED'],
      [7, 'price', 'INVALID_AMOUNT'],
      [7, 'name', 'TOO_LONG'],
    ]);
  });

  it('keeps the first issue of a column and flags repeats within the file', () => {
    const issues = [issue(2, 'code', 'REQUIRED', 'x')];
    addIssues(issues, [
      issue(2, 'code', 'INVALID_VALUE', 'y'),
      issue(2, null, 'DUPLICATE_IN_DB', 'z'),
    ]);
    expect(issues.map((i) => i.code)).toEqual(['REQUIRED', 'DUPLICATE_IN_DB']);

    const rows: CheckedRow<Key, { code: string }>[] = [2, 3, 4].map((row) => ({
      row,
      values: { code: 'A', name: null, price: '1', from: null },
      input: { code: row === 3 ? 'B' : 'A' },
      issues: [],
    }));
    flagDuplicatesInFile(rows, (i) => [{ key: i.code, column: 'code', what: 'code' }]);
    expect(rows.map((r) => r.issues.map((i) => [i.code, i.otherRow]))).toEqual([
      [],
      [],
      [['DUPLICATE_IN_FILE', 2]],
    ]);
    const preview = buildPreview('rates', COLUMNS, rows);
    expect(preview).toMatchObject({
      totalRows: 3,
      validRows: 2,
      columns: ['code', 'name', 'price', 'from'],
    });
    expect(preview.rows[2]).toMatchObject({
      row: 4,
      valid: false,
      values: { code: 'A', price: '1' },
    });
  });
});
