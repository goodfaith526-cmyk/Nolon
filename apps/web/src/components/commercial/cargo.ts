import { OFFERED_CARGO_TYPES, type CargoType } from '@nolon/shared';

/** The cargo types offered, and a record's own one when it is no longer offered (GENERAL). */
export const cargoChoices = (current: CargoType): readonly CargoType[] =>
  (OFFERED_CARGO_TYPES as readonly CargoType[]).includes(current)
    ? OFFERED_CARGO_TYPES
    : [...OFFERED_CARGO_TYPES, current];
