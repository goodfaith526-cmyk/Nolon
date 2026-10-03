import type { INestApplication } from '@nestjs/common';
import type { AppEnv } from './config/env.js';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and the integration tests so both run the same HTTP setup. */
export function configureApp(app: INestApplication, env: AppEnv): void {
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();
}
