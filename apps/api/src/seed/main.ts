import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { normalizeEmail } from '../auth/email.js';
import { hashPassword } from '../auth/password.js';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { seedDemoCommercial } from './demo-commercial.js';
import { DEMO_BRANCHES } from './demo-data.js';

/**
 * Loads demo data into a staging or local database. Idempotent: safe to run on every deploy.
 * Refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true (staging sets it).
 */
async function seed(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'Refusing to load demo data: NODE_ENV=production and ALLOW_DEMO_SEED is not "true".',
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    await prisma.$transaction(
      DEMO_BRANCHES.map(({ code, ...fields }) =>
        prisma.branch.upsert({ where: { code }, create: { code, ...fields }, update: fields }),
      ),
    );
    console.log(`Seeded ${DEMO_BRANCHES.length} branches.`);

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

    await seedDemoCommercial(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

await seed();
