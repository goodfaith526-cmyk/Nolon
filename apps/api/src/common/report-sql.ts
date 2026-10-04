import type { AuditEntity, AuditLogEntryDto } from '@nolon/shared';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Pieces of the report queries (raw SQL with bound parameters only; nothing user-given is
 * concatenated into the text).
 */

/** `(${id1}::uuid, ...)` for `column IN ...`. Callers return early on an empty list. */
export function uuidList(ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`;
}

/** `AND <condition>` when `value` is given, else nothing. */
export function andIf<T>(value: T | null | undefined, condition: (v: T) => Prisma.Sql): Prisma.Sql {
  return value === null || value === undefined ? Prisma.empty : Prisma.sql`AND ${condition(value)}`;
}

/** Report rows are capped: ask for one more to know whether there were more. */
export function overLimit<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  return rows.length > limit
    ? { rows: rows.slice(0, limit), truncated: true }
    : { rows, truncated: false };
}

/** A YYYY-MM-DD parameter as a SQL date (never through a timestamp, so no time zone shift). */
export function sqlDate(value: string): Prisma.Sql {
  return Prisma.sql`${value}::date`;
}

/** What each module's audit log source is asked for (annex D section 3, report 10). */
export interface AuditQuery {
  from: string;
  to: string;
  branchId?: string;
  userId?: string;
  /**
   * Only this kind of record. A source holding several kinds filters on it in its SQL, before its
   * row limit, so the newest rows of other kinds cannot crowd out the wanted ones.
   */
  entity?: AuditEntity;
  /** Newest first; a source returns at most limit + 1 rows. */
  limit: number;
}

/** An audit entry whose reference is its shipment's number, filled in through the shipments module. */
export type ShipmentAuditEntry = Omit<AuditLogEntryDto, 'reference'> & { shipmentId: string };

/** `AND x."entity" = ...` when the audit query asks for one kind of record. */
export function auditEntityFilter(q: AuditQuery): Prisma.Sql {
  return andIf(q.entity, (e) => Prisma.sql`x."entity" = ${e}`);
}
