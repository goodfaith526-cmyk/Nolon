import { z } from 'zod';

/** Compose passes `${VAR:-}` as an empty string; treat that as not set. */
function emptyAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /** Absolute lifetime of a sign-in session. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  /**
   * Exact number of reverse proxies in front of the API (Express `trust proxy`). The client IP is
   * taken from X-Forwarded-For only through these hops. 0 ignores the header.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Per-IP failed sign-in limit. Off only while the proxies cannot pass the real client IP. */
  LOGIN_IP_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Seed only: the first Administrator, created if missing. Never committed. Empty = unset. */
  SEED_ADMIN_EMAIL: emptyAsUnset(z.string().email().optional()),
  SEED_ADMIN_PASSWORD: emptyAsUnset(z.string().min(12).max(200).optional()),
});

export type AppEnv = z.infer<typeof envSchema>;

export const APP_ENV = Symbol('APP_ENV');

/** Parses process.env once at startup and fails fast with a readable message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
