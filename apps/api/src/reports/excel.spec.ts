import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildWorkbook, excelAmount } from './excel.js';

describe('Excel export', () => {
  it('writes an amount as the number its decimal string names', () => {
    expect(excelAmount('1666.67')).toBe(1666.67);
    expect(excelAmount('-0.0001')).toBe(-0.0001);
    expect(excelAmount('0')).toBe(0);
  });

  it('keeps an amount a double cannot hold exactly as text', () => {
    expect(excelAmount('12345678901234.5678')).toBe('12345678901234.5678');
  });

  it('builds a sheet with headers, numeric amounts and dates, right to left in Arabic', async () => {
    const data = await buildWorkbook({
      locale: 'ar',
      title: 'قائمة الدخل',
      subtitle: ['الفترة: 2026-01-01 - 2026-01-31'],
      sheets: [
        {
          name: 'قائمة الدخل',
          columns: [
            { header: 'الحساب', kind: 'text' },
            { header: 'التاريخ', kind: 'date' },
            { header: 'المبلغ', kind: 'amount' },
          ],
          rows: [{ cells: ['إيرادات الشحن', '2026-01-15', '1000000.5'] }, { cells: [] }],
        },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(data).buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet?.name).toBe('قائمة الدخل');
    expect(sheet?.views[0]?.rightToLeft).toBe(true);
    expect(sheet?.getRow(4).values).toEqual([undefined, 'الحساب', 'التاريخ', 'المبلغ']);
    const row = sheet?.getRow(5);
    expect(row?.getCell(1).value).toBe('إيرادات الشحن');
    expect(row?.getCell(2).value).toEqual(new Date('2026-01-15T00:00:00Z'));
    expect(row?.getCell(3).value).toBe(1000000.5);
    expect(row?.getCell(3).numFmt).toContain('#,##0.00');
  });
});
