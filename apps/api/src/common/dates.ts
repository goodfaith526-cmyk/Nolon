/** Calendar dates (`@db.Date` columns) cross the API as YYYY-MM-DD. */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** YYYY-MM-DD to the Date Prisma stores in a DATE column (UTC midnight). */
export function toDbDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function fromDbDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function fromDbDateOrNull(value: Date | null): string | null {
  return value === null ? null : fromDbDate(value);
}

/** Today's date in a branch's time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
