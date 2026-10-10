import { unpackZip } from '../common/zip-guard.js';

/**
 * Detects an uploaded file's type from its first bytes. The browser's Content-Type and the file
 * name are never trusted: only these formats are accepted, and the stored type is the detected one.
 */
export type AllowedContentType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

function startsWith(data: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((byte, i) => data[offset + i] === byte);
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

export function detectContentType(data: Uint8Array): AllowedContentType | null {
  if (startsWith(data, ascii('%PDF-'))) return 'application/pdf';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

/**
 * Bounds an .xlsx may expand to when it is checked, counted on the bytes actually inflated
 * (common/zip-guard.ts). A packing list is a few sheets of text.
 */
const XLSX_ZIP_LIMITS = { maxEntries: 200, maxUncompressedBytes: 32 * 1024 * 1024 };

/**
 * True for a sound .xlsx workbook: a zip that inflates within the limits, holds a workbook part,
 * and carries no macros (a macro-enabled workbook renamed to .xlsx is refused).
 */
export function isXlsxWorkbook(data: Buffer): boolean {
  const entries = unpackZip(data, XLSX_ZIP_LIMITS);
  if (!entries) return false;
  const names = entries.map((e) => e.name.toString('utf8').toLowerCase());
  return (
    names.includes('[content_types].xml') &&
    names.includes('xl/workbook.xml') &&
    !names.some((name) => name.endsWith('vbaproject.bin'))
  );
}

/** Display name for a download: no path, no control characters, at most 255 characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point here.
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'document').slice(0, 255);
}

/** Content-Disposition for a download, with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
