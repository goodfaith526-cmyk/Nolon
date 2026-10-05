import { createHash } from 'node:crypto';

/**
 * The id of the n-th record an import creates, derived from the client's requestId (a name-based
 * UUID, version 5 layout). A retry of the same request derives the same ids, so it finds the
 * records the first attempt wrote instead of writing them twice.
 */
export function importRecordId(requestId: string, index: number): string {
  const hash = createHash('sha1').update(`nolon-import:${requestId}:${index}`).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function importRecordIds(requestId: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => importRecordId(requestId, i));
}
