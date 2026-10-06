import { fromDbDate } from './dates.js';

/**
 * What a module returns for one of the internal alerts (scope section 15): the rows past the wait,
 * scoped to the user's branches by the module that owns them, and how many there are in all.
 */
export interface AlertRow {
  refId: string;
  number: string;
  branchCode: string;
  detail: string | null;
  /** YYYY-MM-DD in the record's branch: the day the wait started. */
  since: string;
  days: number;
}

export interface AlertRows {
  count: number;
  rows: AlertRow[];
}

/** A row as the alert queries select it: the day as a date, and count(*) OVER () as "count". */
export interface AlertSqlRow extends Omit<AlertRow, 'since'> {
  since: Date;
  count: number;
}

export function alertRows(rows: readonly AlertSqlRow[]): AlertRows {
  return {
    count: rows[0]?.count ?? 0,
    rows: rows.map((r) => ({
      refId: r.refId,
      number: r.number,
      branchCode: r.branchCode,
      detail: r.detail,
      since: fromDbDate(r.since),
      days: r.days,
    })),
  };
}
