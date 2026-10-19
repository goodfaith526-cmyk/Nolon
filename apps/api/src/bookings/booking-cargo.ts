import { hasSeaLeg, type CargoType, type LoadType, type ShippingMode } from '@nolon/shared';

/** The longest booking cargo description the API takes (`cargoDescription`, optionalText(2000)). */
const MAX_CARGO_DESCRIPTION = 2000;

interface CargoLine {
  cargoType: CargoType;
  description?: string | null;
}

/** What the booking header says of its cargo, and what it is read from. */
export interface BookingCargo {
  mode: ShippingMode;
  loadType: LoadType | null;
  cargoType: CargoType | null;
  cargoDescription: string | null;
  items: readonly CargoLine[];
}

type CargoHeader = Pick<BookingCargo, 'loadType' | 'cargoType' | 'cargoDescription'>;

/**
 * The cargo header of a booking saved with `input` (owner «نظّف», 2026-10-19: the form asks the
 * cargo type and description on the lines only, and no FCL/LCL). A value given is kept. A value
 * left out follows the lines: the first line's cargo type; FCL when a line is a container, else
 * LCL, for a mode with a sea leg; the lines' descriptions. On an edit (`stored`, the booking as
 * saved), a value left out is kept as saved when the lines give none, or when it was saved apart
 * from its lines (an older booking's, or one an API client gave), so an edit that leaves it out
 * never rewrites it.
 */
export function bookingCargoHeader(
  input: Omit<BookingCargo, keyof CargoHeader> & {
    [K in keyof CargoHeader]?: CargoHeader[K] | undefined;
  },
  stored?: BookingCargo | null,
): CargoHeader {
  const follow = <T>(
    given: T | null | undefined,
    fromLines: (mode: ShippingMode, items: readonly CargoLine[]) => T | null,
    saved: T | null | undefined,
  ): T | null => {
    if (given) return given;
    const fresh = fromLines(input.mode, input.items);
    if (!stored || saved === null || saved === undefined) return fresh;
    if (fresh === null || saved !== fromLines(stored.mode, stored.items)) return saved;
    return fresh;
  };
  const loadType = follow(input.loadType, loadTypeOfLines, stored?.loadType);
  return {
    cargoType: follow(input.cargoType, cargoTypeOfLines, stored?.cargoType),
    // A saved FCL/LCL does not outlive the sea leg: a road booking has none.
    loadType: input.loadType || hasSeaLeg(input.mode) ? loadType : null,
    cargoDescription: follow(input.cargoDescription, descriptionOfLines, stored?.cargoDescription),
  };
}

function cargoTypeOfLines(_mode: ShippingMode, items: readonly CargoLine[]): CargoType | null {
  return items[0]?.cargoType ?? null;
}

/** A container line books a full container; pallets and barrels share one. */
function loadTypeOfLines(mode: ShippingMode, items: readonly CargoLine[]): LoadType | null {
  if (!hasSeaLeg(mode) || items.length === 0) return null;
  return items.some((i) => i.cargoType === 'CONTAINER') ? 'FCL' : 'LCL';
}

/** Each line's description once, in line order, as the documents print the goods. */
function descriptionOfLines(_mode: ShippingMode, items: readonly CargoLine[]): string | null {
  const lines = [...new Set(items.map((i) => i.description?.trim() ?? '').filter((d) => d !== ''))];
  if (lines.length === 0) return null;
  return lines.join('\n').slice(0, MAX_CARGO_DESCRIPTION);
}
