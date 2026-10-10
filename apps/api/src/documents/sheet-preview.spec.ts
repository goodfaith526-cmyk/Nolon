import ExcelJS from 'exceljs';
import { SHEET_PREVIEW_MAX_COLUMNS, SHEET_PREVIEW_MAX_ROWS } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { packStoredZip } from '../common/zip-guard.js';
import { sheetPreview } from './sheet-preview.js';

async function xlsx(fill: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  fill(workbook.addWorksheet('Packing list'));
  workbook.addWorksheet('Second').addRow(['never shown']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A minimal workbook written by hand, to reach what spreadsheet writers never produce. */
function book(sheetData: string, sharedStrings?: string): Buffer {
  const part = (name: string, content: string) => ({
    name: Buffer.from(name),
    utf8Name: true,
    content: Buffer.from(content),
  });
  const parts = [
    part('[Content_Types].xml', '<Types/>'),
    part(
      'xl/workbook.xml',
      `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="PL" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    part('xl/worksheets/sheet1.xml', `<worksheet xmlns="${MAIN}">${sheetData}</worksheet>`),
  ];
  if (sharedStrings) {
    parts.push(part('xl/sharedStrings.xml', `<sst xmlns="${MAIN}">${sharedStrings}</sst>`));
  }
  return packStoredZip(parts);
}

describe('sheetPreview', () => {
  it('shows the first sheet as text: stored formula results, rich text, numbers as stored', async () => {
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
        sheet.addRow(['TOTAL', null, true]);
      }),
    );
    expect(preview).toEqual({
      sheetName: 'Packing list',
      truncated: false,
      rows: [
        { rowNumber: 1, cells: ['Marks', 'Total', 'Note', 'Date'] },
        // A date is a number in the file; the preview shows it as stored.
        { rowNumber: 2, cells: ['NOL/1', '7', 'Cotton', '46296'] },
        { rowNumber: 4, cells: ['TOTAL', '', 'true'] },
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

  it('reads inline and shared strings, prefixed names and missing references', async () => {
    const preview = await sheetPreview(
      book(
        '<x:sheetData xmlns:x="' +
          MAIN +
          '"><x:row><x:c t="s"><x:v>1</x:v></x:c><x:c t="inlineStr"><x:is><x:t>in</x:t><x:r><x:t>line</x:t></x:r><x:rPh><x:t>skip</x:t></x:rPh></x:is></x:c></x:row>' +
          '<x:row r="5"><x:c r="C5"><x:v>2.50</x:v></x:c><x:c t="e"><x:v>#N/A</x:v></x:c></x:row></x:sheetData>',
        '<si><t>unused</t></si><si><r><t>sha</t></r><r><t>red</t></r><rPh><t>skip</t></rPh></si>',
      ),
    );
    expect(preview).toEqual({
      sheetName: 'PL',
      truncated: false,
      rows: [
        { rowNumber: 1, cells: ['shared', 'inline'] },
        { rowNumber: 5, cells: ['', '', '2.50', '#N/A'] },
      ],
    });
  });

  it('refuses references beyond Excel’s limits at once, and a far cell costs nothing', async () => {
    const started = Date.now();
    expect(
      await sheetPreview(
        book('<sheetData><row r="1000000000"><c r="A1000000000"><v>1</v></c></row></sheetData>'),
      ),
    ).toBeNull();
    expect(
      await sheetPreview(book('<sheetData><row r="1"><c r="XFE1"><v>1</v></c></row></sheetData>')),
    ).toBeNull();
    const far = await sheetPreview(
      book(
        '<sheetData><row r="1"><c r="A1"><v>1</v></c></row>' +
          '<row r="1048576"><c r="A1048576"><v>2</v></c><c r="XFD1048576"><v>3</v></c></row></sheetData>',
      ),
    );
    expect(far).toEqual({
      sheetName: 'PL',
      truncated: true,
      rows: [
        { rowNumber: 1, cells: ['1'] },
        { rowNumber: 1048576, cells: ['2'] },
      ],
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('stops reading after the rows it shows, however long the sheet is', async () => {
    const row = (n: number) => `<row r="${n}"><c r="A${n}"><v>${n}</v></c></row>`;
    const rows = Array.from({ length: 200_000 }, (_, i) => row(i + 1)).join('');
    const started = Date.now();
    const preview = await sheetPreview(book(`<sheetData>${rows}</sheetData>`));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(preview?.truncated).toBe(true);
    expect(preview?.rows.at(-1)?.rowNumber).toBe(SHEET_PREVIEW_MAX_ROWS);
  });

  it('gives up past its time budget', async () => {
    const data = book('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>');
    expect(await sheetPreview(data, { timeBudgetMs: -1 })).toBeNull();
  });

  it('is null for bytes that are not a readable workbook, or entities it does not know', async () => {
    expect(await sheetPreview(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(await sheetPreview(Buffer.from('PK\u0003\u0004 broken'))).toBeNull();
    expect(
      await sheetPreview(
        book('<sheetData><row><c t="inlineStr"><is><t>&lol;</t></is></c></row></sheetData>'),
      ),
    ).toBeNull();
  });
});
