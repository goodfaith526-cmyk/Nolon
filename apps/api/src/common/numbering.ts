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

/** NOL-QT-2026-000001 (yearly) or NOL-CUS-000001 (never resets). */
export function formatDocumentNumber(prefix: string, value: bigint, year?: string): string {
  const serial = value.toString().padStart(6, '0');
  return year ? `NOL-${prefix}-${year}-${serial}` : `NOL-${prefix}-${serial}`;
}
