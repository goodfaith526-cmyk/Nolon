import { createHash } from 'node:crypto';
import type { ImportKind } from '@nolon/shared';

/**
 * Ids of the records an import creates, derived from the request so that a retry finds what the
 * first attempt wrote instead of writing it twice, and so that a request id cannot be replayed
 * with something else.
 *
 * A request is the client's requestId plus its fingerprint: the import kind, the user and the
 * SHA-256 of the uploaded file. Each id is a name-based UUID (version 8 layout) in two halves:
 *
 * - the first 8 bytes come from the requestId alone, so every record any import ever wrote under
 *   a requestId lies in one id range (importRequestRange), found through the primary key;
 * - the last 8 bytes come from the requestId, the fingerprint and the row index.
 *
 * An exact retry derives the same ids and finds them. The same requestId with another file, user
 * or kind derives other ids, finds none of them, but finds records in the requestId's range: it
 * was used for something else, and is refused. No table is needed to remember fingerprints.
 */

export interface ImportRequest {
  kind: ImportKind;
  requestId: string;
  /** SHA-256 (hex) of kind, user id and the file's own SHA-256. */
  fingerprint: string;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();

export function importRequest(
  kind: ImportKind,
  requestId: string,
  userId: string,
  file: Buffer,
): ImportRequest {
  const fileHash = sha256(file).toString('hex');
  const fingerprint = sha256(`${kind}|${userId}|${fileHash}`).toString('hex');
  return { kind, requestId, fingerprint };
}

function requestPrefix(requestId: string): Buffer {
  const prefix = Buffer.from(sha256(`nolon-import:${requestId}`).subarray(0, 8));
  prefix[6] = ((prefix[6] ?? 0) & 0x0f) | 0x80;
  return prefix;
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id of the n-th record the request creates. */
export function importRecordId(request: ImportRequest, index: number): string {
  const suffix = sha256(
    `nolon-import:${request.requestId}:${request.fingerprint}:${index}`,
  ).subarray(0, 8);
  suffix[0] = ((suffix[0] ?? 0) & 0x3f) | 0x80;
  return formatUuid(Buffer.concat([requestPrefix(request.requestId), suffix]));
}

export function importRecordIds(request: ImportRequest, count: number): string[] {
  return Array.from({ length: count }, (_, i) => importRecordId(request, i));
}

/**
 * The id range holding every record created under `requestId`, whatever the fingerprint
 * (PostgreSQL orders uuids byte by byte).
 */
export function importRequestRange(requestId: string): { from: string; to: string } {
  const prefix = requestPrefix(requestId);
  return {
    from: formatUuid(Buffer.concat([prefix, Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0])])),
    to: formatUuid(Buffer.concat([prefix, Buffer.from([0xbf, 255, 255, 255, 255, 255, 255, 255])])),
  };
}
