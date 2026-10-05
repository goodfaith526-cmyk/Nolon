import type { AgingAmountsDto, ApAgingDto } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { apAgingSheets } from './report-sheets.js';

const amounts = (over90: string): AgingAmountsDto => ({
  current: '0',
  days1to30: '0',
  days31to60: '0',
  days61to90: '0',
  over90,
  total: over90,
});

const aging: ApAgingDto = {
  asOf: '2025-12-31',
  branchId: null,
  supplierId: null,
  suppliers: [{ supplierId: 's1', supplierName: 'Nile Lines', amounts: amounts('550') }],
  bills: [
    {
      billId: 'b1',
      number: 'NOL-SB-2025-000001',
      supplierReference: null,
      branchCode: 'PTS',
      supplierId: 's1',
      supplierName: 'Nile Lines',
      billDate: '2025-04-10',
      dueDate: '2025-05-10',
      currency: 'SDG',
      total: '660000',
      outstanding: '330000',
      outstandingUsd: '550',
      daysPastDue: 235,
      bucket: 'over90',
    },
  ],
  totals: amounts('550'),
};

describe('apAgingSheets', () => {
  it('writes a per-supplier summary with a bold total and one row per bill', () => {
    const spec = apAgingSheets({ locale: 'en', branchCode: 'PTS' }, aging, 'Nile Lines');
    expect(spec.title).toBe('Supplier payables aging');
    expect(spec.subtitle).toEqual(
      expect.arrayContaining(['As of: 2025-12-31', 'Branch: PTS', 'Supplier: Nile Lines']),
    );
    const [summary, bills] = spec.sheets;
    expect(summary?.rows).toHaveLength(2);
    expect(summary?.rows[0]?.cells).toEqual(['Nile Lines', '0', '0', '0', '0', '550', '550']);
    expect(summary?.rows[1]).toMatchObject({ bold: true });
    expect(bills?.rows[0]?.cells).toEqual([
      'NOL-SB-2025-000001',
      '',
      'PTS',
      'Nile Lines',
      '2025-04-10',
      '2025-05-10',
      'SDG',
      '660000',
      '330000',
      '550',
      235,
      'Over 90 days',
    ]);
    // Every row has a cell per column.
    for (const sheet of spec.sheets) {
      for (const row of sheet.rows) expect(row.cells).toHaveLength(sheet.columns.length);
    }
  });

  it('uses Arabic headers for an Arabic export', () => {
    const spec = apAgingSheets({ locale: 'ar', branchCode: null }, aging, null);
    expect(spec.title).toBe('أعمار ديون الموردين');
    expect(spec.sheets.map((s) => s.name)).toEqual(['حسب المورد', 'فواتير الموردين']);
  });
});
