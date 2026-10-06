import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AGENT_SERVER_PATHS } from './agent-auth/agent-auth.paths.js';
import { originCheck } from './auth/origin-check.js';
import type { AppEnv } from './config/env.js';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and the integration tests so both run the same HTTP setup. */
export function configureApp(app: INestApplication, env: AppEnv): void {
  // Exact hop count, never `true`: X-Forwarded-For is trusted only through our own proxies, so
  // req.ip is the real client and a forged header cannot pick its own IP (plan S1).
  (app as NestExpressApplication).set('trust proxy', env.TRUST_PROXY_HOPS);
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  // CSRF: unsafe methods only from allowed origins (plan S2).
  app.use(
    originCheck(
      env.CORS_ORIGINS,
      AGENT_SERVER_PATHS.map((path) => `/${API_PREFIX}/${path}`),
    ),
  );
  app.enableShutdownHooks();
}
