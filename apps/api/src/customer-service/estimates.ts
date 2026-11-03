import type { CsEstimateDto, CsRequestPhotoType } from '@nolon/shared';
import { toDecimalString } from '../common/money.js';
import type { CsBookingRequest } from '../generated/prisma/client.js';
import { pair } from './drop-off.js';

/**
 * Plan 09 section 12: the latest estimate of a request as the bot reads it, or null when staff
 * made none. Whether the bot is shown it (the request `estimated`) is the caller's to decide.
 */
export function estimateOf(
  r: Pick<
    CsBookingRequest,
    | 'estimateVersion'
    | 'estimateAmount'
    | 'estimateCurrency'
    | 'estimateNoteAr'
    | 'estimateNoteEn'
    | 'estimateValidUntil'
  >,
): CsEstimateDto | null {
  if (
    r.estimateVersion < 1 ||
    r.estimateAmount === null ||
    r.estimateCurrency === null ||
    r.estimateValidUntil === null
  )
    return null;
  return {
    version: r.estimateVersion,
    amount: toDecimalString(r.estimateAmount),
    currency: r.estimateCurrency,
    note: pair(r.estimateNoteAr, r.estimateNoteEn),
    validUntil: r.estimateValidUntil.toISOString(),
  };
}

/**
 * The image type of a photo read from its first bytes, never from a header (plan 09 section 12):
 * JPEG, PNG or WebP, else null.
 */
export function imageTypeOf(bytes: Buffer): CsRequestPhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}
