import type { Prisma } from '../generated/prisma/client.js';

export interface LockedCredentials {
  passwordHash: string;
  isActive: boolean;
}

/**
 * Locks the user row (SELECT ... FOR UPDATE) for the rest of the transaction and returns the
 * credentials as they are now. Every write that issues a session or changes a password or the
 * active flag goes through this row lock, so a check made before the transaction can be
 * re-validated against the committed state, and concurrent credential changes are serialized.
 */
export async function lockCredentials(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<LockedCredentials | null> {
  const rows = await tx.$queryRaw<{ password_hash: string; is_active: boolean }[]>`
    SELECT password_hash, is_active FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  const row = rows[0];
  return row ? { passwordHash: row.password_hash, isActive: row.is_active } : null;
}
