import 'dotenv/config';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_ENV, type AppEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('API against a real database', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get<AppEnv>(APP_ENV));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health reports the database up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('has the initial migration applied', async () => {
    const prisma = app.get(PrismaService);
    await prisma.systemSetting.upsert({
      where: { key: 'integration-test' },
      create: { key: 'integration-test', value: { ok: true } },
      update: { value: { ok: true } },
    });
    const row = await prisma.systemSetting.findUnique({ where: { key: 'integration-test' } });
    expect(row?.value).toEqual({ ok: true });
    await prisma.systemSetting.delete({ where: { key: 'integration-test' } });
  });
});
