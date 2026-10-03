import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
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
  } finally {
    await prisma.$disconnect();
  }
}

await seed();
