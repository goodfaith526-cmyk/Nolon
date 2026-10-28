import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * Next number of a document sequence, taken inside the caller's transaction. The row lock taken
 * by the upsert serializes concurrent callers; if the transaction rolls back, so does the number,
 * so numbers have no gaps.
 */
export async function nextSequenceValue(tx: Tx, docType: string, periodKey = ''): Promise<bigint> {
  const rows = await tx.$queryRaw<{ value: bigint }[]>`
    INSERT INTO "number_sequences" ("doc_type", "period_key", "next_value")
    VALUES (${docType}, ${periodKey}, 2)
    ON CONFLICT ("doc_type", "period_key")
    DO UPDATE SET "next_value" = "number_sequences"."next_value" + 1
    RETURNING "next_value" - 1 AS "value"`;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error(`No sequence value for ${docType}`);
  return value;
}

/**
 * The first of `count` consecutive numbers of a sequence, reserved at once inside the caller's
 * transaction (bulk import). Same locking and no-gap guarantee as `nextSequenceValue`.
 */
export async function nextSequenceRange(tx: Tx, docType: string, count: number): Promise<bigint> {
  const rows = await tx.$queryRaw<{ value: bigint }[]>`
    INSERT INTO "number_sequences" ("doc_type", "period_key", "next_value")
    VALUES (${docType}, '', ${count + 1}::bigint)
    ON CONFLICT ("doc_type", "period_key")
    DO UPDATE SET "next_value" = "number_sequences"."next_value" + ${count}::bigint
    RETURNING "next_value" - ${count}::bigint AS "value"`;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error(`No sequence value for ${docType}`);
  return value;
}

/** NOL-SHP-2026-000001 (yearly) or NOL-SUP-000001 (never resets). */
export function formatDocumentNumber(prefix: string, value: bigint, year?: string): string {
  const serial = value.toString().padStart(6, '0');
  return year ? `NOL-${prefix}-${year}-${serial}` : `NOL-${prefix}-${serial}`;
}

/**
 * The client's short numbers for bookings, quotations and customers: BK00001, QT00001, CS00001.
 * Five digits, no year, never reset; the 100,000th record simply gets six digits.
 */
export function formatShortNumber(prefix: 'BK' | 'QT' | 'CS', value: bigint): string {
  return `${prefix}${value.toString().padStart(5, '0')}`;
}

/**
 * Route numbers (owner, 2026-10-27): an LCL booking DXB-KRT-0001, a shared container
 * DXB-KRT-C0001. Four digits, a fifth after 9999; one counter per kind and route letters.
 */
export function formatRouteNumber(letters: string, value: bigint, container = false): string {
  return `${letters}-${container ? 'C' : ''}${value.toString().padStart(4, '0')}`;
}

/** The counter of route numbers of one kind (number_sequences.doc_type; the letters are the key). */
export const ROUTE_SEQUENCES = { booking: 'LCL_BOOKING', container: 'LCL_CONTAINER' } as const;

/** Whether a booking number is a route number of these letters (DXB-KRT-0001 of DXB-KRT). */
export function isRouteNumberOf(number: string, letters: string): boolean {
  return number.startsWith(`${letters}-`) && /^\d{4,}$/.test(number.slice(letters.length + 1));
}
