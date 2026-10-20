import {
  hasSeaLeg,
  loadTypeOf,
  type CargoType,
  type LoadType,
  type ShippingMode,
} from '@nolon/shared';

interface Offer {
  mode: ShippingMode;
  cargoType: CargoType;
}

/**
 * The FCL/LCL a quotation or rate is saved with (functional review B2). One given is kept, null
 * and LCL for a container included. One left out follows the mode and cargo type (loadTypeOf); on
 * an edit (`stored`, as saved) it follows them only if the saved one did, else the saved one is
 * kept, as a booking's header is (#91). A mode without a sea leg has none.
 */
export function followLoadType(
  given: LoadType | null | undefined,
  next: Offer,
  stored?: (Offer & { loadType: LoadType | null }) | null,
): LoadType | null {
  if (given !== undefined) return given;
  if (!hasSeaLeg(next.mode)) return null;
  if (stored && stored.loadType !== loadTypeOf(stored.mode, stored.cargoType)) {
    return stored.loadType;
  }
  return loadTypeOf(next.mode, next.cargoType);
}
