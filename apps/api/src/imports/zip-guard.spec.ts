import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { lyingZipBomb } from '../../test/zip-bomb.js';
import { repackZip, unpackZip } from './zip-guard.js';

// Observe every inflate: what output bound it was given, and how much it produced.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) };
});

async function workbook(rows: ExcelJS.CellValue[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const LIMITS = { maxEntries: 100, maxUncompressedBytes: 10_000_000 };

describe('repackZip', () => {
  it('rebuilds a workbook as stored entries that exceljs reads the same', async () => {
    const data = await workbook([
      ['Code', 'Name'],
      ['a', 'نور'],
    ]);
    const repacked = repackZip(data, LIMITS);
    expect(repacked).not.toBeNull();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(repacked as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
    expect(wb.worksheets[0]?.getCell('B2').value).toBe('نور');
    // Stored, so nothing in it is inflated again: the real sizes are the declared ones.
    expect(unpackZip(repacked ?? Buffer.alloc(0), LIMITS)?.length).toBe(
      unpackZip(data, LIMITS)?.length,
    );
  });

  it('refuses archives that expand too far, have too many entries, or are not sound', async () => {
    const data = await workbook([['Code'], ['a']]);
    expect(repackZip(data, { maxEntries: 100, maxUncompressedBytes: 100 })).toBeNull();
    expect(repackZip(data, { maxEntries: 1, maxUncompressedBytes: 10_000_000 })).toBeNull();
    expect(repackZip(Buffer.from('PK\u0003\u0004 not really a zip'), LIMITS)).toBeNull();
    const corrupt = Buffer.from(data);
    corrupt.writeUInt32LE(0, corrupt.length - 6); // central directory offset
    expect(repackZip(corrupt, LIMITS)).toBeNull();
  });

  it('refuses an entry whose declared size lies, without inflating past the cap', () => {
    const inflate = vi.mocked(inflateRawSync);
    inflate.mockClear();
    // 1 GiB of zeros in about a megabyte, declared as 100 bytes.
    const bomb = lyingZipBomb(1024);
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    const cap = 1_000_000;
    expect(repackZip(bomb, { maxEntries: 10, maxUncompressedBytes: cap })).toBeNull();
    expect(inflate).toHaveBeenCalledTimes(1);
    const options = inflate.mock.calls[0]?.[1];
    expect(options?.maxOutputLength).toBeLessThanOrEqual(cap);
    // zlib gave up at the bound: no output was ever handed back.
    expect(inflate.mock.results[0]?.type).toBe('throw');
  });

  it('accepts the same entry when it truly fits', () => {
    const small = lyingZipBomb(2, 2 * 1024 * 1024);
    const entries = unpackZip(small, LIMITS);
    expect(entries?.[0]?.content.length).toBe(2 * 1024 * 1024);
  });
});
