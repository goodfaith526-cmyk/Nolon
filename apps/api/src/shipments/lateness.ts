import type { ShipmentStatus } from '@nolon/shared';
import { daysBetween } from '../common/dates.js';

/** Statuses at which the cargo has reached the consignee (CLOSED comes after DELIVERED). */
export const DELIVERED_STATUSES: readonly ShipmentStatus[] = ['DELIVERED', 'CLOSED'];

/** Statuses that no longer count as open work. */
export const FINISHED_STATUSES: readonly ShipmentStatus[] = [...DELIVERED_STATUSES, 'CANCELLED'];

/**
 * Days a shipment is late against its ETA (dates in its branch): a delivered one by the day it was
 * delivered, an open one by today. Delivered on the ETA, or still open on the ETA day, is not late:
 * null.
 */
export function daysLate(eta: string, deliveredOn: string | null, today: string): number | null {
  const days = daysBetween(eta, deliveredOn ?? today);
  return days > 0 ? days : null;
}
