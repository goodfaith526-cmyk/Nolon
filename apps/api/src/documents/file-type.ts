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
