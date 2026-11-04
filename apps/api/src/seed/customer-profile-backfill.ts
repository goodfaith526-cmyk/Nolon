import type { PrismaService } from '../prisma/prisma.service.js';
import { nextSequenceValue } from '../common/numbering.js';
import { identityLock } from '../customer-service/customer-identity.service.js';

/**
 * Explicit rollout job, never called by app startup/deploy or channel capture. Each existing
 * branch account gets its own profile, not a phone/name-based merge. Account/document IDs stay.
 * One bounded batch, resumable after interruption; caller must obtain owner migration approval.
 */
export async function backfillCustomerProfiles(
  prisma: PrismaService,
  companyId: string,
  apply = false,
  batchSize = 100,
) {
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(companyId) ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000
  )
    throw new Error('Explicit company and a bounded batch required');
  const accounts = await prisma.customer.findMany({
    where: { profileId: null },
    orderBy: { id: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  let linked = 0;
  if (apply)
    for (const { id } of accounts) {
      const made = await prisma.$transaction(async (tx) => {
        await identityLock(tx, `${companyId}:legacy-account:${id}`);
        await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id}::uuid FOR UPDATE`;
        const account = await tx.customer.findUniqueOrThrow({ where: { id } });
        if (account.profileId) return false;
        const profile = await tx.customerProfile.create({
          data: {
            companyId,
            number: `CP${(await nextSequenceValue(tx, 'CUSTOMER_PROFILE')).toString().padStart(6, '0')}`,
            name: account.name,
            phone: account.phone,
            address: account.address?.slice(0, 1000),
          },
        });
        await tx.customer.update({ where: { id }, data: { profileId: profile.id } });
        await tx.customerProfileReview.create({
          data: {
            companyId,
            actor: 'system_migration',
            entityId: profile.id,
            action: 'LEGACY_ACCOUNT',
            reason: 'One legacy account, one profile; no inferred channel identity',
            snapshot: { accountId: id, previousNumber: account.number },
          },
        });
        return true;
      });
      if (made) linked++;
    }
  return {
    dryRun: !apply,
    scanned: accounts.length,
    linked,
    remaining: await prisma.customer.count({ where: { profileId: null } }),
  };
}
