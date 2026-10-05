import { ConflictException } from '@nestjs/common';
import { IMPORT_KINDS, type ImportKind, type ImportResultDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { canAccessBranch } from '../auth/branch-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { type ImportRequest, importRecordIds, importRequestRange } from './request-ids.js';

/**
 * Idempotent commit of an import. The records of a request get ids derived from its requestId
 * and fingerprint (request-ids.ts) and are all written in one transaction, so either all of them
 * exist or none. A retry of the same request finds them and answers with what the first attempt
 * wrote; the same requestId with another kind, user or file finds records it did not write in
 * the requestId's id range, and is refused (409).
 */

type RecordsInRange = (
  client: Prisma.TransactionClient,
  range: { from: string; to: string },
  take?: number,
) => Promise<{ id: string; branchId: string }[]>;

/**
 * Where each kind of import writes. The lookup is by primary key range only: it reads which ids
 * an import created, never the records' content.
 */
const IMPORTED_RECORDS: Record<ImportKind, RecordsInRange> = {
  customers: (client, { from, to }, take) =>
    client.customer.findMany({
      where: { id: { gte: from, lte: to } },
      select: { id: true, branchId: true },
      take,
    }),
  rates: (client, { from, to }, take) =>
    client.rateCard.findMany({
      where: { id: { gte: from, lte: to } },
      select: { id: true, branchId: true },
      take,
    }),
};

/** Transaction options of a bulk import: thousands of rows take longer than the 5 s default. */
export const IMPORT_TRANSACTION = { maxWait: 10_000, timeout: 120_000 };

const reused = () => new ConflictException('This request id was already used for another import');

/** The result of an earlier commit of this request, or null when the requestId is unused. */
export async function previousImport(
  client: Prisma.TransactionClient,
  user: AuthUser,
  request: ImportRequest,
): Promise<ImportResultDto | null> {
  const range = importRequestRange(request.requestId);
  const found = await IMPORTED_RECORDS[request.kind](client, range);
  if (found.length > 0) {
    // Everything under one requestId was written by one commit: rows 0..n-1 of one request.
    const ids = importRecordIds(request, found.length);
    const present = new Set(found.map((r) => r.id));
    const same = ids.every((id) => present.has(id));
    if (!same || found.some((r) => !canAccessBranch(user, r.branchId))) throw reused();
    const { kind, requestId } = request;
    return { kind, requestId, created: ids.length, replayed: true, ids };
  }
  for (const kind of IMPORT_KINDS) {
    if (kind === request.kind) continue;
    if ((await IMPORTED_RECORDS[kind](client, range, 1)).length > 0) throw reused();
  }
  return null;
}

const lockKey = (key: string) => `import:${key}`;

/** Serializes commits of one request id (of any kind) until the transaction ends. */
export async function lockImportRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(requestId)}, 0))`;
}

/**
 * Serializes imports of one kind into the same branches until the transaction ends, so the
 * duplicate check re-run under these locks sees every earlier import. Branches are locked in a
 * fixed order: two files naming the same branches cannot deadlock.
 */
export async function lockImportBranches(
  tx: Prisma.TransactionClient,
  kind: ImportKind,
  branchIds: Iterable<string>,
): Promise<void> {
  for (const branchId of [...new Set(branchIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(`${kind}:${branchId}`)}, 0))`;
  }
}
