import type { ContainerCapacityDimensionDto, ContainerMeasure, DecimalString } from '@nolon/shared';
import { type Decimal, ZERO, toDecimalString } from '../common/money.js';

/**
 * A shared container's space (plan docs/reviews/lcl-numbering-capacity-plan-2026-10-27.md, section
 * 1, F111-6 and condition 5). Pure functions: the service applies them to the cargo it reads under
 * the container's lock, and the picker's estimate uses the same ones.
 *
 * A cargo line without a measure is not counted as zero: that dimension is "not checked" for the
 * shipment. The block uses the known load only; closing and loading need every measure the type
 * limits.
 */

export const MEASURES: readonly ContainerMeasure[] = ['volumeCbm', 'weightKg'];

/** The type's usable space; null: no limit on that measure. */
export type ContainerLimits = Record<ContainerMeasure, Decimal | null>;

export interface CargoShipment {
  id: string;
  items: readonly { volumeCbm: Decimal | null; weightKg: Decimal | null }[];
}

export interface MeasureLoad {
  /** The known load: lines that carry the measure. */
  used: Decimal;
  /** Shipments with no line, or a line without this measure. */
  pending: string[];
}

export type ContainerLoad = Record<ContainerMeasure, MeasureLoad>;

/** The measures a shipment's cargo does not fully give (no lines at all counts as missing). */
export function missingMeasures(shipment: CargoShipment): ContainerMeasure[] {
  return MEASURES.filter(
    (m) => shipment.items.length === 0 || shipment.items.some((i) => i[m] === null),
  );
}

/** The known CBM or weight of one shipment: the sum of the lines that carry it. */
export function knownMeasure(shipment: CargoShipment, measure: ContainerMeasure): Decimal {
  return shipment.items.reduce((acc, i) => acc.plus(i[measure] ?? ZERO), ZERO);
}

export function containerLoad(shipments: readonly CargoShipment[]): ContainerLoad {
  const load: ContainerLoad = {
    volumeCbm: { used: ZERO, pending: [] },
    weightKg: { used: ZERO, pending: [] },
  };
  for (const s of shipments) {
    const missing = missingMeasures(s);
    for (const m of MEASURES) {
      load[m].used = load[m].used.plus(knownMeasure(s, m));
      if (missing.includes(m)) load[m].pending.push(s.id);
    }
  }
  return load;
}

/**
 * The measures on which a write takes the container over its limit: the known load after it is
 * over the limit and higher than before. An administrator may lower a limit below a container's
 * load; afterwards only writes that add to it are refused (condition 5).
 */
export function overLimits(
  limits: ContainerLimits,
  before: ContainerLoad,
  after: ContainerLoad,
): ContainerMeasure[] {
  return MEASURES.filter((m) => {
    const limit = limits[m];
    return limit !== null && after[m].used.gt(limit) && after[m].used.gt(before[m].used);
  });
}

/**
 * Closing and loading (F111-6): for each measure the type limits, the shipments with a line
 * without it. Empty when every limited measure is known.
 */
export function unmeasured(
  limits: ContainerLimits,
  load: ContainerLoad,
): { measure: ContainerMeasure; shipmentIds: string[] }[] {
  return MEASURES.filter((m) => limits[m] !== null && load[m].pending.length > 0).map((m) => ({
    measure: m,
    shipmentIds: load[m].pending,
  }));
}

/** Percent, one decimal, for display only. */
function percent(used: Decimal, limit: Decimal): DecimalString {
  return toDecimalString(used.times(100).dividedBy(limit).toDecimalPlaces(1));
}

export function dimensionDto(
  limit: Decimal | null,
  load: MeasureLoad,
): ContainerCapacityDimensionDto {
  return {
    limit: limit === null ? null : toDecimalString(limit),
    used: toDecimalString(load.used),
    remaining: limit === null ? null : toDecimalString(limit.minus(load.used)),
    fillPercent: limit === null ? null : percent(load.used, limit),
    complete: load.pending.length === 0,
  };
}

/** The higher fill of the limited measures (the list's column); null when none is limited. */
export function fillOf(
  limits: ContainerLimits,
  load: ContainerLoad,
): { fillPercent: DecimalString | null; fillIncomplete: boolean } {
  let highest: Decimal | null = null;
  let incomplete = false;
  for (const m of MEASURES) {
    const limit = limits[m];
    if (limit === null) continue;
    const fill = load[m].used.times(100).dividedBy(limit);
    if (highest === null || fill.gt(highest)) highest = fill;
    if (load[m].pending.length > 0) incomplete = true;
  }
  return {
    fillPercent: highest === null ? null : toDecimalString(highest.toDecimalPlaces(1)),
    fillIncomplete: incomplete,
  };
}
