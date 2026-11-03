import type { CsDropOffDto } from '@nolon/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** The warehouse columns a drop-off point is read from. */
export const dropOffSelect = {
  nameAr: true,
  nameEn: true,
  address: true,
  addressEn: true,
  phone: true,
  mapUrl: true,
  latitude: true,
  longitude: true,
  hoursAr: true,
  hoursEn: true,
  isActive: true,
  acceptsDropOff: true,
} as const satisfies Prisma.WarehouseSelect;

export type DropOffRow = Prisma.WarehouseGetPayload<{ select: typeof dropOffSelect }>;

/** Both languages, the one given repeated when only one is; null when neither is. */
function pair(ar: string | null, en: string | null): { ar: string; en: string } | null {
  const a = ar?.trim() || null;
  const e = en?.trim() || null;
  if (a === null && e === null) return null;
  return { ar: a ?? e!, en: e ?? a! };
}

/**
 * Plan 09 section 11: a drop-off point as the bot reads it, from its current details (a corrected
 * phone shows at once). A point no longer active or no longer taking shipments reads as none. The
 * map link is the point's own, else a Google Maps search of its position, else none.
 */
export function dropOffDto(w: DropOffRow | null): CsDropOffDto | null {
  if (!w || !w.isActive || !w.acceptsDropOff) return null;
  const position =
    w.latitude !== null && w.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${w.latitude.toString()},${w.longitude.toString()}`
      : null;
  return {
    name: { ar: w.nameAr, en: w.nameEn },
    address: pair(w.address, w.addressEn),
    phone: w.phone,
    mapUrl: w.mapUrl ?? position,
    hours: pair(w.hoursAr, w.hoursEn),
  };
}
