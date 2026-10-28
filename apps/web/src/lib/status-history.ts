import { ApiError } from './api';

/**
 * The earliest time a status change may carry (ISO, to the millisecond) as the `min` of a
 * datetime-local input, which holds minutes: rounded UP to the next whole minute, so the earliest
 * minute offered is one the API accepts. The entered time itself is never changed.
 */
export function earliestLocalMinute(iso: string): string {
  const minute = 60_000;
  const date = new Date(Math.ceil(Date.parse(iso) / minute) * minute);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const FRESH_SHIPMENT_REFUSALS: readonly string[] = [
  'REVERT_STALE',
  'REVERT_CLOSED_CONTAINER',
  'SHIPMENT_CLOSE_GOODS_ON_HAND',
  'SHIPMENT_CLOSE_NOT_INVOICED',
];

/**
 * A revert refused because the shipment changed since the page showed it (another step, another
 * revert, a container closed), or a close refused for its goods or its invoice (B1-5): the page
 * reloads the shipment so the user reviews it as it is now and acts again. Nothing is resent.
 */
export function needsFreshShipment(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 409 &&
    e.code !== null &&
    FRESH_SHIPMENT_REFUSALS.includes(e.code)
  );
}
