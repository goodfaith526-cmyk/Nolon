import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import { loadEnv } from '../src/config/env.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedBase } from '../src/seed/base.js';
import { BRANCHES } from '../src/seed/branches.js';

/** The production seed: branches and the first Administrator, nothing else. */
describe('seedBase (production seed)', () => {
  let prisma: PrismaClient;
  const email = `it-seed-${randomUUID()}@nolon.test`;

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: loadEnv().DATABASE_URL }),
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  /** Row counts of what the demo seed loads; the base seed must leave all of them as they are. */
  async function demoCounts(): Promise<number[]> {
    return Promise.all([
      prisma.customer.count(),
      prisma.quotation.count(),
      prisma.booking.count(),
      prisma.fxRate.count(),
      prisma.account.count(),
      prisma.systemSetting.count({ where: { key: { startsWith: 'demo.' } } }),
    ]);
  }

  it('creates the five branches and the first Administrator, and no demo data', async () => {
    const before = await demoCounts();

    await seedBase(prisma, {
      SEED_ADMIN_EMAIL: email.toUpperCase(),
      SEED_ADMIN_PASSWORD: 'first-password-123',
      SEED_REQUIRE_ADMIN: true,
    });

    const branches = await prisma.branch.findMany({
      where: { code: { in: BRANCHES.map((b) => b.code) } },
    });
    expect(branches).toHaveLength(BRANCHES.length);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { roles: true },
    });
    expect(admin.isActive).toBe(true);
    expect(admin.roles.map((r) => r.role)).toEqual(['ADMINISTRATOR']);
    expect(await verifyPassword('first-password-123', admin.passwordHash)).toBe(true);
    expect(await demoCounts()).toEqual(before);
  });

  it('never changes an existing Administrator or their password', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email } });

    await seedBase(prisma, {
      SEED_ADMIN_EMAIL: email,
      SEED_ADMIN_PASSWORD: 'another-password-456',
      SEED_REQUIRE_ADMIN: true,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});
