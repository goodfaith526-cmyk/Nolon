import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { seedBase } from './base.js';
import { seedDemoAccounting } from './demo-accounting.js';
import { seedDemoCommercial } from './demo-commercial.js';

/**
 * Loads demo data into a staging or local database, on top of the base seed. Idempotent: safe to
 * run on every deploy. Refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true
 * (staging sets it; production never does and runs base-main.ts instead).
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
    await seedBase(prisma, env);
    await seedDemoCommercial(prisma);
    await seedDemoAccounting(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

await seed();
