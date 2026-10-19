import { hasSeaLeg, type CargoType, type LoadType, type ShippingMode } from '@nolon/shared';

/** The longest booking cargo description the API takes (`cargoDescription`, optionalText(2000)). */
const MAX_CARGO_DESCRIPTION = 2000;

interface CargoLine {
  cargoType: CargoType;
  description?: string | null;
}

/**
 * The booking's cargo type: the one given, else its first line's (owner, 2026-10-19: the form asks
 * for the cargo type on each line only). Null when neither is there.
 */
export function bookingCargoType(
  given: CargoType | null | undefined,
  items: readonly CargoLine[],
): CargoType | null {
  return given ?? items[0]?.cargoType ?? null;
}

/**
 * FCL or LCL: the one given, else from the lines when the booking has a sea leg (a container line
 * books a full container; pallets and barrels share one). Null for a road booking, or with no
 * lines to tell from.
 */
export function bookingLoadType(
  mode: ShippingMode,
  given: LoadType | null | undefined,
  items: readonly CargoLine[],
): LoadType | null {
  if (given) return given;
  if (!hasSeaLeg(mode) || items.length === 0) return null;
  return items.some((i) => i.cargoType === 'CONTAINER') ? 'FCL' : 'LCL';
}

/**
 * The description printed on the booking and shipment documents: the one given, else the lines'
 * descriptions (each once, in line order), so the goods are described once, on their lines.
 */
export function bookingCargoDescription(
  given: string | null | undefined,
  items: readonly CargoLine[],
): string | null {
  if (given) return given;
  const lines = [...new Set(items.map((i) => i.description?.trim() ?? '').filter((d) => d !== ''))];
  if (lines.length === 0) return null;
  return lines.join('\n').slice(0, MAX_CARGO_DESCRIPTION);
}
