import ExcelJS from 'exceljs';
import { SHEET_PREVIEW_MAX_COLUMNS, SHEET_PREVIEW_MAX_ROWS } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { sheetPreview } from './sheet-preview.js';

async function xlsx(fill: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  fill(workbook.addWorksheet('Packing list'));
  workbook.addWorksheet('Second').addRow(['never shown']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('sheetPreview', () => {
  it('shows the first sheet as text: stored formula results, rich text and dates', async () => {
    const preview = await sheetPreview(
      await xlsx((sheet) => {
        sheet.addRow(['Marks', 'Total', 'Note', 'Date']);
        sheet.addRow([
          'NOL/1',
          { formula: 'HYPERLINK("https://evil.test")', result: 7 },
          { richText: [{ text: 'Cot' }, { text: 'ton' }] },
          new Date('2026-10-01T00:00:00Z'),
        ]);
        sheet.addRow([]);
        sheet.addRow(['TOTAL']);
      }),
    );
    expect(preview).toEqual({
      sheetName: 'Packing list',
      truncated: false,
      rows: [
        { rowNumber: 1, cells: ['Marks', 'Total', 'Note', 'Date'] },
        { rowNumber: 2, cells: ['NOL/1', '7', 'Cotton', '2026-10-01T00:00:00.000Z'] },
        { rowNumber: 4, cells: ['TOTAL'] },
      ],
    });
  });

  it('caps rows, columns and cell length, and says it did', async () => {
    const preview = await sheetPreview(
      await xlsx((sheet) => {
        sheet.addRow(Array.from({ length: SHEET_PREVIEW_MAX_COLUMNS + 5 }, (_, i) => i));
        sheet.addRow(['x'.repeat(2000)]);
        for (let i = 0; i < SHEET_PREVIEW_MAX_ROWS; i++) sheet.addRow([i]);
      }),
    );
    expect(preview?.truncated).toBe(true);
    expect(preview?.rows).toHaveLength(SHEET_PREVIEW_MAX_ROWS);
    expect(preview?.rows[0]?.cells).toHaveLength(SHEET_PREVIEW_MAX_COLUMNS);
    expect(preview?.rows[1]?.cells[0]).toHaveLength(500);
  });

  it('is null for bytes that are not a readable workbook', async () => {
    expect(await sheetPreview(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(await sheetPreview(Buffer.from('PK\u0003\u0004 broken'))).toBeNull();
  });
});
