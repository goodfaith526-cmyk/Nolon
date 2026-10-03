import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Controller, Get, type INestApplication, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Role } from '@nolon/shared';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { AuthUser } from '../src/auth/auth-user.js';
import { assertBranchAccess } from '../src/auth/branch-scope.js';
import { CurrentUser, RequirePermission } from '../src/auth/decorators.js';
import { hashPassword } from '../src/auth/password.js';
import { APP_ENV, type AppEnv, loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DEMO_BRANCHES } from '../src/seed/demo-data.js';

export const APP_ORIGIN = 'http://app.test';
export const PASSWORD = 'integration-test-password';

/** Test-only routes that exercise the guards the way business modules will. */
@Controller('test-auth')
class ProbeController {
  @Get('protected')
  protectedRoute(@CurrentUser() user: AuthUser): { userId: string } {
    return { userId: user.id };
  }

  @Get('customers')
  @RequirePermission('customers:view')
  listCustomers(): { ok: true } {
    return { ok: true };
  }

  @Post('customers')
  @RequirePermission('customers:create')
  createCustomer(): { ok: true } {
    return { ok: true };
  }

  @Get('branches/:branchId/customers')
  @RequirePermission('customers:view')
  branchCustomers(
    @CurrentUser() user: AuthUser,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): { branchId: string } {
    assertBranchAccess(user, branchId);
    return { branchId };
  }
}

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Partial<AppEnv> = {}): Promise<TestApp> {
  const env: AppEnv = { ...loadEnv(), CORS_ORIGINS: [APP_ORIGIN], ...overrides };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  })
    .overrideProvider(APP_ENV)
    .useValue(env)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app, env);
  await app.init();
  const prisma = app.get(PrismaService);
  for (const { code, ...fields } of DEMO_BRANCHES) {
    await prisma.branch.upsert({ where: { code }, create: { code, ...fields }, update: {} });
  }
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export async function branchId(prisma: PrismaService, code: string): Promise<string> {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code } });
  return branch.id;
}

/** Creates an active user with the given roles and branch codes; returns id and email. */
export async function createUser(
  prisma: PrismaService,
  roles: Role[],
  branchCodes: string[] = [],
): Promise<{ id: string; email: string }> {
  const email = `it-${randomUUID()}@nolon.test`;
  const branchIds = await Promise.all(branchCodes.map((code) => branchId(prisma, code)));
  const user = await prisma.user.create({
    data: {
      email,
      fullName: 'Integration Test',
      passwordHash: await hashPassword(PASSWORD),
      roles: { create: roles.map((role) => ({ role })) },
      branches: { create: branchIds.map((id) => ({ branchId: id })) },
    },
  });
  return { id: user.id, email };
}

export async function deleteTestUsers(prisma: PrismaService): Promise<void> {
  await prisma.user.deleteMany({ where: { email: { startsWith: 'it-' } } });
}

/** Signs in from the allowed origin and returns the Cookie header value to send back. */
export async function signIn(t: TestApp, email: string, password = PASSWORD): Promise<string> {
  const res = await t
    .http()
    .post('/api/v1/auth/login')
    .set('Origin', APP_ORIGIN)
    .send({ email, password })
    .expect(204);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  const first = setCookie[0];
  if (!first) throw new Error('No session cookie');
  return first.split(';')[0] ?? '';
}
