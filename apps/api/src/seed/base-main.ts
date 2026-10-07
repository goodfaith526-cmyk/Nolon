import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { seedBase } from './base.js';

/**
 * Production seed: branches and the first Administrator only (seedBase), never demo data. Runs on
 * every production deploy (deploy/production/deploy.sh).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    await seedBase(prisma, env);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
