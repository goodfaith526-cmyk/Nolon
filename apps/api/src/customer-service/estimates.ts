import type {
  CsEstimateDto,
  CsEstimateTerms,
  CsRequestPhotoType,
  LoadType,
  ShippingMode,
} from '@nolon/shared';
import { toDecimalString } from '../common/money.js';
import type { CsBookingRequest, Prisma } from '../generated/prisma/client.js';
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

/**
 * Codex F171-2: what an estimate prices, stored with it: the route, mode and load type, the
 * request's services (sorted) and a key of its items (each line's category, quantity, pieces,
 * dimensions and weight), so approval can book only what the customer accepted.
 */
export type EstimateTerms = CsEstimateTerms & { services: string[]; cargo: string };

/** The stored terms read back, or null when none (an estimate made before F171-2). */
export function storedTerms(stored: Prisma.JsonValue): EstimateTerms | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const { originId, destinationId, mode, loadType, services, cargo } = stored;
  if (
    typeof originId !== 'string' ||
    typeof destinationId !== 'string' ||
    typeof mode !== 'string' ||
    (loadType !== null && typeof loadType !== 'string') ||
    !Array.isArray(services) ||
    !services.every((v) => typeof v === 'string') ||
    typeof cargo !== 'string'
  )
    return null;
  return {
    originId,
    destinationId,
    mode: mode as ShippingMode,
    loadType: loadType as LoadType | null,
    services: services,
    cargo,
  };
}
