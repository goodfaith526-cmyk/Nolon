import { describe, expect, it } from 'vitest';
import { packStoredZip } from '../common/zip-guard.js';
import {
  attachmentDisposition,
  cleanFileName,
  detectContentType,
  isXlsxWorkbook,
} from './file-type.js';

const zip = (...names: string[]) =>
  packStoredZip(
    names.map((name) => ({
      name: Buffer.from(name),
      utf8Name: true,
      content: Buffer.from('<x/>'),
    })),
  );

const bytes = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])),
  );

describe('detectContentType', () => {
  it('recognizes PDF, JPEG, PNG and WebP by their first bytes', () => {
    expect(detectContentType(bytes('%PDF-1.7\n'))).toBe('application/pdf');
    expect(detectContentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(detectContentType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(detectContentType(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toBe('image/webp');
  });

  it('rejects anything else, whatever its name or declared type', () => {
    expect(detectContentType(bytes('<html><script>'))).toBeNull();
    expect(detectContentType(bytes('<svg xmlns='))).toBeNull();
    expect(detectContentType(bytes('MZ'))).toBeNull();
    expect(detectContentType(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBeNull();
    expect(detectContentType(new Uint8Array())).toBeNull();
  });
});

describe('file names', () => {
  it('drops paths and control characters', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\temp\\bl.pdf')).toBe('bl.pdf');
    expect(cleanFileName('a\u0000b\r\n"c".pdf')).toBe('abc.pdf');
    expect(cleanFileName('   ')).toBe('document');
    expect(cleanFileName('x'.repeat(300))).toHaveLength(255);
  });

  it('keeps Arabic names in the UTF-8 form of the download header', () => {
    const header = attachmentDisposition('بوليصة.pdf');
    expect(header).toContain('filename="______.pdf"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('بوليصة.pdf')}`);
  });
});

describe('isXlsxWorkbook', () => {
  it('accepts a zip with a workbook part', () => {
    expect(isXlsxWorkbook(zip('[Content_Types].xml', 'xl/workbook.xml'))).toBe(true);
  });

  it('refuses a macro-enabled workbook, a zip without a workbook and anything not a zip', () => {
    expect(isXlsxWorkbook(zip('[Content_Types].xml', 'xl/workbook.xml', 'xl/vbaProject.bin'))).toBe(
      false,
    );
    expect(isXlsxWorkbook(zip('[Content_Types].xml', 'word/document.xml'))).toBe(false);
    expect(isXlsxWorkbook(Buffer.from('%PDF-1.7\n'))).toBe(false);
  });
});
