import type { LocationEffect } from './shipment-links.registry.js';

/**
 * Where the shipment is, after a correction took a step or a record out (B3, section 0 of
 * docs/plans/05-correction-contracts.md): the latest of the remaining steps that carry a place and
 * the live records that moved the shipment without a step (a proof of delivery that kept the
 * status), by time, then by when they were recorded. Null when none carries a place.
 */
export function currentLocationOf(timeline: readonly LocationEffect[]): string | null {
  let latest: LocationEffect | null = null;
  for (const entry of timeline) {
    if (
      !latest ||
      entry.at.getTime() > latest.at.getTime() ||
      (entry.at.getTime() === latest.at.getTime() &&
        entry.createdAt.getTime() >= latest.createdAt.getTime())
    ) {
      latest = entry;
    }
  }
  return latest?.locationId ?? null;
}
