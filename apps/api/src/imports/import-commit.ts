import { ConflictException } from '@nestjs/common';
import { IMPORT_MAX_ROWS, type ImportKind, type ImportResultDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { canAccessBranch } from '../auth/branch-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { importRecordId, importRecordIds } from './request-ids.js';

/**
 * Idempotent commit of an import. The records of request R get the ids derived from R
 * (request-ids.ts), and all are written in one transaction, so either all of them exist or none.
 * A retry therefore finds the first id and answers with what the first attempt wrote.
 */

export type ExistingRecords = (
  client: Prisma.TransactionClient,
  ids: string[],
) => Promise<{ id: string; branchId: string }[]>;

/** Transaction options of a bulk import: thousands of rows take longer than the 5 s default. */
export const IMPORT_TRANSACTION = { maxWait: 10_000, timeout: 120_000 };

/** The result of an earlier commit of this request, or null when there was none. */
export async function previousImport(
  client: Prisma.TransactionClient,
  user: AuthUser,
  kind: ImportKind,
  requestId: string,
  existing: ExistingRecords,
): Promise<ImportResultDto | null> {
  const first = await existing(client, [importRecordId(requestId, 0)]);
  if (first.length === 0) return null;
  const ids = importRecordIds(requestId, IMPORT_MAX_ROWS);
  const found = await existing(client, ids);
  if (found.some((r) => !canAccessBranch(user, r.branchId))) {
    throw new ConflictException('This request id belongs to another import');
  }
  const present = new Set(found.map((r) => r.id));
  const written = ids.filter((id) => present.has(id));
  return { kind, requestId, created: written.length, replayed: true, ids: written };
}

/** Serializes commits of one request id until the transaction ends. */
export async function lockImportRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`import:${requestId}`}, 0))`;
}
