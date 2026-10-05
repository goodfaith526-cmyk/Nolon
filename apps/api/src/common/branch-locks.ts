import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** Each id once, in a fixed order: two callers locking the same branches cannot deadlock. */
const inOrder = (branchIds: Iterable<string>) => [...new Set(branchIds)].sort();

/**
 * Locks the branch rows FOR SHARE until the transaction ends and returns the ids of those still
 * active. FOR SHARE conflicts with any UPDATE of a branch row (deactivating it included), so a
 * branch found active here stays active until the caller commits; a deactivation committed
 * first is seen here, because the locking read returns the row's latest committed version.
 * Several writers into one branch hold the lock at the same time.
 */
export async function lockActiveBranches(
  tx: Tx,
  branchIds: Iterable<string>,
): Promise<Set<string>> {
  const active = new Set<string>();
  for (const id of inOrder(branchIds)) {
    const rows = await tx.$queryRaw<{ is_active: boolean }[]>`
      SELECT "is_active" FROM "branches" WHERE "id" = ${id}::uuid FOR SHARE`;
    if (rows[0]?.is_active) active.add(id);
  }
  return active;
}

/**
 * Serializes, until the transaction ends, every write that checks a per-branch uniqueness rule
 * (`rule`, e.g. customer phones): whoever holds the lock sees every earlier write of the rule in
 * those branches before checking it. Create, update and Excel import of the record all take it.
 */
export async function lockBranchRule(
  tx: Tx,
  rule: string,
  branchIds: Iterable<string>,
): Promise<void> {
  for (const id of inOrder(branchIds)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`unique:${rule}:${id}`}, 0))`;
  }
}
