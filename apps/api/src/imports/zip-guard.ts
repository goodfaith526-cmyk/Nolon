import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Unpacks an .xlsx (a zip archive) under a hard cap on what it expands to, and packs the verified
 * entries again, uncompressed, for the workbook reader.
 *
 * The sizes an archive declares cannot be trusted: a few megabytes of deflate data can claim to
 * hold a hundred bytes and expand into gigabytes (a "zip bomb"), and the zip library behind
 * exceljs inflates a whole entry before it compares the result with the declared size. So every
 * entry is inflated here, counting the bytes actually produced against a running cap that stops
 * zlib as soon as it is reached. Only the rebuilt archive (stored entries, real sizes) reaches
 * exceljs, so it never inflates anything that was not counted. Zip64, encrypted entries and
 * compression methods other than stored and deflate are refused: a template never uses them.
 */

const LOCAL_ENTRY_SIGNATURE = 0x04034b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_LENGTH = 30;
const CENTRAL_HEADER_LENGTH = 46;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAME = 0x0800;
/** 1980-01-01, the earliest date a zip header can hold; the rebuilt archive needs none better. */
const DOS_DATE = (1 << 5) | 1;

export interface ZipLimits {
  maxEntries: number;
  /** Cap on the bytes all entries together actually expand to. */
  maxUncompressedBytes: number;
}

export interface ZipEntry {
  /** The name as stored in the archive (raw bytes, decoded by the reader). */
  name: Buffer;
  utf8Name: boolean;
  content: Buffer;
}

export function isZipSignature(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt32LE(0) === LOCAL_ENTRY_SIGNATURE;
}

function findEndOfDirectory(data: Buffer): number {
  const searchFrom = Math.max(0, data.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let i = data.length - EOCD_MIN_LENGTH; i >= searchFrom; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** Inflates `slice` into at most `remaining` bytes; null when it would expand further. */
function inflateWithin(slice: Buffer, remaining: number): Buffer | null {
  if (remaining <= 0) return null;
  try {
    // zlib stops (and throws) as soon as the output would pass maxOutputLength.
    return inflateRawSync(slice, { maxOutputLength: remaining });
  } catch {
    return null;
  }
}

/**
 * The archive's entries, each inflated under the running cap; null when the archive is unsound,
 * uses a feature refused above, or its entries expand beyond `limits`.
 */
export function unpackZip(data: Buffer, limits: ZipLimits): ZipEntry[] | null {
  if (!isZipSignature(data) || data.length < EOCD_MIN_LENGTH) return null;
  const eocd = findEndOfDirectory(data);
  if (eocd < 0) return null;
  const count = data.readUInt16LE(eocd + 10);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) return null;
  if (count > limits.maxEntries) return null;

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (
      offset + CENTRAL_HEADER_LENGTH > data.length ||
      data.readUInt32LE(offset) !== CENTRAL_ENTRY_SIGNATURE
    ) {
      return null;
    }
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const nameEnd = offset + CENTRAL_HEADER_LENGTH + nameLength;
    if (nameEnd > data.length) return null;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) return null;
    if ((flags & FLAG_ENCRYPTED) !== 0) return null;
    const name = data.subarray(offset + CENTRAL_HEADER_LENGTH, nameEnd);

    if (
      localOffset + LOCAL_HEADER_LENGTH > data.length ||
      data.readUInt32LE(localOffset) !== LOCAL_ENTRY_SIGNATURE
    ) {
      return null;
    }
    const start =
      localOffset +
      LOCAL_HEADER_LENGTH +
      data.readUInt16LE(localOffset + 26) +
      data.readUInt16LE(localOffset + 28);
    if (start + compressedSize > data.length) return null;
    const slice = data.subarray(start, start + compressedSize);

    const remaining = limits.maxUncompressedBytes - total;
    let content: Buffer | null;
    if (method === METHOD_STORED) {
      content = slice;
    } else if (method === METHOD_DEFLATE) {
      content = slice.length === 0 ? Buffer.alloc(0) : inflateWithin(slice, remaining);
    } else {
      return null;
    }
    if (content === null || content.length > remaining) return null;
    if (crc32(content) !== crc) return null;
    total += content.length;
    entries.push({ name, utf8Name: (flags & FLAG_UTF8_NAME) !== 0, content });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** A zip archive of `entries`, all stored (not compressed), with their real sizes. */
export function packStoredZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, utf8Name, content } of entries) {
    const flags = utf8Name ? FLAG_UTF8_NAME : 0;
    const crc = crc32(content);
    const local = Buffer.alloc(LOCAL_HEADER_LENGTH);
    local.writeUInt32LE(LOCAL_ENTRY_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(METHOD_STORED, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(CENTRAL_HEADER_LENGTH);
    central.writeUInt32LE(CENTRAL_ENTRY_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(METHOD_STORED, 10);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    parts.push(local, name, content);
    directory.push(central, name);
    offset += LOCAL_HEADER_LENGTH + name.length + content.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(EOCD_MIN_LENGTH);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

/**
 * The archive rebuilt from entries inflated under `limits`, safe to hand to exceljs; null when
 * it is unsound or expands too far.
 */
export function repackZip(data: Buffer, limits: ZipLimits): Buffer | null {
  const entries = unpackZip(data, limits);
  return entries ? packStoredZip(entries) : null;
}
