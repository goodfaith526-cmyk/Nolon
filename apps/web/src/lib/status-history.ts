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

/**
 * A revert refused because the shipment changed since the page showed it (another step, another
 * revert, a container closed): the page reloads the shipment so the user reviews the step a
 * revert would now undo and confirms again. Nothing is resent.
 */
export function needsFreshShipment(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 409 &&
    (e.code === 'REVERT_STALE' || e.code === 'REVERT_CLOSED_CONTAINER')
  );
}
