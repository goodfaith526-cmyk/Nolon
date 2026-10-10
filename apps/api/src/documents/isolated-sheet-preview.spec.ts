import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { packStoredZip } from '../common/zip-guard.js';
import { isXlsxWorkbook } from './file-type.js';
import { isolatedSheetPreview } from './isolated-sheet-preview.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function book(sheetData: string): Buffer {
  const part = (name: string, content: string) => ({
    name: Buffer.from(name),
    utf8Name: true,
    content: Buffer.from(content),
  });
  return packStoredZip([
    part('[Content_Types].xml', '<Types/>'),
    part(
      'xl/workbook.xml',
      `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="PL" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    part(
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="${MAIN}"><sheetData>${sheetData}</sheetData></worksheet>`,
    ),
  ]);
}

/** A sheet holding one inline text of about `megabytes` MB. */
const bigText = (megabytes: number) =>
  book(`<row><c t="inlineStr"><is><t>${'x'.repeat(megabytes * 1_000_000)}</t></is></c></row>`);

describe('isolatedSheetPreview', () => {
  it('reads a workbook in its own worker', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('PL').addRows([
      ['Marks', 'Cartons'],
      ['NOL/1', 6],
    ]);
    const preview = await isolatedSheetPreview(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(preview).toEqual({
      sheetName: 'PL',
      truncated: false,
      rows: [
        { rowNumber: 1, cells: ['Marks', 'Cartons'] },
        { rowNumber: 2, cells: ['NOL/1', '6'] },
      ],
    });
  });

  it('refuses at once a small accepted workbook that references row 1,000,000,000', async () => {
    const data = book('<row r="1000000000"><c r="A1000000000"><v>1</v></c></row>');
    expect(isXlsxWorkbook(data)).toBe(true);
    const started = Date.now();
    expect(await isolatedSheetPreview(data)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('kills a worker past its time limit; the same file reads within the normal limit', async () => {
    const data = bigText(20);
    expect(await isolatedSheetPreview(data, { timeLimitMs: 1 })).toBeNull();
    expect((await isolatedSheetPreview(data))?.rows[0]?.cells[0]).toHaveLength(500);
  });

  it('keeps the API responsive while a large file is read', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const started = Date.now();
    await isolatedSheetPreview(bigText(25));
    clearInterval(timer);
    // The main thread kept running its timers for most of the read.
    expect(ticks).toBeGreaterThan((Date.now() - started) / 5 / 3);
  });
});
