import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Role } from '@nolon/shared';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * The access_state locks of plan 03, section 5.4. A write transaction of a signed-in request
 * takes FOR SHARE first (PrismaService does it for every interactive transaction); a change of
 * who may do what takes FOR UPDATE first (PrismaService.changeAccess). Either refuses to run when
 * the version moved since the request's access was computed.
 */

type Raw = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export class AccessChangedException extends ConflictException {
  constructor() {
    super('Permissions changed while this request ran. Reload and try again.');
  }
}

async function lockVersion(tx: Raw, mode: 'share' | 'update'): Promise<string> {
  const rows =
    mode === 'share'
      ? await tx.$queryRaw<{ version: bigint }[]>`
          SELECT "version" FROM "access_state" WHERE "id" = 1 FOR SHARE`
      : await tx.$queryRaw<{ version: bigint }[]>`
          SELECT "version" FROM "access_state" WHERE "id" = 1 FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new Error('access_state has no row');
  return row.version.toString();
}

/** First lock of a write transaction: the request's access is still the current one. */
export async function lockAccessShared(tx: Raw, expectedVersion: string): Promise<void> {
  if ((await lockVersion(tx, 'share')) !== expectedVersion) throw new AccessChangedException();
}

/** First lock of an access change, taken exclusive at once (no SHARE then UPDATE upgrade). */
export async function lockAccessForChange(tx: Raw, expectedVersion: string): Promise<void> {
  if ((await lockVersion(tx, 'update')) !== expectedVersion) throw new AccessChangedException();
}

/** Last step of an access change, in the same transaction. */
export async function bumpAccessVersion(tx: Raw): Promise<void> {
  await tx.$executeRaw`UPDATE "access_state" SET "version" = "version" + 1 WHERE "id" = 1`;
}

/**
 * Under the access_state FOR UPDATE lock: the person making the change is still active and still
 * holds a role that may make it (`allowed`), read from the database now, not from their request.
 */
export async function requireActorInTx(
  tx: Raw,
  actorId: string,
  allowed: (roles: readonly Role[]) => boolean,
): Promise<void> {
  const rows = await tx.$queryRaw<{ active: boolean; role: Role | null }[]>`
    SELECT u."is_active" AS "active", r."role"::text AS "role"
    FROM "users" u LEFT JOIN "user_roles" r ON r."user_id" = u."id"
    WHERE u."id" = ${actorId}::uuid`;
  const roles = rows.flatMap((r) => (r.role ? [r.role] : []));
  if (!rows[0]?.active || !allowed(roles)) {
    throw new ForbiddenException('You may no longer make this change');
  }
}
