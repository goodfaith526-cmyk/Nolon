import type { Prisma, RenumberedKind } from '../generated/prisma/client.js';

type Db = Prisma.TransactionClient;

/** The most records an old-number search adds to a list's search terms. */
const OLD_NUMBER_MATCHES = 200;

/**
 * A search term for records of `kind` once numbered with a number containing `q` (the renumbering
 * log: NOL-SHP-2026-000012 still finds that shipment). Spread into the list's OR terms: the
 * caller's branch scope applies to it like to every other term. Staff lists only; public tracking
 * and the agent are not given old numbers.
 */
export async function oldNumberTerm(
  db: Db,
  kind: RenumberedKind,
  q: string,
): Promise<{ id: { in: string[] } }[]> {
  const rows = await db.referenceRenumbering.findMany({
    where: { kind, oldNumber: { contains: q.trim(), mode: 'insensitive' } },
    select: { recordId: true },
    distinct: ['recordId'],
    take: OLD_NUMBER_MATCHES,
  });
  return rows.length > 0 ? [{ id: { in: rows.map((r) => r.recordId) } }] : [];
}

/**
 * Which of `recordIds` (records of `kind`) were once numbered exactly `number`: a note written
 * before a renumbering still names its record (B2: a container's moves).
 */
export async function onceNumbered(
  db: Db,
  kind: RenumberedKind,
  number: string,
  recordIds: readonly string[],
): Promise<string[]> {
  if (recordIds.length === 0) return [];
  const rows = await db.referenceRenumbering.findMany({
    where: { kind, oldNumber: number, recordId: { in: [...recordIds] } },
    select: { recordId: true },
    distinct: ['recordId'],
  });
  return rows.map((r) => r.recordId);
}
