import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { ImportColumn } from './import-sheet.js';
import { readImportSheet } from './import-sheet.js';
import { buildTemplate } from './template.js';

const COLUMNS: ImportColumn<'branchCode' | 'price'>[] = [
  {
    key: 'branchCode',
    kind: 'code',
    required: true,
    list: 'branches',
    label: { en: 'Branch code', ar: 'رمز الفرع' },
    hint: { en: 'Your branch', ar: 'فرعك' },
  },
  {
    key: 'price',
    kind: 'amount',
    required: false,
    label: { en: 'Price', ar: 'السعر' },
    hint: { en: 'Amount', ar: 'مبلغ' },
  },
];

describe('buildTemplate', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`writes the ${locale} headers, instructions and database lists`, async () => {
      const data = await buildTemplate({
        locale,
        sheetName: { en: 'Rates', ar: 'الأسعار' },
        columns: COLUMNS,
        notes: [{ en: 'Note', ar: 'ملاحظة' }],
        lists: [
          {
            key: 'branches',
            title: { en: 'Branches', ar: 'الفروع' },
            items: [
              { code: 'DXB', name: 'Dubai' },
              { code: 'JED', name: 'Jeddah' },
            ],
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(data as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
      const [sheet, instructions, lists] = wb.worksheets;
      expect(sheet?.name).toBe(locale === 'ar' ? 'الأسعار' : 'Rates');
      expect(sheet?.getRow(1).values).toEqual([
        undefined,
        locale === 'ar' ? 'رمز الفرع *' : 'Branch code *',
        locale === 'ar' ? 'السعر' : 'Price',
      ]);
      expect(sheet?.getCell('A2').dataValidation).toMatchObject({ type: 'list' });
      expect(String(sheet?.getCell('A2').dataValidation.formulae[0])).toContain('$A$2:$A$3');
      expect(lists?.getCell('A3').value).toBe('JED');
      expect(instructions?.rowCount).toBeGreaterThan(5);

      // The blank template reads back with its own headers: no data rows yet.
      await expect(
        readImportSheet({ originalname: 't.xlsx', buffer: data }, COLUMNS),
      ).rejects.toMatchObject({ response: { code: 'NO_ROWS' } });
    });
  }
});
