import { normalizeEmail } from '../auth/email.js';
import { hashPassword } from '../auth/password.js';
import type { AppEnv } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BRANCHES } from './branches.js';

export type BaseSeedEnv = Pick<
  AppEnv,
  'SEED_ADMIN_EMAIL' | 'SEED_ADMIN_PASSWORD' | 'SEED_REQUIRE_ADMIN'
>;

/**
 * What every environment needs before anyone can sign in: the branches and the first
 * Administrator. No demo data. Idempotent: safe to run on every deploy. Currencies, the chart of
 * accounts and the posting map come from migrations.
 */
export async function seedBase(prisma: PrismaClient, env: BaseSeedEnv): Promise<void> {
  await prisma.$transaction(
    BRANCHES.map(({ code, ...fields }) =>
      prisma.branch.upsert({ where: { code }, create: { code, ...fields }, update: fields }),
    ),
  );
  console.log(`Seeded ${BRANCHES.length} branches.`);

  // First Administrator, from env only. Created when missing; an existing user (and their
  // password) is never changed by the seed.
  if (env.SEED_ADMIN_EMAIL && env.SEED_ADMIN_PASSWORD) {
    const email = normalizeEmail(env.SEED_ADMIN_EMAIL);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log('Seed admin already exists; left unchanged.');
    } else {
      await prisma.user.create({
        data: {
          email,
          fullName: 'Administrator',
          passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
          roles: { create: [{ role: 'ADMINISTRATOR' }] },
        },
      });
      console.log('Seed admin created.');
    }
  }

  if (env.SEED_REQUIRE_ADMIN) {
    const admins = await prisma.user.count({
      where: { isActive: true, roles: { some: { role: 'ADMINISTRATOR' } } },
    });
    if (admins === 0) {
      throw new Error(
        'No active Administrator: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (see DEPLOY.md).',
      );
    }
  }
}
