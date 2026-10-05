/**
 * A cheap look at an .xlsx (a zip archive) before it is unpacked: the central directory must be
 * readable, and the entries' declared sizes must stay within bounds, so a small upload cannot
 * expand into gigabytes in memory (a "zip bomb"). Zip64 archives are refused: a template never
 * needs one.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

export function isZipSignature(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
}

/** True when the archive's directory is sound and within the limits. */
export function zipWithinLimits(data: Buffer, limits: ZipLimits): boolean {
  if (!isZipSignature(data) || data.length < EOCD_MIN_LENGTH) return false;
  const searchFrom = Math.max(0, data.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  let eocd = -1;
  for (let i = data.length - EOCD_MIN_LENGTH; i >= searchFrom; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  const entries = data.readUInt16LE(eocd + 10);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff) return false;
  if (entries > limits.maxEntries) return false;

  let offset = directoryOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL_ENTRY_SIGNATURE) {
      return false;
    }
    const compressed = data.readUInt32LE(offset + 20);
    const uncompressed = data.readUInt32LE(offset + 24);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) return false;
    total += uncompressed;
    if (total > limits.maxUncompressedBytes) return false;
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return true;
}
