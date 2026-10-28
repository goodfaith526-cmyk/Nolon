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
  /**
   * Public address of the web app, used in tracking links and QR codes. Empty: the first
   * CORS origin (the web app's own address in every deployment so far).
   */
  PUBLIC_WEB_URL: emptyAsUnset(z.string().url().optional()),
  /**
   * Where staff open the AI assistant (the platform's staff screen, e.g.
   * https://pilot.example.com/?tenant=nolon). Empty: no assistant button. HTTPS only, except
   * localhost for development.
   */
  AGENT_ASSISTANT_URL: emptyAsUnset(
    z
      .string()
      .url()
      .refine(
        (value) => {
          // Runs even when .url() already failed: a value that is not a URL is just rejected.
          if (!URL.canParse(value)) return false;
          const url = new URL(value);
          return (
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
          );
        },
        { message: 'must be an https URL (http only for localhost)' },
      )
      .optional(),
  ),
  /**
   * `true`: the assistant opens as a panel inside NOLON's pages (a frame of AGENT_ASSISTANT_URL)
   * instead of a new tab. Only once the assistant allows this NOLON address to frame it (its
   * TENANT_ORIGINS hostOrigin) and shares its site, or the panel stays blank. Ignored without
   * AGENT_ASSISTANT_URL.
   */
  AGENT_ASSISTANT_PANEL: emptyAsUnset(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  ),
  /**
   * `true`: the Outlet Staff role may be assigned on the users screen and API (business model plan
   * 4.2). Off until the owner opens it; the role and its isolation are built and tested either way.
   */
  OUTLET_STAFF_ASSIGNABLE: emptyAsUnset(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  ),
  /** Absolute lifetime of a sign-in session. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  /** Lifetime of a delegated token of the staff AI assistant (agent-auth). */
  AGENT_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(10).default(10),
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
  /**
   * Days a new quotation is offered as valid for: the form's valid-until starts at the branch's
   * today plus this (GET /quotations/defaults). A suggestion only; the person may change it.
   */
  QUOTATION_VALIDITY_DAYS: emptyAsUnset(z.coerce.number().int().min(1).max(365).default(30)),
  /** Hours between runs of the draft retention purge (drafts/draft-retention.service.ts); 0 = off. */
  DRAFT_PURGE_EVERY_HOURS: z.coerce.number().int().min(0).max(168).default(6),
  /** Seed only: the first Administrator, created if missing. Never committed. Empty = unset. */
  SEED_ADMIN_EMAIL: emptyAsUnset(z.string().email().optional()),
  SEED_ADMIN_PASSWORD: emptyAsUnset(z.string().min(12).max(200).optional()),
  /** Seed only: fail when no active Administrator exists after seeding (staging sets it). */
  SEED_REQUIRE_ADMIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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
